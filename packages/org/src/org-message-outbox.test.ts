import { describe, expect, it, vi } from "vitest";

const { writeEncryptedFile } = vi.hoisted(() => ({
  writeEncryptedFile: vi.fn<(path: string, data: string) => Promise<void>>(),
}));

vi.mock("../../../electron/app-paths", () => ({ getAppDataDir: () => "/tmp/marshal-outbox-test" }));
vi.mock("../../../electron/safe-storage-file", () => ({
  assertSafeStorageReady: vi.fn<() => void>(),
  loadOrCreateKey: vi.fn<() => Buffer | null>(() => null),
  readEncryptedFile: vi.fn<() => Promise<string>>(),
  writeEncryptedFile,
}));

import {
  OrgMessageOutboxUnavailableError,
  SafeStorageOrgMessageOutbox,
} from "./org-message-outbox";

describe("SafeStorageOrgMessageOutbox without secure storage", () => {
  it("refuses to save instead of keeping the text anywhere", async () => {
    const outbox = new SafeStorageOrgMessageOutbox("/tmp/marshal-outbox-test/o.enc");
    await expect(
      outbox.save([
        {
          sessionId: "s",
          orgId: "org",
          clientMsgId: "c",
          text: "private",
          queuedAt: 1,
          attempts: 0,
          state: "pending",
        },
      ]),
    ).rejects.toBeInstanceOf(OrgMessageOutboxUnavailableError);
    expect(writeEncryptedFile).not.toHaveBeenCalled();
  });
});
