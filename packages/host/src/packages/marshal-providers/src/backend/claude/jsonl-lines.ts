const NEWLINE_BYTE = 0x0a;

/** `bytes` as a Buffer over the same memory. */
export function bufferOver(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * The lines `Buffer.from(bytes).toString("utf8").split("\n")` gives, decoded one at a time. A
 * session file runs to hundreds of megabytes: as one string and its lines it took that much of the
 * main process heap again on every pass, and a fork made several passes (2026-11-18
 * out-of-memory crashes).
 */
export function* jsonlLines(bytes: Uint8Array): Generator<string, void, void> {
  const buffer = bufferOver(bytes);
  let start = 0;
  for (;;) {
    const end = buffer.indexOf(NEWLINE_BYTE, start);
    yield buffer.toString("utf8", start, end < 0 ? buffer.length : end);
    if (end < 0) return;
    start = end + 1;
  }
}

/** The parts one after another, in an array of its own. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}
