import { createHash } from "node:crypto";

/**
 * The code layer a sandbox runs on top of its snapshot (image/install/zs-code-apply, rules SB94/SB95/SB96). The environment pins ONE layer next to
 * DAYTONA_SNAPSHOT: `DAYTONA_CODE_LAYER=gs://<bucket>/code-layers/<sha256>.tar.gz`. The pin is the digest; no flag turns layers on or off.
 * Every outcome is a typed value (`CodeLayerOutcome`); the caller decides what a failure means (a waking sandbox is not ready, a running one is
 * reported and retried), never by reading message text.
 */

export const CODE_APPLY = "/usr/local/sbin/zs-code-apply";
/** Root-only folder the boot files already use; the layer is uploaded here and handed to the helper on stdin. */
export const LAYER_UPLOAD = "/var/lib/zs-boot/code-layer.tar.gz";
/** zs-code-apply's own bound (MAX_LAYER): the server never downloads or sends more. */
export const MAX_LAYER_BYTES = 64 << 20;
const PIN = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,220})\/code-layers\/([0-9a-f]{64})\.tar\.gz$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** Exit status of a shell that could not find the command: a snapshot older than zs-code-apply. */
const COMMAND_NOT_FOUND = 127;

export interface CodeLayerPin {
  uri: string;
  sha256: string;
}

/** The pin from its configured value; null when none is configured. A value that is not exactly a layer object's URI stops the server at startup. */
export function parseCodeLayerPin(value: string | null | undefined): CodeLayerPin | null {
  const raw = value?.trim();
  if (!raw) return null;
  const match = PIN.exec(raw);
  if (!match) throw new Error("DAYTONA_CODE_LAYER must be gs://<bucket>/code-layers/<sha256>.tar.gz");
  return { uri: raw, sha256: match[2]! };
}

/** zs-code-apply's typed refusals (REFUSALS in the helper); an answer naming anything else is `bad_answer`. */
export const CODE_LAYER_REFUSALS = [
  "no_base_policy", "base_policy_invalid", "unsafe_location", "busy", "bundle_size", "bundle_length", "sha_mismatch", "not_gzip_tar",
  "too_many_members", "expands_too_far", "member_name", "member_link", "member_device", "member_special", "member_setuid",
  "member_layout", "member_duplicate", "path_not_allowed", "layer_json_invalid", "base_key_mismatch", "file_not_listed",
  "listed_file_missing", "file_hash_mismatch", "no_previous", "bundle_timeout", "member_extension", "base_link",
] as const;
export type CodeLayerRefusal = (typeof CODE_LAYER_REFUSALS)[number];

/** Why the server could not get an answer from the helper (the helper itself did not refuse). */
export type CodeLayerFailure =
  | "helper_missing" // the snapshot predates zs-code-apply (exit 127)
  | "fetch_failed" // the pinned object could not be read from the bucket
  | "digest_mismatch" // the object's bytes do not hash to the pinned digest
  | "too_large" // the object exceeds MAX_LAYER_BYTES
  | "upload_failed" // the file API refused or failed
  | "exec_failed" // the toolbox exec threw (timeout, transport)
  | "os_error" // the helper answered failed: os_error
  | "bad_answer"; // no JSON object, or one outside the helper's contract

export type CodeLayerOutcome =
  | { kind: "no_pin" }
  | { kind: "current"; layer: string }
  | { kind: "applied"; layer: string; previous: string | null; pruned: boolean }
  | { kind: "refused"; layer: string; refused: CodeLayerRefusal }
  | { kind: "failed"; layer: string; failed: CodeLayerFailure; exitCode?: number | null; errno?: string; step?: "status" | "install"; errorClass?: string };

export interface CodeLayerSandbox {
  exec(command: string, timeoutS: number): Promise<{ exitCode: number | null; output: string }>;
  upload(remotePath: string, content: Buffer, mode: string): Promise<void>;
}

/** A source's typed answer for an object over the limit (the server's object store answers `ObjectTooLarge`; `codeLayerSourceOf` maps it). */
export class CodeLayerTooLarge extends Error {
  constructor() {
    super("the code layer object is over MAX_LAYER_BYTES");
    this.name = "CodeLayerTooLarge";
  }
}

export interface CodeLayerSource {
  /** The object's bytes; throws `CodeLayerTooLarge` when it is over `maxBytes` and any other error when it cannot be read. */
  download(uri: string, maxBytes: number): Promise<Buffer>;
}

