import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { downloadObject, ObjectDownloadError, uploadObject } from "../../backup.js";
import type { FetchFn, TokenSource } from "../../gcp.js";

/**
 * Where a brand's chat files are kept off the sandbox: one private bucket, one prefix per brand (`chat-files/<brand id>/`). The server alone holds the credentials; a sandbox never
 * sees the bucket. Chat work folders can hold owner financials, so this is the same sensitivity as the transcripts backup: no public access, nothing outside the prefix is read.
 */
export interface ChatBackupStore {
  put(object: string, file: string): Promise<void>;
  get(object: string, file: string): Promise<void>;
  /** The parsed JSON object, or null when it does not exist. */
  getJson(object: string): Promise<unknown | null>;
  putJson(object: string, value: unknown): Promise<void>;
  remove(object: string): Promise<void>;
}

export const chatBackupPrefix = (brandId: string): string => `chat-files/${brandId}/`;

export function gcsChatBackupStore(input: { bucket: string; tokens: TokenSource; fetchFn?: FetchFn }): ChatBackupStore {
  const fetchFn = input.fetchFn ?? fetch;
  const scratch = <T>(use: (dir: string) => Promise<T>): Promise<T> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zs-chatstore-"));
    return use(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  };
  return {
    put: (object, file) => uploadObject(input.bucket, object, file, input.tokens, fetchFn),
    get: (object, file) => downloadObject(input.bucket, object, file, input.tokens, fetchFn),
    getJson: (object) => scratch(async (dir) => {
      const file = path.join(dir, "o.json");
      try { await downloadObject(input.bucket, object, file, input.tokens, fetchFn); } catch (error) {
        if (error instanceof ObjectDownloadError && error.status === 404) return null;
        throw error;
      }
      return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    }),
    putJson: (object, value) => scratch(async (dir) => {
      const file = path.join(dir, "o.json");
      fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
      await uploadObject(input.bucket, object, file, input.tokens, fetchFn);
    }),
    remove: async (object) => {
      const token = await input.tokens.accessToken();
      const response = await fetchFn(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(input.bucket)}/o/${encodeURIComponent(object)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok && response.status !== 404) throw new Error(`delete ${object}: HTTP ${response.status}`);
    },
  };
}
