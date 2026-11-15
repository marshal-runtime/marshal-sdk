import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { providerKey, readSecret, requireProviderKey } from "../src/credentials.js";

test("a key comes from its variable, else from the file NAME_FILE names, else nowhere", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-cred-")), "key");
  fs.writeFileSync(file, "sk-from-file\n");
  assert.equal(readSecret("K", { K: " sk-direct ", K_FILE: file }), "sk-direct");
  assert.equal(readSecret("K", { K_FILE: file }), "sk-from-file");
  assert.equal(readSecret("K", { K_FILE: path.join(path.dirname(file), "missing") }), undefined);
  assert.equal(readSecret("K", {}), undefined);
});

test("a provider's key: its usual variable, or the one named, with the source and never the key to log", () => {
  assert.deepEqual(providerKey("openai", { env: { OPENAI_API_KEY: "sk-o" } }), { key: "sk-o", source: "OPENAI_API_KEY" });
  assert.deepEqual(providerKey("openai", { env: { TEAM_KEY: "sk-t" }, keyEnv: "TEAM_KEY" }), { key: "sk-t", source: "TEAM_KEY" });
  assert.equal(providerKey("anthropic", { env: {} }), undefined);
  assert.throws(() => requireProviderKey("gemini", { env: {} }), /No gemini API key: set GEMINI_API_KEY \(or GEMINI_API_KEY_FILE\)/);
});