type HelperAnswer = { ok: true; result: string; layer?: unknown; current?: unknown; previous?: unknown; pruned?: unknown } | { ok: false; refused?: unknown; failed?: unknown; errno?: unknown };

/** The helper prints one JSON object (the toolbox mixes stdout and stderr, so the last line that starts with `{`). */
function answerOf(output: string): HelperAnswer | null {
  const line = output.split("\n").map((part) => part.trim()).reverse().find((part) => part.startsWith("{"));
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" && typeof (parsed as { ok?: unknown }).ok === "boolean" ? (parsed as HelperAnswer) : null;
  } catch {
    return null;
  }
}

const isRefusal = (value: unknown): value is CodeLayerRefusal => typeof value === "string" && (CODE_LAYER_REFUSALS as readonly string[]).includes(value);
const digestOrNull = (value: unknown): string | null => (typeof value === "string" && SHA256.test(value) ? value : null);

type Current = { current: string | null; previous: string | null } | { refused: CodeLayerRefusal } | { failed: CodeLayerFailure; exitCode?: number | null; errorClass?: string };

/** The class name of a thrown value, never its text (a transport message can quote more than a log should hold). */
const errorClassOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/**
 * What the sandbox runs now: the `current` layer's digest only when its directory is there and was built for this base (`currentBaseKeyMatches`),
 * otherwise null (no layer, a dangling link or another base's layer: each is installed again); `previous`, the layer an install replaced (null when
 * none did); or the helper's refusal; or a typed failure.
 */
export async function currentLayer(sandbox: CodeLayerSandbox): Promise<Current> {
  let result: { exitCode: number | null; output: string };
  try {
    result = await sandbox.exec(`${CODE_APPLY} status`, 30);
  } catch {
    // status only reads, so one more ask is safe; a transient toolbox error on a waking sandbox then does not fail the turn.
    try {
      result = await sandbox.exec(`${CODE_APPLY} status`, 30);
    } catch (error) {
      return { failed: "exec_failed", errorClass: errorClassOf(error) };
    }
  }
  if (result.exitCode === COMMAND_NOT_FOUND) return { failed: "helper_missing", exitCode: result.exitCode };
  const answer = answerOf(result.output);
  if (!answer) return { failed: "bad_answer", exitCode: result.exitCode };
  if (!answer.ok) return isRefusal(answer.refused) ? { refused: answer.refused } : { failed: answer.failed === "os_error" ? "os_error" : "bad_answer", exitCode: result.exitCode };
  const matches = (answer as { currentBaseKeyMatches?: unknown }).currentBaseKeyMatches;
  if (answer.result !== "status" || result.exitCode !== 0 || (answer.current !== null && digestOrNull(answer.current) === null)
    || (answer.previous != null && digestOrNull(answer.previous) === null) || ![true, false, null].includes(matches as boolean | null)) {
    return { failed: "bad_answer", exitCode: result.exitCode };
  }
  return { current: matches === true ? digestOrNull(answer.current) : null, previous: digestOrNull(answer.previous) };
}

/**
 * Brings the sandbox to the pinned layer: asks the helper what is current, and when it is not the pin, downloads the object, checks its digest
 * here (the helper checks it again), uploads it to a root-only file and runs `zs-code-apply install <sha256> <bytes>` with that file on stdin
 * (stdin is a file, so it ends after the last byte: the helper reads to the end before its trailing-byte check). The upload is removed after.
 */
