// Reading and writing GCS objects for the cloud host: the gcloud CLI, and the JSON API with one cached access token.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "fs";
import https from "https";
import os from "os";
import path from "path";

export function gcloud(args: string[], options: { timeoutMs?: number; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.env.MARSHAL_SDK_GCLOUD || "gcloud",
      args,
      { timeout: options.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1" } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`gcloud ${args.slice(0, 3).join(" ")}: ${String(stderr || error.message).trim().split("\n").slice(-2).join(" ")}`));
        else resolve(String(stdout));
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

// ---- Reading the bucket ----
// Listing runs touches a handful of small objects per run. Spawning gcloud for each costs about a second apiece, so
// when gcloud is the real CLI one access token is fetched once and objects are read over the JSON API in parallel.
// A MARSHAL_SDK_GCLOUD override (tests, other CLIs) keeps every call on that binary.
let tokenCache: { token: string; at: number } | undefined;
const gcsAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });
export const useRest = () => !process.env.MARSHAL_SDK_GCLOUD && process.env.MARSHAL_SDK_GCS_REST !== "0";

export async function accessToken(): Promise<string> {
  if (tokenCache && Date.now() - tokenCache.at < 45 * 60_000) return tokenCache.token;
  const token = (await gcloud(["auth", "print-access-token"], { timeoutMs: 30_000 })).trim();
  if (!token) throw new Error("gcloud returned no access token");
  tokenCache = { token, at: Date.now() };
  return token;
}

export const splitUri = (uri: string) => {
  const rest = uri.replace(/^gs:\/\//, "");
  const slash = rest.indexOf("/");
  return { bucket: slash < 0 ? rest : rest.slice(0, slash), object: slash < 0 ? "" : rest.slice(slash + 1) };
};

export async function restGet(url: string): Promise<Buffer> {
  const token = await accessToken();
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { authorization: `Bearer ${token}` }, timeout: 30_000, agent: gcsAgent }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        if ((res.statusCode ?? 0) >= 400) {
          if (res.statusCode === 401) tokenCache = undefined;
          reject(new Error(`gcs ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8").slice(0, 200)}`));
        } else resolve(Buffer.concat(chunks));
      });
    });
    request.on("timeout", () => request.destroy(new Error("gcs request timed out")));
    request.on("error", reject);
  });
}

/** An object's text. Rejects when it does not exist. */
export async function gcsCat(uri: string): Promise<string> {
  if (!useRest()) return gcloud(["storage", "cat", uri], { timeoutMs: 30_000 });
  const { bucket, object } = splitUri(uri);
  return (await restGet(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`)).toString("utf8");
}

export const globRegExp = (pattern: string) => new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.{0,}/)?").replace(/\*/g, "[^/]*") + "$");

/** Object URIs matching a gs:// glob (* within a folder, **\/ across folders); [] when none match. */
export async function gcsGlob(pattern: string): Promise<string[]> {
  if (!useRest()) {
    try {
      return (await gcloud(["storage", "ls", pattern], { timeoutMs: 60_000 })).split("\n").map((line) => line.trim()).filter(Boolean);
    } catch (error) {
      if (/matched no objects|One or more URLs matched no objects|not found/i.test(String((error as Error).message))) return [];
      throw error;
    }
  }
  const star = pattern.indexOf("*");
  const { bucket, object } = splitUri(star < 0 ? pattern : pattern.slice(0, star));
  const re = globRegExp(pattern);
  const hits: string[] = [];
  let pageToken = "";
  do {
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?prefix=${encodeURIComponent(object)}&fields=items(name),nextPageToken&maxResults=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const body = JSON.parse((await restGet(url)).toString("utf8")) as { items?: { name: string }[]; nextPageToken?: string };
    for (const item of body.items ?? []) {
      const uri = `gs://${bucket}/${item.name}`;
      if (re.test(uri)) hits.push(uri);
    }
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return hits;
}

/** Runs fn over items with at most `limit` in flight. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await fn(items[index]!);
      }
    }),
  );
  return out;
}

// ---- Objects with generations: reading what is there, writing only if it did not move ----

/** A conditional write found the object at another generation than the caller read. */
export class PreconditionFailed extends Error {
  constructor(uri: string) {
    super(`${uri} changed since it was read`);
    this.name = "PreconditionFailed";
  }
}

export interface ObjectRead {
  data: Buffer;
  /** The object's generation; "0" is what a conditional write expects of an object that does not exist. */
  generation: string;
}

const customBinary = () => Boolean(process.env.MARSHAL_SDK_GCLOUD);
// A MARSHAL_SDK_GCLOUD stand-in (tests) has no generations: the content stands in for one, so a write that lost a race
// to different content is still refused. The real CLI and API carry the real generation.
const contentGeneration = (data: Buffer) => `c-${createHash("sha256").update(data).digest("hex").slice(0, 16)}`;

function restGetFull(url: string): Promise<{ body: Buffer; headers: Record<string, string | string[] | undefined> }> {
  return accessToken().then(
    (token) =>
      new Promise((resolve, reject) => {
        const request = https.get(url, { headers: { authorization: `Bearer ${token}` }, timeout: 60_000, agent: gcsAgent }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            if ((res.statusCode ?? 0) >= 400) {
              if (res.statusCode === 401) tokenCache = undefined;
              reject(new Error(`gcs ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8").slice(0, 200)}`));
            } else resolve({ body: Buffer.concat(chunks), headers: res.headers });
          });
        });
        request.on("timeout", () => request.destroy(new Error("gcs request timed out")));
        request.on("error", reject);
      }),
  );
}

