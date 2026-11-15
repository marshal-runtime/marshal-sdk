import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  configureOrgHost,
  orgTokenFilePath,
  SafeStorageOrgTokenStore,
  scrubText,
} from "../src/org-package.js";

const session = {
  orgUrl: "https://org.example.test",
  orgId: "acme",
  tokens: { accessToken: "person-access-token-123", tokenType: "Bearer", refreshToken: "refresh-456" },
};

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "msdk-org-"));
}

test("the org token store keeps the person's token encrypted under the host's state root", async () => {
  const stateDir = tempDir();
  configureOrgHost({ stateDir, cipher: undefined });
  assert.equal(orgTokenFilePath(), path.join(stateDir, "org-auth.enc"));
  const store = new SafeStorageOrgTokenStore();
  await store.save(session);
  const onDisk = fs.readFileSync(orgTokenFilePath());
  assert.ok(!onDisk.toString("utf8").includes("person-access-token-123"), "token is not stored in plaintext");
  assert.equal(fs.statSync(path.join(stateDir, "org-state.key")).mode & 0o777, 0o600);
  assert.deepEqual(await new SafeStorageOrgTokenStore().load(), session);
  await store.clear();
  assert.equal(await store.load(), null);
});

test("a host cipher replaces the default key file (the desktop passes safeStorage the same way)", async () => {
  const stateDir = tempDir();
  const key = randomBytes(32);
  let encrypts = 0;
  configureOrgHost({
    stateDir,
    cipher: {
      encrypt(plain) {
        encrypts += 1;
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        const body = Buffer.concat([cipher.update(plain), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), body]);
      },
      decrypt(data) {
        const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
        decipher.setAuthTag(data.subarray(12, 28));
        return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
      },
    },
  });
  const store = new SafeStorageOrgTokenStore();
  await store.save(session);
  assert.equal(encrypts, 1);
  assert.equal(fs.existsSync(path.join(stateDir, "org-state.key")), false);
  assert.deepEqual(await store.load(), session);
  configureOrgHost({ cipher: undefined });
});

test("the shared sanitizer scrubs secrets and local paths before anything is published to the org", () => {
  const text = scrubText("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 in /Users/dana/acme/src/app.ts", {
    workspaceRoot: "/Users/dana/acme",
    homeDir: "/Users/dana",
  });
  assert.ok(!text.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.ok(text.includes("./src/app.ts"));
});