export async function applyCodeLayer(pin: CodeLayerPin | null, sandbox: CodeLayerSandbox, source: CodeLayerSource): Promise<CodeLayerOutcome> {
  if (!pin) return { kind: "no_pin" };
  const layer = pin.sha256;
  const before = await currentLayer(sandbox);
  if ("refused" in before) return { kind: "refused", layer, refused: before.refused };
  if ("failed" in before) return { kind: "failed", layer, failed: before.failed, step: "status", ...(before.exitCode !== undefined ? { exitCode: before.exitCode } : {}), ...(before.errorClass ? { errorClass: before.errorClass } : {}) };
  if (before.current === layer) return { kind: "current", layer };
  let bytes: Buffer;
  try {
    bytes = await source.download(pin.uri, MAX_LAYER_BYTES);
  } catch (error) {
    return { kind: "failed", layer, failed: error instanceof CodeLayerTooLarge ? "too_large" : "fetch_failed" };
  }
  if (bytes.length > MAX_LAYER_BYTES) return { kind: "failed", layer, failed: "too_large" };
  if (createHash("sha256").update(bytes).digest("hex") !== layer) return { kind: "failed", layer, failed: "digest_mismatch" };
  try {
    await sandbox.upload(LAYER_UPLOAD, bytes, "0600");
  } catch {
    return { kind: "failed", layer, failed: "upload_failed" };
  }
  let result: { exitCode: number | null; output: string };
  try {
    // The helper's exit status is kept (`status=$?`) so the removal of the upload never hides it.
    result = await sandbox.exec(`sh -c '${CODE_APPLY} install ${layer} ${bytes.length} < ${LAYER_UPLOAD}; status=$?; rm -f ${LAYER_UPLOAD}; exit $status'`, 360);
  } catch (error) {
    return { kind: "failed", layer, failed: "exec_failed", step: "install", errorClass: errorClassOf(error) };
  }
  if (result.exitCode === COMMAND_NOT_FOUND) return { kind: "failed", layer, failed: "helper_missing", exitCode: result.exitCode };
  const answer = answerOf(result.output);
  if (!answer) return { kind: "failed", layer, failed: "bad_answer", exitCode: result.exitCode };
  if (answer.ok) {
    if (result.exitCode !== 0 || digestOrNull(answer.layer) !== layer) return { kind: "failed", layer, failed: "bad_answer", exitCode: result.exitCode };
    if (answer.result === "already_current") return { kind: "current", layer };
    if (answer.result !== "applied" || typeof answer.pruned !== "boolean") return { kind: "failed", layer, failed: "bad_answer", exitCode: result.exitCode };
    return { kind: "applied", layer, previous: digestOrNull(answer.previous), pruned: answer.pruned };
  }
  if (isRefusal(answer.refused)) return { kind: "refused", layer, refused: answer.refused };
  if (answer.failed === "os_error") return { kind: "failed", layer, failed: "os_error", exitCode: result.exitCode, ...(typeof answer.errno === "string" ? { errno: answer.errno } : {}) };
  return { kind: "failed", layer, failed: "bad_answer", exitCode: result.exitCode };
}

/**
 * With no pin: the layer the sandbox runs anyway, or null. A release or rollback that clears the layer keeps the snapshot, and the helper has no verb that
 * removes a layer, so the provider retires such a sandbox like one made from an old snapshot. A snapshot without the helper runs no layer.
 * The image's own layer is not stray: `image/oci/install-code-layer.sh` installs it as the image's first layer, so the helper names no `previous`; only a
 * layer installed over another one (the server's apply of a pin, which keeps the replaced one as `previous`) outlived its pin. Counting the own layer
 * retired every production sandbox at its first wake and made the next one from the same snapshot, which woke "stray" again (2026-11-12).
 */
export async function strayLayer(sandbox: CodeLayerSandbox): Promise<{ layer: string | null } | { refused: CodeLayerRefusal } | { failed: CodeLayerFailure; exitCode?: number | null }> {
  const now = await currentLayer(sandbox);
  if ("failed" in now && now.failed === "helper_missing") return { layer: null };
  if ("current" in now) return { layer: now.previous === null ? null : now.current };
  return now;
}

/** An outcome that leaves the sandbox on the pinned layer. */
export const onPin = (outcome: CodeLayerOutcome): boolean => outcome.kind === "no_pin" || outcome.kind === "current" || outcome.kind === "applied";

/** Thrown by a wake whose sandbox could not be brought to the pinned layer: the sandbox is not reported ready. Carries the typed outcome. */
// No parameter property: CI imports this file with Node's type stripping (image/oci/ci-code-layer.mjs), which runs only erasable TypeScript.
export class CodeLayerNotApplied extends Error {
  override readonly name = "CodeLayerNotApplied";
  readonly outcome: Exclude<CodeLayerOutcome, { kind: "no_pin" | "current" | "applied" }>;
  constructor(outcome: Exclude<CodeLayerOutcome, { kind: "no_pin" | "current" | "applied" }>) {
    super(`code layer ${outcome.layer} not applied: ${outcome.kind === "refused" ? outcome.refused : outcome.failed}`);
    this.outcome = outcome;
  }
}
