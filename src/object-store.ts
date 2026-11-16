import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** A write whose `ifGenerationMatch` did not hold: the object exists (create-only) or changed under the writer. */
export class PreconditionFailedError extends Error {
  readonly code = "precondition_failed";
  constructor(key: string) {
    super(`Precondition failed for ${key}`);
  }
}

export interface ObjectInfo {
  name: string;
  /** Changes whenever the object is written; the cache key of a pulled copy. */
  generation: string;
  updated: string;
  size: number;
}

export interface PutOptions {
  contentType?: string;
  /** 0 creates only; a generation overwrites only that version. Absent: unconditional. */
  ifGenerationMatch?: number | string;
}

/** Blobs: transcript batches, session objects, index shards. Keys are slash paths and never start with one. */
export interface ObjectStore {
  put(key: string, data: Uint8Array | string, options?: string | PutOptions): Promise<{ generation: string }>;
  get(key: string): Promise<Uint8Array | undefined>;
  /** The bytes and the generation they are. */
  read(key: string): Promise<{ data: Uint8Array; generation: string } | undefined>;
  list(prefix: string): Promise<string[]>;
  /** Names with generations, without reading any object. */
  listInfo(prefix: string): Promise<ObjectInfo[]>;
  /** Server-side concatenation of up to 32 objects into `destination`. */
  compose(sources: string[], destination: string, options?: PutOptions): Promise<{ generation: string }>;
  delete(key: string, options?: { ifGenerationMatch?: number | string }): Promise<void>;
}

const putOptions = (options?: string | PutOptions): PutOptions => (typeof options === "string" ? { contentType: options } : options ?? {});

