import { PIXEL_AUDIT_INTENT_FILE_BYTES } from "@zygstinct/shared";

/** The kind of the one intent that may be larger than the rest (a pixel audit report, up to `PIXEL_AUDIT_INTENT_FILE_BYTES`). */
export const PIXEL_REPORT_KIND = "zs.pixels.report";

/** Files in one turn's intent folder. */
export const OUTBOX_MAX_FILES = 16;
/** Every other intent together (each is at most 8 KiB on the VM side). */
export const OUTBOX_MAX_BYTES = 65536;

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/**
 * The turn's collected intents are within limits: at most 16, the pixel report intents together within their own cap, and everything else together within
 * 64 KiB. A big report therefore never makes another intent (a preference, a schedule) of the same turn count against a budget it did not use. The router
 * hands each consumer only the intents of its own kind; each runs this as a backstop before it applies anything.
 */
export function outboxWithinLimits(values: readonly unknown[]): boolean {
  if (values.length > OUTBOX_MAX_FILES) return false;
  const isReport = (value: unknown) => typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === PIXEL_REPORT_KIND;
  return bytesOf(values.filter((value) => !isReport(value))) <= OUTBOX_MAX_BYTES && bytesOf(values.filter(isReport)) <= PIXEL_AUDIT_INTENT_FILE_BYTES;
}
