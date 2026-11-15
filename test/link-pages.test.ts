import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { LinkClient, LinkError } from "../src/link/client.js";
import { PageStore, writePage, type PageManifest } from "../src/link/pages.js";
import { startLinkServer } from "../src/link/server.js";
import { FileSessionStore } from "../src/session-store.js";

const TOKEN = "test-token-0123456789abcdef";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

/** A finished run whose Page Studio folder holds the base page it started from and the page it made. */
function pageRun() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "link-pages-"));
  const store = new FileSessionStore(path.join(root, "state", "sessions"), { runId: "run-7", host: { id: "e2b-7", kind: "e2b" } });
  const plan = store.create({ title: "Page Studio · plan", runtime: "claude", native: { kind: "claude", cwd: "/sandbox/ws" } });
  store.update(plan.id, { state: "idle" });
  const runAt = Date.parse(store.get(plan.id)!.createdAt);
  const data = path.join(root, "data");
  const pictures = path.join(data, "library", "1617", "pictures");
  fs.mkdirSync(pictures, { recursive: true });
  fs.mkdirSync(path.join(data, "pages"));
  fs.writeFileSync(path.join(pictures, "A01-jar.png"), PNG);
  fs.writeFileSync(path.join(pictures, "A02-face.jpg"), JPG);
  fs.writeFileSync(path.join(pictures, "A03-other.png"), PNG);
  fs.writeFileSync(path.join(data, "library", "1617", "brand.json"), JSON.stringify({
    brand: "1617", facts: "- C1: 90-day guarantee", designPlan: "- P1 green",
    pictures: [
      { key: "A01", url: "https://pagestudio.library/1617/A01-jar.png", shows: "the jar" },
      { key: "A02", url: "https://pagestudio.library/1617/A02-face.jpg", shows: "a face" },
      { key: "A03", url: "https://pagestudio.library/1617/A03-other.png", shows: "another" },
    ],
  }));
  const page = (id: string, title: string, updatedAt: string, src: string) =>
    fs.writeFileSync(path.join(data, "pages", `${id}.json`), JSON.stringify({
      id, title, brand: { id: "1617", name: "RAWDOG" }, product: null, source: "made in Page Studio",
      sections: [{ key: "design-tokens", label: "Tokens", shell: true, src: "<style></style>" }, { key: "hero", label: "Hero", src }, { key: "faq", label: "FAQ", src: "<section>FAQ</section>" }],
      tokens: {}, notes: [{ uid: "n1", status: "open" }], version: 13, updatedAt, updatedBy: "agent",
    }));
  page("rawdog--base", "RAWDOG · base", new Date(runAt - 86_400_000).toISOString(), '<img src="https://pagestudio.library/1617/A03-other.png">');
  page("rawdog--headless-quick-6dqua", "RAWDOG · Awake On Camera", new Date(runAt + 90_000).toISOString(),
    '<style>.hero{background:url(https://pagestudio.library/1617/A01-jar.png)}</style><img src="https://pagestudio.library/1617/A02-face.jpg"><img src="https://pagestudio.library/1617/A09-gone.png"><img src="https://cdn.shopify.com/x.png">');
  return { root, store, data };
}

test("a host serves the pages its runs made, each with the pictures it shows, and they land as a Page Studio folder", async () => {
  const run = pageRun();
  const server = await startLinkServer({ token: TOKEN, sessionsRoot: run.store.root, host: { id: "e2b-7", kind: "e2b" }, pageStudioDir: run.data });
  const client = new LinkClient({ url: server.url, token: TOKEN });
  try {
    assert.equal((await client.info()).pages, true);
    const all = (await client.pages()).pages;
    assert.deepEqual(all.map((page: any) => [page.id, page.runId]), [["rawdog--headless-quick-6dqua", "run-7"], ["rawdog--base", null]]);
    const made = all[0];
    assert.deepEqual(made.labels, ["Hero", "FAQ"]);
    assert.deepEqual(made.pictures, { library: 2, missing: 1 });
    assert.equal(made.notesOpen, 1);
    assert.deepEqual((await client.pages("run-7")).pages.map((page: any) => page.id), ["rawdog--headless-quick-6dqua"]);

    const manifest = (await client.page(made.id)) as PageManifest;
    assert.equal(manifest.format, "page-studio-page");
    assert.deepEqual(manifest.pictures.map((picture) => [picture.name, picture.bytes, picture.record?.key]), [["A01-jar.png", PNG.length, "A01"], ["A02-face.jpg", JPG.length, "A02"]]);
    assert.deepEqual(manifest.missing, ["https://pagestudio.library/1617/A09-gone.png"]);
    assert.match(String(manifest.brands["1617"]?.facts), /90-day/);
    assert.equal(manifest.brands["1617"]?.pictures, undefined);

    assert.deepEqual(await client.pagePicture(made.id, "1617", "A01-jar.png"), PNG);
    // Only pictures the page shows, never another file of the library or anything outside it.
    for (const [brand, name] of [["1617", "A03-other.png"], ["1617", "..%2F..%2Fbrand.json"], ["..", "A01-jar.png"]] as const) {
      await assert.rejects(client.pagePicture(made.id, brand, name), (error: unknown) => error instanceof LinkError && error.status === 404);
    }
    await assert.rejects(client.page("nope"), (error: unknown) => error instanceof LinkError && error.status === 404);
    await assert.rejects(new LinkClient({ url: server.url, token: "wrong-token-0123456789" }).pages(), (error: unknown) => error instanceof LinkError && error.status === 401);

    const target = fs.mkdtempSync(path.join(os.tmpdir(), "pulled-"));
    let fetched = 0;
    const written = await writePage(target, manifest, (picture) => {
      fetched += 1;
      return client.pagePicture(made.id, picture.brand, picture.name);
    });
    assert.deepEqual([written.pageId, written.pictures, fetched], [made.id, 2, 2]);
    assert.deepEqual(fs.readFileSync(path.join(target, "library", "1617", "pictures", "A02-face.jpg")), JPG);
    const brand = JSON.parse(fs.readFileSync(path.join(target, "library", "1617", "brand.json"), "utf8"));
    assert.deepEqual(brand.pictures.map((picture: any) => picture.key), ["A01", "A02"]);
    assert.match(brand.facts, /90-day/);
    const local = new PageStore(target);
    assert.equal(local.page(made.id)?.title, "RAWDOG · Awake On Camera");
    assert.deepEqual(local.list()[0]?.pictures, { library: 2, missing: 1 });

    // Pulling again fetches nothing that is already there; a damaged picture is refused.
    await writePage(target, manifest, async () => assert.fail("nothing to fetch"));
    fs.rmSync(path.join(target, "library", "1617", "pictures", "A01-jar.png"));
    await assert.rejects(writePage(target, manifest, async () => Buffer.from("not the jar")), /damaged/);
  } finally {
    await server.close();
  }
});

test("a host without a Page Studio folder answers with no pages", async () => {
  const run = pageRun();
  const server = await startLinkServer({ token: TOKEN, sessionsRoot: run.store.root, host: { id: "x", kind: "local" } });
  const client = new LinkClient({ url: server.url, token: TOKEN });
  try {
    assert.equal((await client.info()).pages, false);
    assert.deepEqual(await client.pages(), { pageStudio: false, pages: [] });
    await assert.rejects(client.page("rawdog--base"), (error: unknown) => error instanceof LinkError && error.code === "no-pages");
  } finally {
    await server.close();
  }
});
