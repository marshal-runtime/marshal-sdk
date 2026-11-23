export type OrgStoreEnv = "local" | "staging" | "production";
const ENVS: readonly OrgStoreEnv[] = ["local", "staging", "production"];

export type OrgStoreSinkConfig = { kind: "dir"; path: string } | { kind: "gcs"; bucket: string };

export interface OrgStoreConfig {
  env: OrgStoreEnv;
  sink: OrgStoreSinkConfig;
  /** HMAC key of the `conversation` label, so a DM's phone number never appears in a path or row (raw or as a guessable hash). */
  conversationKey: Buffer;
}

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const MIN_KEY_BYTES = 32;

/**
 * ORG_STORE_SINK: unset or "off" keeps nothing in the org store (the default). "dir:<absolute path>" writes the bucket layout into a folder
 * (the local stack); "gcs:<bucket>" writes to that Cloud Storage bucket with the pod's own token.
 * ORG_STORE_ENV: local | staging | production (required when a sink is set): the first path segment under the brand.
 * ORG_STORE_KEY: at least 32 bytes (hex or base64), the HMAC key of the conversation label.
 * A bad value stops startup naming the setting, never its value.
 */
export function parseOrgStoreConfig(env: Record<string, string | undefined>): OrgStoreConfig | undefined {
  const sinkRaw = env.ORG_STORE_SINK?.trim();
  if (!sinkRaw || sinkRaw === "off") return undefined;
  let sink: OrgStoreSinkConfig;
  if (sinkRaw.startsWith("dir:")) {
    const dir = sinkRaw.slice("dir:".length);
    if (!dir.startsWith("/")) throw new Error("ORG_STORE_SINK dir: needs an absolute path");
    sink = { kind: "dir", path: dir };
  } else if (sinkRaw.startsWith("gcs:")) {
    const bucket = sinkRaw.slice("gcs:".length);
    if (!BUCKET_PATTERN.test(bucket)) throw new Error("ORG_STORE_SINK gcs: needs a bucket name");
    sink = { kind: "gcs", bucket };
  } else {
    throw new Error('ORG_STORE_SINK must be "off", "dir:<absolute path>" or "gcs:<bucket>"');
  }
  const envName = env.ORG_STORE_ENV?.trim() as OrgStoreEnv | undefined;
  if (!envName || !ENVS.includes(envName)) throw new Error("ORG_STORE_ENV must be local, staging or production when ORG_STORE_SINK is set");
  const conversationKey = decodeKey(env.ORG_STORE_KEY);
  if (!conversationKey) throw new Error(`ORG_STORE_KEY must be at least ${MIN_KEY_BYTES} bytes, hex or base64, when ORG_STORE_SINK is set`);
  return { env: envName, sink, conversationKey };
}

function decodeKey(raw: string | undefined): Buffer | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  const bytes = /^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0 ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  return bytes.length >= MIN_KEY_BYTES ? bytes : undefined;
}
