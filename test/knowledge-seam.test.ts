import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createKnowledgeProvider, prepareKit } from "../src/kit/index.js";

describe("the knowledge provider seam", () => {
  const provider = {
    id: "brand-corpus",
    async search(request: { query: string; limit: number; kinds?: readonly string[] }, scope: { tenant: string; viewer?: string }) {
      return [{ id: `${scope.tenant}:1`, kind: "memory", title: `about ${request.query}`, snippet: `viewer ${scope.viewer ?? "none"}` }];
    },
  };
  const context = { principal: { id: "p" }, scope: {} } as never;

  test("serves knowledge.search in the host's scope, never one the session names", async () => {
    const capabilities = createKnowledgeProvider({ provider, scope: { tenant: "brand-a", viewer: "dana" } });
    const listed = await capabilities.list(context);
    assert.deepEqual(listed.map((descriptor) => descriptor.name), ["knowledge.search"]);
    const out = (await capabilities.invoke("knowledge.search", { query: "returns", tenant: "brand-b" }, context)) as { output: { hits: { id: string; snippet: string }[] } };
    assert.equal(out.output.hits[0]!.id, "brand-a:1", "an input field naming another tenant changes nothing");
    assert.match(out.output.hits[0]!.snippet, /viewer dana/);
    assert.match(out.output.hits[0]!.snippet, /untrusted/, "results are wrapped as untrusted data");
    const schema = (listed[0] as unknown as { inputSchema: { additionalProperties: boolean; properties: object } }).inputSchema;
    assert.equal(schema.additionalProperties, false);
    assert.equal("tenant" in schema.properties, false);
  });

  test("the kit takes it as the part `knowledge`, and refuses it beside the Brain", () => {
    const prepared = prepareKit({ kit: { parts: ["knowledge"], knowledge: { provider, scope: { tenant: "brand-a" } } }, sessions: {} as never, workspacePath: "/w" });
    assert.equal(prepared.providerSources.length, 1);
    assert.equal(prepared.extensions.length, 0, "no Brain package is installed");
    assert.throws(() => prepareKit({ kit: { parts: ["knowledge", "brain"], knowledge: { provider, scope: { tenant: "a" } } }, sessions: {} as never, workspacePath: "/w" }), /choose one/);
    assert.throws(() => prepareKit({ kit: { parts: ["knowledge"] }, sessions: {} as never, workspacePath: "/w" }), /needs kit.knowledge/);
  });
});
