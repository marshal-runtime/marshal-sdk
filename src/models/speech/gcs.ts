// Lifted from packages/speech/src/gcs.ts (zygstinct 940a0c6d5) so every SDK host gets Marley's speech providers natively.
import { SpeechError } from "./types.js";
import { failFromResponse, timedFetch, type FetchLike, type TokenProvider } from "./http.js";

export function parseGsUri(uri: string): { bucket: string; object: string } {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) throw new SpeechError("bad-request", `not a gs:// object uri: ${uri}`);
  return { bucket: match[1]!, object: match[2]! };
}

export async function downloadGcs(uri: string, token: TokenProvider, fetchImpl: FetchLike, maxBytes: number): Promise<Buffer> {
  const { bucket, object } = parseGsUri(uri);
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;
  const res = await timedFetch(fetchImpl, url, { headers: { authorization: `Bearer ${await token()}` } }, 60_000, `download ${uri}`);
  if (!res.ok) return failFromResponse(res, `download ${uri}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > maxBytes) throw new SpeechError("audio-too-large", `${uri} is ${data.length} bytes, limit ${maxBytes}`);
  return data;
}
