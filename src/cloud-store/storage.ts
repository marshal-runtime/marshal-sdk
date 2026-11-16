import fs from "node:fs";
import path from "node:path";

/** The one thing a cloud store needs from a database: `pg`'s Pool and Client already have this shape. */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** Blobs: transcript batches too big for a row, session artifacts. Keys are slash paths and never start with one. */
export interface ObjectStore {
  put(key: string, data: Uint8Array | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

/** An object store in a folder: tests, a single machine, or a mounted bucket. */
export function fsObjectStore(root: string): ObjectStore {
  const resolve = (key: string): string => {
    const target = path.resolve(root, key);
    if (target !== path.resolve(root) && !target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`Object key ${key} leaves the store.`);
    return target;
  };
  return {
    async put(key, data) {
      const target = resolve(key);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    },
    async get(key) {
      try {
        return new Uint8Array(fs.readFileSync(resolve(key)));
      } catch {
        return undefined;
      }
    },
    async list(prefix) {
      const found: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else found.push(path.relative(root, full).split(path.sep).join("/"));
        }
      };
      walk(path.resolve(root));
      return found.filter((key) => key.startsWith(prefix)).sort();
    },
    async delete(key) {
      fs.rmSync(resolve(key), { force: true });
    },
  };
}

export interface GcsObjectStoreOptions {
  bucket: string;
  /** A fresh OAuth access token (or an ID token the endpoint accepts) for each request. */
  accessToken: () => Promise<string>;
  /** The JSON API base, for an emulator. Default https://storage.googleapis.com. */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Google Cloud Storage over its JSON API: no client library, so an SDK host stays dependency-light. */
export function gcsObjectStore(options: GcsObjectStoreOptions): ObjectStore {
  const base = (options.baseUrl ?? "https://storage.googleapis.com").replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const bucket = encodeURIComponent(options.bucket);
  const call = async (url: string, init: RequestInit): Promise<Response> => {
    const response = await doFetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${await options.accessToken()}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    return response;
  };
  const fail = async (what: string, response: Response): Promise<never> => {
    throw new Error(`GCS ${what} failed: ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`);
  };
  return {
    async put(key, data, contentType = "application/octet-stream") {
      const response = await call(`${base}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": contentType },
        body: typeof data === "string" ? data : (data as BodyInit),
      });
      if (!response.ok) await fail(`upload of ${key}`, response);
    },
    async get(key) {
      const response = await call(`${base}/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}?alt=media`, { method: "GET" });
      if (response.status === 404) return undefined;
      if (!response.ok) await fail(`download of ${key}`, response);
      return new Uint8Array(await response.arrayBuffer());
    },
    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const response = await call(
          `${base}/storage/v1/b/${bucket}/o?prefix=${encodeURIComponent(prefix)}${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`,
          { method: "GET" },
        );
        if (!response.ok) await fail(`list of ${prefix}`, response);
        const page = (await response.json()) as { items?: { name: string }[]; nextPageToken?: string };
        keys.push(...(page.items ?? []).map((item) => item.name));
        token = page.nextPageToken;
      } while (token);
      return keys.sort();
    },
    async delete(key) {
      const response = await call(`${base}/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) await fail(`delete of ${key}`, response);
    },
  };
}