const missing = (error: unknown) => /gcs 404|not found|No URLs matched|matched no objects|does not exist/i.test(String((error as Error)?.message ?? error));

/** An object's bytes and generation, or undefined when it does not exist. */
export async function gcsRead(uri: string): Promise<ObjectRead | undefined> {
  try {
    if (!useRest()) {
      const file = path.join(os.tmpdir(), `gcs-read-${process.pid}-${Math.random().toString(36).slice(2)}`);
      try {
        await gcloud(["storage", "cp", uri, file], { timeoutMs: 120_000 });
        const data = fs.readFileSync(file);
        return { data, generation: contentGeneration(data) };
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
    const { bucket, object } = splitUri(uri);
    const { body, headers } = await restGetFull(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`);
    return { data: body, generation: String(headers["x-goog-generation"] ?? "") };
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

/** Objects under a prefix (not recursive past one folder) with their sizes where the backend reports them. */
export async function gcsList(prefix: string): Promise<{ uri: string; size?: number }[]> {
  if (!useRest()) return (await gcsGlob(`${prefix.replace(/\/+$/, "")}/*`)).map((uri) => ({ uri }));
  const { bucket, object } = splitUri(`${prefix.replace(/\/+$/, "")}/`);
  const out: { uri: string; size?: number }[] = [];
  let pageToken = "";
  do {
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?prefix=${encodeURIComponent(object)}&delimiter=/&fields=items(name,size),nextPageToken&maxResults=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const body = JSON.parse((await restGet(url)).toString("utf8")) as { items?: { name: string; size?: string }[]; nextPageToken?: string };
    for (const item of body.items ?? []) if (item.name !== object) out.push({ uri: `gs://${bucket}/${item.name}`, size: item.size ? Number(item.size) : undefined });
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

export interface WriteOptions {
  contentType?: string;
  cacheControl?: string;
  /** Write only if the object is at this generation ("0": only if it does not exist). */
  ifGenerationMatch?: string;
}

/** Writes bytes to an object; with ifGenerationMatch it throws PreconditionFailed when the object moved. */
export async function gcsWrite(uri: string, data: Buffer | string, options: WriteOptions = {}): Promise<void> {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  const flags: string[] = [];
  if (options.contentType) flags.push(`--content-type=${options.contentType}`);
  if (options.cacheControl) flags.push(`--cache-control=${options.cacheControl}`);
  if (options.ifGenerationMatch !== undefined) {
    if (customBinary()) {
      const now = await gcsRead(uri);
      if ((now ? now.generation : "0") !== options.ifGenerationMatch) throw new PreconditionFailed(uri);
    } else flags.push(`--if-generation-match=${options.ifGenerationMatch}`);
  }
  const file = path.join(os.tmpdir(), `gcs-write-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, bytes);
  try {
    await gcloud(["storage", "cp", ...flags, file, uri], { timeoutMs: 300_000 });
  } catch (error) {
    if (options.ifGenerationMatch !== undefined && /412|conditionNotMet|PreconditionFailed|precondition/i.test(String((error as Error).message))) throw new PreconditionFailed(uri);
    throw error;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** The generation a caller passes to gcsWrite to replace what it just read (or "0" when nothing was there). */
export const generationOf = (read: ObjectRead | undefined) => (read ? read.generation : "0");

/** Downloads one object into a local file (creating its folder) and returns its size. */
export async function gcsDownload(uri: string, file: string): Promise<number> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.part-${process.pid}`;
  try {
    if (!useRest()) await gcloud(["storage", "cp", uri, partial], { timeoutMs: 300_000 });
    else {
      const { bucket, object } = splitUri(uri);
      const { body } = await restGetFull(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`);
      fs.writeFileSync(partial, body);
    }
    fs.renameSync(partial, file);
    return fs.statSync(file).size;
  } finally {
    fs.rmSync(partial, { force: true });
  }
}
