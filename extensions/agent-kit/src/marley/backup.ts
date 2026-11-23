// Extract of zygstinct apps/agent-server/src/backup.ts at 7110e58c8: only downloadObject, ObjectDownloadError, uploadObject.
import * as fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FetchFn, TokenSource } from "./gcp.js";

/** Downloads one object from GCS to a file (JSON API, alt=media). */
/** A storage download that did not return the object: `status` is the HTTP status, so a caller decides on it and never on the message. */
export class ObjectDownloadError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "ObjectDownloadError"; }
}

export async function downloadObject(bucket: string, object: string, file: string, tokens: TokenSource, fetchFn: FetchFn = fetch): Promise<void> {
  const token = await tokens.accessToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;
  const response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok || !response.body) throw new ObjectDownloadError(`download ${object}: HTTP ${response.status} ${response.ok ? "" : (await response.text()).slice(0, 200)}`, response.status);
  await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(file));
}

/** Uploads one file to GCS with a media upload (the JSON API), streaming from disk. */
export async function uploadObject(bucket: string, object: string, file: string, tokens: TokenSource, fetchFn: FetchFn = fetch): Promise<void> {
  const token = await tokens.accessToken();
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}`;
  const body = Readable.toWeb(fs.createReadStream(file)) as unknown as BodyInit;
  const response = await fetchFn(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/gzip" },
    body,
    duplex: "half",
  } as RequestInit);
  if (!response.ok) throw new Error(`upload ${object}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
}
