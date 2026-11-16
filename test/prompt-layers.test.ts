import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { agentLaunchFields, profileFingerprint, readExtensionAgents, resolveAgent } from "../src/agent-entries.js";
import { composePromptLayers, readExtensionPromptLayers, resolvePromptLayers } from "../src/prompt-layers.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-layers-"));

function pack(name: string, manifest: Record<string, unknown>, files: Record<string, string>): string {
  const dir = path.join(root, name + Math.random().toString(36).slice(2, 7));
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  fs.writeFileSync(path.join(dir, "runtime-extension.json"), JSON.stringify({ schemaVersion: 1, version: "1.0.0", entrypoint: "x.cjs", moduleFormat: "commonjs-bundle-v1", ...manifest }));
  return dir;
}

const persona = (soul = "I am Marley.") =>
  pack("persona", { identity: "@marley/persona", contributes: { promptLayers: [{ id: "soul", file: "layers/soul.md" }, { id: "core", file: "layers/core.md" }] } }, { "layers/soul.md": soul, "layers/core.md": "Shared rules." });

const agent = (layers: string[] | undefined, extra: Record<string, unknown> = {}, prompt: string | null = "profiles/own.md") =>
  pack("agent", {
    identity: "@marley/front",
    contributes: { agents: [{ id: "front", profile: { ...(prompt ? { prompt } : {}), ...(layers ? { layers } : {}), ...extra }, outputs: [], ports: [] }] },
  }, { "profiles/own.md": "My own role." });

test("a profile composes the layers in the order it lists them, then its own prompt", () => {
  const personaRoot = persona();
  const agentRoot = agent(["@marley/persona#core", "@marley/persona#soul"], { extensions: ["@marley/persona"] });
  const resolved = resolveAgent(agentRoot, "front", {}, { "@marley/persona": personaRoot });
  assert.equal(resolved.profile.prompt, "Shared rules.\n\nI am Marley.\n\nMy own role.");
  assert.deepEqual(resolved.profile.layers?.map((layer) => layer.ref), ["@marley/persona#core", "@marley/persona#soul"]);
  assert.equal(agentLaunchFields(resolved).systemPrompt, resolved.profile.prompt);
});

test("a profile may be layers only", () => {
  const resolved = resolveAgent(agent(["@marley/persona#soul"], { extensions: ["@marley/persona"] }, null), "front", {}, (id) => (id === "@marley/persona" ? persona() : undefined));
  assert.equal(resolved.profile.prompt, "I am Marley.");
});

test("the fingerprint names the layers: a changed word in a layer changes it, and a profile without layers keeps its old value", () => {
  const sources = (soul: string) => ({ "@marley/persona": persona(soul) });
  const agentRoot = agent(["@marley/persona#soul"], { extensions: ["@marley/persona"] });
  const a = resolveAgent(agentRoot, "front", {}, sources("I am Marley."));
  const b = resolveAgent(agentRoot, "front", {}, sources("I am Marley!"));
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.equal(a.fingerprint, resolveAgent(agentRoot, "front", {}, sources("I am Marley.")).fingerprint);
  const plain = resolveAgent(agent(undefined), "front");
  const { layers: _none, ...rest } = plain.profile;
  assert.equal(plain.fingerprint, profileFingerprint(rest));
  assert.equal(JSON.stringify(plain.profile).includes("layers"), false);
});

test("a layer must come from an extension in the profile's scope, and be installed and declared", () => {
  const personaRoot = persona();
  assert.throws(() => resolveAgent(agent(["@marley/persona#soul"]), "front", {}, { "@marley/persona": personaRoot }), /not in scope/);
  assert.throws(() => resolveAgent(agent(["@marley/persona#soul"], { extensions: ["@marley/persona"] }), "front", {}, {}), /not installed/);
  assert.throws(() => resolveAgent(agent(["@marley/persona#nope"], { extensions: ["@marley/persona"] }), "front", {}, { "@marley/persona": personaRoot }), /no prompt layer "nope"/);
  assert.throws(() => resolveAgent(agent(["@marley/persona#soul"], { extensions: ["@marley/persona"] }), "front", {}, { "@marley/persona": agent(undefined) }), /is @marley\/front/);
});

