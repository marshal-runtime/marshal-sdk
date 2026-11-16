import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { configuredReview, notesOf, reviewRunId, syncReviewComments } from "../src/review";

/** Their api-gateway's comment routes, as far as the review panel uses them, behind a bearer token. */
async function fakeReviewApi(token: string) {
  const rows = new Map<number, { runId: number; body: any }>();
  const calls: string[] = [];
  let next = 100;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      calls.push(`${req.method} ${req.url}`);
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end('{"detail":"unauthorized"}');
        return;
      }
      if (req.method === "POST" && req.url === "/api/store_manager/page_editor/comments") {
        const body = JSON.parse(raw);
        const id = next++;
        rows.set(id, { runId: body.runId, body });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ response: { id } }));
        return;
      }
      const del = /^\/api\/store_manager\/page_editor\/comments\/(\d+)$/.exec(req.url ?? "");
      if (req.method === "DELETE" && del) {
        const found = rows.delete(Number(del[1]));
        res.writeHead(found ? 200 : 404).end(found ? "{}" : '{"detail":"not found"}');
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, rows, calls, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("review run id comes from the page generator's output path, else run.json", () => {
  assert.equal(reviewRunId("gs://shop-builder-local-runs/page-generation-runs/900004/output"), 900004);
  assert.equal(reviewRunId("gs://b/runs/demo-1", { runId: "900010" }), 900010);
  assert.equal(reviewRunId("gs://b/runs/demo-1", { runId: "6ca64536-1b35" }), null);
  assert.equal(configuredReview({ review: { url: "ftp://x" } }), null);
  assert.deepEqual(configuredReview({ review: { url: "http://127.0.0.1:8080/", tokenFile: "~/t" } }), { url: "http://127.0.0.1:8080", tokenFile: "~/t" });
});

test("notes become review comments once, pinned to their section; resolved ones are removed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-review-"));
  const tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, "dev-token\n");
  const api = await fakeReviewApi("dev-token");
  const config = { url: api.url, tokenFile };
  const doc = {
    notes: [
      { key: "hero", body: "@Bar keep or revert?", author: "Omer's Marshal", uid: "n1", createdAt: "2026-11-16T00:09:25.136Z", status: "open" },
      { body: "Whole page: check the price", uid: "n2", status: "open" },
      { key: "faq", body: "already handled", uid: "n3", status: "resolved" },
      { key: "faq", body: "no uid, not sent" },
    ],
  };
  const first = await syncReviewComments(config, 900004, notesOf(doc), {});
  assert.equal(first.added, 2);
  assert.equal(first.removed, 0);
  const hero = api.rows.get(first.comments.n1!)!.body;
  assert.equal(hero.runId, 900004);
  assert.equal(hero.sectionComment.selector, '[data-zyg-section="hero"]');
  assert.equal(hero.sectionComment.category, "general");
  assert.equal(hero.sectionComment.timestamp, "2026-11-16T00:09:25.136Z");
  assert.match(hero.sectionComment.text, /^@Bar keep or revert\?\n\(Omer's Marshal, from Marshal Page Studio\)$/);
  assert.equal(api.rows.get(first.comments.n2!)!.body.generalComment.text, "Whole page: check the price\n(from Marshal Page Studio)");

  // Pushing again adds nothing; resolving a note removes its comment there.
  const again = await syncReviewComments(config, 900004, notesOf(doc), first.comments);
  assert.equal(again.added, 0);
  assert.equal(api.rows.size, 2);
  doc.notes[0]!.status = "resolved";
  const after = await syncReviewComments(config, 900004, notesOf(doc), again.comments);
  assert.equal(after.removed, 1);
  assert.deepEqual(Object.keys(after.comments), ["n2"]);
  assert.equal(api.rows.size, 1);

  // A comment someone already deleted in their UI is fine; a wrong token is an error the push turns into a warning.
  api.rows.clear();
  doc.notes[1]!.status = "resolved";
  assert.equal((await syncReviewComments(config, 900004, notesOf(doc), after.comments)).removed, 1);
  fs.writeFileSync(tokenFile, "wrong");
  doc.notes[0]!.status = "open";
  await assert.rejects(syncReviewComments(config, 900004, notesOf(doc), {}), /HTTP 401/);
  await api.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
