import { scrubSecrets } from "../../common/secret-scrub";

/** Base64 payloads (images, files) above this many characters become a placeholder. */
const MAX_INLINE_BASE64_CHARS = 2048;
/** Fields whose exact value the resume chain or the API validates; never rewritten. */
const VERBATIM_KEYS = new Set([
  "signature",
  "uuid",
  "parentUuid",
  "sessionId",
  "tool_use_id",
  "id",
]);
const CAPTURE_TYPES = new Set(["api-request", "api-request-shape", "api-request-blob"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function placeholder(kind: string, mediaType: unknown, chars: number): string {
  const media = typeof mediaType === "string" ? mediaType.slice(0, 64) : "unknown type";
  return `[${kind} omitted: ${media}, about ${Math.round((chars * 3) / 4)} bytes]`;
}

function cleanValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") return key && VERBATIM_KEYS.has(key) ? value : scrubSecrets(value);
  if (Array.isArray(value)) return value.map((item) => cleanValue(item));
  if (!isRecord(value)) return value;
  const source = value["source"];
  if (
    (value["type"] === "image" || value["type"] === "document") &&
    isRecord(source) &&
    source["type"] === "base64" &&
    typeof source["data"] === "string" &&
    source["data"].length > MAX_INLINE_BASE64_CHARS
  ) {
    return {
      type: "text",
      text: placeholder(value["type"], source["media_type"], source["data"].length),
    };
  }
  const out: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(value)) {
    if (
      typeof child === "string" &&
      child.length > MAX_INLINE_BASE64_CHARS &&
      (name === "base64" || (name === "data" && typeof value["media_type"] === "string"))
    ) {
      out[name] = placeholder("data", value["media_type"], child.length);
    } else {
      out[name] = cleanValue(child, name);
    }
  }
  return out;
}

const OMITTED_REASONING_BLOCK = { type: "text", text: "[reasoning omitted]" };

/**
 * A thinking block is signed over its exact text, so one whose text redaction would change cannot
 * be sent back; it is dropped. A message left with no content keeps a short text block instead.
 */
function dropChangedThinking(entry: unknown): unknown {
  if (!isRecord(entry) || !isRecord(entry["message"])) return entry;
  const content = entry["message"]["content"];
  if (!Array.isArray(content)) return entry;
  const kept = content.filter(
    (block) =>
      !(
        isRecord(block) &&
        block["type"] === "thinking" &&
        typeof block["thinking"] === "string" &&
        scrubSecrets(block["thinking"]) !== block["thinking"]
      ),
  );
  if (kept.length === content.length) return entry;
  return {
    ...entry,
    message: { ...entry["message"], content: kept.length > 0 ? kept : [OMITTED_REASONING_BLOCK] },
  };
}

function isDroppedEntry(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  const type = entry["type"];
  if (typeof type === "string" && CAPTURE_TYPES.has(type)) return true;
  const attachment = entry["attachment"];
  return type === "attachment" && isRecord(attachment) && attachment["type"] === "prompt_snapshot";
}

/**
 * Prepares one Claude session file to leave this computer. Keeps the conversation's structure so the
 * cloud can resume it, but drops the system-prompt snapshots and Marshal's request captures (the
 * receiving host runs on its own prompt), redacts every string including tool inputs and outputs,
 * and replaces inline base64 images and documents with a short placeholder. A line that is not
 * valid JSON is dropped rather than copied unredacted.
 */
export function sanitizeClaudeJsonl(bytes: Uint8Array): Uint8Array {
  const kept: string[] = [];
  for (const line of Buffer.from(bytes).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line) as unknown; // SF-4: re-serialized through the sanitizer below
    } catch {
      continue;
    }
    if (isDroppedEntry(entry)) continue;
    kept.push(JSON.stringify(cleanValue(dropChangedThinking(entry))));
  }
  return new TextEncoder().encode(kept.length > 0 ? `${kept.join("\n")}\n` : "");
}