/** An object store in a folder: tests, the local stack, a single machine, or a mounted bucket. Generations come from the file's mtime and size. */
export function fsObjectStore(root: string): ObjectStore {
  const base = path.resolve(root);
  const resolve = (key: string): string => {
    const target = path.resolve(base, key);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error(`Object key ${key} leaves the store.`);
    return target;
  };
  const generationOf = (stat: fs.BigIntStats): string => `${stat.mtimeNs}${stat.size}`;
  const statOf = (target: string): fs.BigIntStats | undefined => {
    try {
      return fs.statSync(target, { bigint: true });
    } catch {
      return undefined;
    }
  };
  const write = (key: string, data: Uint8Array | string, options: PutOptions): { generation: string } => {
    const target = resolve(key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const match = options.ifGenerationMatch;
    if (match !== undefined && String(match) === "0") {
      try {
        fs.writeFileSync(target, data, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PreconditionFailedError(key);
        throw error;
      }
    } else {
      if (match !== undefined) {
        const current = statOf(target);
        if (!current || generationOf(current) !== String(match)) throw new PreconditionFailedError(key);
      }
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, data);
      fs.renameSync(temporary, target);
    }
    return { generation: generationOf(fs.statSync(target, { bigint: true })) };
  };
  const listInfo = async (prefix: string): Promise<ObjectInfo[]> => {
    const found: ObjectInfo[] = [];
    const visit = (dir: string) => {
      for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (!entry.name.endsWith(".tmp")) {
          const name = path.relative(base, full).split(path.sep).join("/");
          if (!name.startsWith(prefix)) continue;
          const stat = fs.statSync(full, { bigint: true });
          found.push({ name, generation: generationOf(stat), updated: new Date(Number(stat.mtimeNs / 1_000_000n)).toISOString(), size: Number(stat.size) });
        }
      }
    };
    visit(base);
    return found.sort((a, b) => a.name.localeCompare(b.name));
  };
  return {
    async put(key, data, options) {
      return write(key, data, putOptions(options));
    },
    async get(key) {
      try {
        return new Uint8Array(fs.readFileSync(resolve(key)));
      } catch {
        return undefined;
      }
    },
    async read(key) {
      const target = resolve(key);
      const stat = statOf(target);
      if (!stat) return undefined;
      return { data: new Uint8Array(fs.readFileSync(target)), generation: generationOf(stat) };
    },
    async list(prefix) {
      return (await listInfo(prefix)).map((info) => info.name);
    },
    listInfo,
    async compose(sources, destination, options) {
      if (sources.length === 0 || sources.length > 32) throw new Error("compose takes 1 to 32 sources");
      const parts = sources.map((source) => {
        const data = fs.existsSync(resolve(source)) ? fs.readFileSync(resolve(source)) : undefined;
        if (!data) throw new Error(`compose source ${source} is missing`);
        return data;
      });
      return write(destination, Buffer.concat(parts), putOptions(options));
    },
    async delete(key, options) {
      const target = resolve(key);
      if (options?.ifGenerationMatch !== undefined) {
        const current = statOf(target);
        if (current && generationOf(current) !== String(options.ifGenerationMatch)) throw new PreconditionFailedError(key);
      }
      fs.rmSync(target, { force: true });
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
  const call = async (url: string, init: RequestInit): Promise<Response> =>
    doFetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${await options.accessToken()}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  const fail = async (what: string, key: string, response: Response): Promise<never> => {
    if (response.status === 412) throw new PreconditionFailedError(key);
    throw new Error(`GCS ${what} failed: ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`);
  };
  const condition = (match: number | string | undefined) => (match === undefined ? "" : `&ifGenerationMatch=${encodeURIComponent(String(match))}`);
  const listInfo = async (prefix: string): Promise<ObjectInfo[]> => {
    const found: ObjectInfo[] = [];
    let token: string | undefined;
    do {
      const response = await call(
        `${base}/storage/v1/b/${bucket}/o?prefix=${encodeURIComponent(prefix)}&fields=${encodeURIComponent("items(name,generation,updated,size),nextPageToken")}${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`,
        { method: "GET" },
      );
      if (!response.ok) await fail(`list of ${prefix}`, prefix, response);
      const page = (await response.json()) as { items?: { name: string; generation: string; updated: string; size?: string }[]; nextPageToken?: string };
      found.push(...(page.items ?? []).map((item) => ({ name: item.name, generation: String(item.generation), updated: item.updated, size: Number(item.size ?? 0) })));
      token = page.nextPageToken;
    } while (token);
    return found.sort((a, b) => a.name.localeCompare(b.name));
  };
  return {
    async put(key, data, opts) {
      const { contentType = "application/octet-stream", ifGenerationMatch } = putOptions(opts);
      const response = await call(`${base}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(key)}${condition(ifGenerationMatch)}`, {
        method: "POST",
        headers: { "content-type": contentType },
        body: typeof data === "string" ? data : (data as BodyInit),
      });
      if (!response.ok) await fail(`upload of ${key}`, key, response);
      return { generation: String(((await response.json()) as { generation?: string }).generation ?? "") };
    },
    async get(key) {
      return (await this.read(key))?.data;
    },
    async read(key) {
      const response = await call(`${base}/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}?alt=media`, { method: "GET" });
      if (response.status === 404) return undefined;
      if (!response.ok) await fail(`download of ${key}`, key, response);
      return { data: new Uint8Array(await response.arrayBuffer()), generation: response.headers.get("x-goog-generation") ?? "" };
    },
    async list(prefix) {
      return (await listInfo(prefix)).map((info) => info.name);
    },
    listInfo,
    async compose(sources, destination, opts) {
      if (sources.length === 0 || sources.length > 32) throw new Error("compose takes 1 to 32 sources");
      const { contentType = "application/octet-stream", ifGenerationMatch } = putOptions(opts);
      const response = await call(`${base}/storage/v1/b/${bucket}/o/${encodeURIComponent(destination)}/compose?${condition(ifGenerationMatch).slice(1)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceObjects: sources.map((name) => ({ name })), destination: { contentType } }),
      });
      if (!response.ok) await fail(`compose of ${destination}`, destination, response);
      return { generation: String(((await response.json()) as { generation?: string }).generation ?? "") };
    },
    async delete(key, opts) {
      const response = await call(`${base}/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}${opts?.ifGenerationMatch === undefined ? "" : `?${condition(opts.ifGenerationMatch).slice(1)}`}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) await fail(`delete of ${key}`, key, response);
    },
  };
}
