// Extract of zygstinct apps/agent-server/src/object-store.ts at 7110e58c8: only googleObjectStore, ObjectTooLarge, ObjectStore.
import type { FetchFn, TokenSource } from "./gcp.js";

/** The attachments bucket, as the server uses it: it reads inbound media and writes outbound files. The VM never touches it. */
export interface ObjectStore {
  download(uri: string, maxBytes: number): Promise<Buffer>;
  upload(uri: string, data: Buffer, contentType: string): Promise<void>;
  /** Deletes an object (tests clean up after themselves); a missing object is not an error. */
  remove(uri: string): Promise<void>;
  /** The object names under a `gs://bucket/prefix` (at most `limit`, sorted); a store without it cannot list. */
  list?(prefixUri: string, limit?: number): Promise<string[]>;
}

/** The object does not exist (HTTP 404), as distinct from any other download failure. */
export class ObjectNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectNotFoundError";
  }
}

/** The object is larger than the caller's limit (typed, so a caller can tell it from an unreadable object). */
export class ObjectTooLarge extends Error {
  constructor(readonly bytes: number, readonly maxBytes: number) {
    super(`file is ${bytes} bytes, over the ${maxBytes} byte limit`);
    this.name = "ObjectTooLarge";
  }
}

export interface GsUri {
  bucket: string;
  object: string;
}

export function parseGsUri(uri: string): GsUri | null {
  const match = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,220})\/(.+)$/.exec(uri);
  if (!match || match[2]!.split("/").includes("..")) return null;
  return { bucket: match[1]!, object: match[2]! };
}

/** Cloud Storage JSON API with the server's own access token (no client library). */
export function googleObjectStore(tokens: TokenSource, fetchFn: FetchFn = fetch): ObjectStore {
  const parse = (uri: string): GsUri => {
    const parsed = parseGsUri(uri);
    if (!parsed) throw new Error("not a gs:// object uri");
    return parsed;
  };
  return {
    async download(uri, maxBytes) {
      const { bucket, object } = parse(uri);
      const response = await fetchFn(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media`, {
        headers: { Authorization: `Bearer ${await tokens.accessToken()}` },
        signal: AbortSignal.timeout(120_000),
      });
      if (response.status === 404) throw new ObjectNotFoundError("storage download failed: HTTP 404");
      if (!response.ok) throw new Error(`storage download failed: HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > maxBytes) throw new ObjectTooLarge(declared, maxBytes);
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > maxBytes) throw new ObjectTooLarge(data.length, maxBytes);
      return data;
    },
    async upload(uri, data, contentType) {
      const { bucket, object } = parse(uri);
      const response = await fetchFn(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(object)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await tokens.accessToken()}`, "Content-Type": contentType || "application/octet-stream" },
        body: new Uint8Array(data),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`storage upload failed: HTTP ${response.status}`);
    },
    async list(prefixUri, limit = 50) {
      const { bucket, object } = parse(prefixUri);
      const response = await fetchFn(`https://storage.googleapis.com/storage/v1/b/${bucket}/o?prefix=${encodeURIComponent(object)}&maxResults=${limit}&fields=items(name)`, {
        headers: { Authorization: `Bearer ${await tokens.accessToken()}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`storage list failed: HTTP ${response.status}`);
      const body = (await response.json()) as { items?: { name?: string }[] };
      return (body.items ?? []).flatMap((item) => (typeof item.name === "string" ? [item.name] : [])).sort();
    },
    async remove(uri) {
      const { bucket, object } = parse(uri);
      const response = await fetchFn(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${await tokens.accessToken()}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok && response.status !== 404) throw new Error(`storage delete failed: HTTP ${response.status}`);
    },
  };
}