test("a profile's own package can contribute its layers", () => {
  const own = pack("self", {
    identity: "@marley/self",
    contributes: { promptLayers: [{ id: "role", file: "role.md" }], agents: [{ id: "a", profile: { layers: ["@marley/self#role"] }, outputs: [], ports: [] }] },
  }, { "role.md": "Own layer." });
  assert.equal(resolveAgent(own, "a").profile.prompt, "Own layer.");
});

test("manifests are validated: no prompt and no layers, bad names, escaping files, repeats, links out", () => {
  assert.throws(() => readExtensionAgents(agent(undefined, {}, null)), /needs a prompt file or prompt layers/);
  assert.throws(() => readExtensionAgents(agent(["not a ref"])), /not a valid name|not a prompt layer name/);
  const bad = (layers: unknown) => pack("bad", { identity: "@marley/bad", contributes: { promptLayers: layers } }, {});
  assert.throws(() => readExtensionPromptLayers(bad([{ id: "x", file: "../x.md" }])), /portable path/);
  assert.throws(() => readExtensionPromptLayers(bad([{ id: "x", file: "a.md" }, { id: "x", file: "b.md" }])), /repeats/);
  assert.throws(() => readExtensionPromptLayers(bad({ id: "x" })), /must be a list/);
  const linked = pack("link", { identity: "@marley/link", contributes: { promptLayers: [{ id: "x", file: "x.md" }] } }, {});
  fs.writeFileSync(path.join(root, "outside.md"), "secret");
  fs.symlinkSync(path.join(root, "outside.md"), path.join(linked, "x.md"));
  assert.throws(() => resolvePromptLayers(["@marley/link#x"], { "@marley/link": linked }), /leaves the package/);
  assert.throws(() => resolvePromptLayers(["@marley/persona#soul", "@marley/persona#soul"], { "@marley/persona": persona() }), /repeats/);
});

test("a host launch composes layers directly and adds its own text after them", () => {
  const layers = resolvePromptLayers(["@marley/persona#soul", "@marley/persona#core"], { "@marley/persona": persona() });
  assert.equal(composePromptLayers(layers, "Per-turn host text."), "I am Marley.\n\nShared rules.\n\nPer-turn host text.");
  assert.equal(layers[0]!.version, "1.0.0");
});

test("layerVars fill {{name}} in the layers in one pass; unknown names, values and the profile's own prompt stay as written", () => {
  const personaRoot = pack("vars", { identity: "@marley/vars", contributes: { promptLayers: [{ id: "a", file: "a.md" }] } }, { "a.md": "Hi {{agent}}, {{agent}} {{missing}} {{nested}}" });
  const agentRoot = pack("varsagent", {
    identity: "@marley/varsagent",
    contributes: { agents: [{ id: "x", profile: { prompt: "own.md", layers: ["@marley/vars#a"], layerVars: { agent: "Marley", nested: "{{agent}}" }, extensions: ["@marley/vars"] }, outputs: [], ports: [] }] },
  }, { "own.md": "own {{agent}}" });
  const resolved = resolveAgent(agentRoot, "x", {}, { "@marley/vars": personaRoot });
  assert.equal(resolved.profile.prompt, "Hi Marley, Marley {{missing}} {{agent}}\n\nown {{agent}}");
  const other = resolveAgent(
    pack("varsagent2", { identity: "@marley/varsagent", contributes: { agents: [{ id: "x", profile: { prompt: "own.md", layers: ["@marley/vars#a"], layerVars: { agent: "Other" }, extensions: ["@marley/vars"] }, outputs: [], ports: [] }] } }, { "own.md": "own {{agent}}" }),
    "x", {}, { "@marley/vars": personaRoot });
  assert.notEqual(profileFingerprint(resolved.profile), profileFingerprint(other.profile));
  assert.throws(() => readExtensionAgents(agent(undefined, { layerVars: { a: "b" } })), /layerVars needs layers/);
  assert.throws(() => readExtensionAgents(agent(["@marley/persona#soul"], { layerVars: { "bad name": "b" } })), /not a variable name/);
  assert.throws(() => readExtensionAgents(agent(["@marley/persona#soul"], { layerVars: { a: 1 } })), /must be a string/);
});
