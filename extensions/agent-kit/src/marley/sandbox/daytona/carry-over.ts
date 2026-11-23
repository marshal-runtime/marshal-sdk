import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shellQuote } from "../ssh.js";
import { chatBackupPrefix, type ChatBackupStore } from "./chat-backup-store.js";
import type { RootRun } from "./provider.js";

/**
 * Chat files across a snapshot upgrade. Every chat's `work/` and `files/` (inbox, outbox, store-watch JSON, scratch) are in no repo or mirror, so they are backed up to the
 * brand's own prefix in the private chat-files bucket: a full `base` archive about once a day (`backupChatFiles` mode "base") and, at an upgrade, only the `delta` of files
 * changed since the last backup (mode "delta"). The server pulls each archive through the sandbox's root exec; the sandbox holds no credentials. The old sandbox is retired at
 * once and the new one restores base + deltas, in order, under its new chat accounts. Videos are left out (a sent one is an artifact in GCS), except those in a chat's `files/outbox` that the server's send records do not cover (a built video not yet sent exists nowhere else): those
 * are archived by name; neither are the caches the tools rebuild. A deleted file comes back when a restore replays an older archive: the backup is of what existed, it does not track removals.
 */

/** Bounds on one archive's compressed size and its files: a runaway folder fails the archive (and so the upgrade) loudly rather than filling the server's memory. */
export const CARRY_MAX_BYTES = 1024 * 1024 * 1024;
export const CARRY_MAX_FILES = 100_000;
/** A delta starts this far before the last backup's start, so a file written during that backup is in the next one. */
const DELTA_SLACK_S = 2;
const CHAT_ID = /^[a-f0-9]{64}$/;
export const BASE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** One archive in the bucket. `at` is the sandbox clock (epoch seconds) when its scan started. */
export interface BackupEntry { object: string; kind: "base" | "delta"; at: number; files: number; tarBytes: number; sha256: string; chats: string[] }
/** The brand's backup: a base, then the deltas since it, oldest first. Stored as `<prefix>manifest.json` and, for an upgrade, as the pending-restore record on the server's disk. */
export interface CarryManifest { v: 2; brandId: string; entries: BackupEntry[]; chats: string[]; files: number }

export interface SandboxFiles {
  download(remotePath: string): Promise<Buffer>;
  upload(remotePath: string, content: Buffer, mode: string): Promise<void>;
}

/** `detail` is a fixed code the upgrade's refusal log carries (the message itself is withheld from logs). */
const refuse = (name: string, message: string, detail?: string, extra: Record<string, number> = {}): Error => Object.assign(new Error(message), { name, ...(detail ? { detail } : {}), ...extra });
const EXIT_DETAIL: Record<number, string> = { 3: "bad_chat_entry", 4: "special_file", 5: "over_bounds", 6: "unsent_media_missing" };
/** The fixed codes a carry refusal's `detail` can hold; the upgrade state in `brand-runtime status` keeps only these (a record path is logged, never reported). */
export const CARRY_DETAILS: readonly string[] = [...Object.values(EXIT_DETAIL), "archive_failed", "media_scan_failed"];

/**
 * Caches the tools rebuild on use: never backed up, and removed from the old sandbox at the start of an upgrade's archive (before the upgrade can still be refused,
 * so only what any next use rebuilds by itself belongs here). The video renderer's browser (~250-290 MB, under `video-browser` or Remotion's own `.remotion`) and
 * each render job's copy of the renderer bundle (`video/jobs/<job>/serve`, ~10 MB a job).
 */
export const CARRY_PURGE_CACHES = ["video-browser", ".remotion", "video/jobs/*/serve"] as const;
/**
 * Work in a chat's work folder that is never backed up or carried and never a reason to refuse an upgrade (decisions.md 2026-11-09: disposable
 * video/browser/copycat/download/build/edit work never travels): the purged caches, plus the downloaded footage and sites (`okoa_dl`, `ref_dl`, `site_dl`),
 * a routine edit's scratch copy (`routine-edit`), the copycat's runs (`copycat/<brand>/copycats/<run>`: analysis, renders and every sampled frame of
 * the reference as PNG, 1.6 GB for one ad on production Biovelvet) and its HyperFrames and OCR caches. These are kept in place on the old sandbox, which still serves
 * the brand when the upgrade is refused later; the new sandbox starts without them. The rest of `work/copycat` travels: the brand kit the owner gave
 * (`<brand>/brand.json`, brief, fonts, logos), the footage index and Drive state, the not-deliverable hash ledger the outbox reader checks and the Meta page
 * cursors. The copycat's deliverable is copied to `files/outbox`, which travels.
 */
export const CARRY_SKIP_CACHES = [...CARRY_PURGE_CACHES, "copycat/*/copycats", "copycat/.hyperframes-cache", "copycat/.hyperframes-history", "copycat/.tessdata-cache", "okoa_dl", "ref_dl", "site_dl", "routine-edit"] as const;
/**
 * Video files are left out of a chat backup, because a video the server has sent is in GCS (the artifact store copies it after the gateway accepted the send). A video in a chat's
 * `files/outbox` that no send record covers is not: the 2026-11-11 staging run lost a built morning brief this way. Those are listed (`outboxVideosScript`), checked against the
 * server's own send records and put in by name (`ArchiveOptions.include`); every other video stays out.
 */
export const BACKUP_SKIP_VIDEO_NAMES = ["*.mp4", "*.mov", "*.m4v", "*.webm", "*.mkv"] as const;
/** Whether a file name is one of the video names the chat backup leaves out (and the outbox scan lists). */
export const isBackupSkippedVideo = (name: string): boolean => BACKUP_SKIP_VIDEO_NAMES.some((pattern) => name.toLowerCase().endsWith(pattern.slice(1)));
export const CARRY_REFUSED = "CarryOverRefused";
/**
 * Limits on the unsent outbox videos one backup carries, because a chat owns its outbox (its file names, count, sizes and modification times) and must not be able to refuse the whole
 * brand's upgrade with them. An unsent video older than the age limit (a built video is for a send within a day; a template offer lasts 26 hours), and one beyond a chat's or the brand's
 * budget (newest first), is not carried and is logged by name with a typed reason (`released`: `aged`, `over_budget`, `unsafe_name`), never silently. A name with a control character, a line separator or bytes that are not UTF-8 is `unsafe_name`.
 */
export const OUTBOX_VIDEO_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const OUTBOX_VIDEO_CHAT_MAX_BYTES = 160 * 1024 * 1024;
export const OUTBOX_VIDEO_CHAT_MAX_FILES = 40;
export const OUTBOX_VIDEO_TOTAL_MAX_BYTES = 400 * 1024 * 1024;

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
// Braces, not a subshell: `$(( ...` would be read as arithmetic by dash.
const HASH = `{ sha256sum "$f" 2>/dev/null || shasum -a 256 "$f"; } | cut -d' ' -f1`;

export interface ArchiveOptions {
  limits?: { files: number; bytes: number };
  tag?: string;
  /** Only files changed after this epoch second (a delta); absent is a full base. */
  since?: number;
  /** Remove the rebuildable caches first (the upgrade, which retires the sandbox); a daily backup of a live sandbox leaves them alone. */
  purge?: boolean;
  /**
   * Outbox videos no send record covers, as `<chat id>/files/outbox/<path>`: taken whatever their modification time (a staged copy keeps its builder's) and whatever the delta's
   * reference time, and the archive fails (exit 6) when one is gone or not a plain file rather than going without it.
   */
  include?: readonly string[];
}

const INCLUDE_PATH = /^[a-f0-9]{64}\/files\/outbox\/[^\0\n]+$/;

/**
 * Runs as root: every video under a chat's `files/outbox`, one `<modification time in epoch seconds> <size in bytes> <path in hex>` line each. The path is hex so that no name a chat
 * chooses (a line break, a carriage return, bytes that are not UTF-8) can break the listing; `unsentOutboxVideos` decodes it and releases a name that cannot be carried safely. A chat
 * folder that is not a chat id is the archive's to refuse (exit 3), not this scan's.
 */
export function outboxVideosScript(chats: string): string {
  const names = BACKUP_SKIP_VIDEO_NAMES.map((name) => `-iname '${name}'`).join(" -o ");
  const each = `for f; do printf "%s %s %s\\n" "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")" "$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f")" "$(printf %s "$f" | od -An -v -tx1 | tr -d ' \\n')"; done`;
  return [
    "set -eu",
    `chats=${shellQuote(chats)}`,
    `if [ ! -e "$chats" ] && [ ! -L "$chats" ]; then exit 0; fi`,
    `[ -d "$chats" ] && [ ! -L "$chats" ] || exit 3`,
    `cd "$chats"`,
    `for c in *; do`,
    `  [ -e "$c" ] || continue`,
    `  case "$c" in *[!a-f0-9]*) continue;; esac`,
    `  [ "\${#c}" -eq 64 ] || continue`,
    `  if [ -d "$c/files/outbox" ] && [ ! -L "$c/files/outbox" ]; then find "$c/files/outbox" -type f \\( ${names} \\) -exec sh -c ${shellQuote(each)} sh {} +; fi`,
    `done`,
  ].join("\n");
}

/**
 * Runs as root in the sandbox. Exit 3: a chat folder or work/files entry that is a link or has a name outside the chat id charset; 4: a link, device, pipe, socket or hard link inside;
 * 5: over the bounds. Prints `{"none":true}` when there is nothing to back up, `{"empty":true,"at":N}` for a delta with no changed file, else the entry fields and the private
 * folder the archive is in.
 */
export function archiveScript(chats: string, options: ArchiveOptions = {}): string {
  const limits = options.limits ?? { files: CARRY_MAX_FILES, bytes: CARRY_MAX_BYTES };
  const since = options.since;
  if (since !== undefined && !Number.isSafeInteger(since)) throw new Error("since must be an integer");
  const videoNames = BACKUP_SKIP_VIDEO_NAMES.map((name) => `! -iname '${name}'`).join(" ");
  // The caches are left out of every archive, not only removed at an upgrade: a live sandbox's daily backup would otherwise carry them (Archie's held 264 render-bundle files).
  const cacheSkips = CARRY_SKIP_CACHES.map((cache) => `! -path '*/work/${cache}' ! -path '*/work/${cache}/*'`).join(" ");
  const newer = since === undefined ? "" : ` -newer "$ref"`;
  const include = options.include ?? [];
  for (const entry of include) if (!INCLUDE_PATH.test(entry) || entry.split("/").includes("..")) throw new Error("an included outbox path is not a chat's outbox file");
  return [
    "set -eu",
    `chats=${shellQuote(chats)}`,
    `if [ ! -e "$chats" ] && [ ! -L "$chats" ]; then echo '{"none":true}'; exit 0; fi`,
    `[ -d "$chats" ] && [ ! -L "$chats" ] || exit 3`,
    `out=$(mktemp -d /var/tmp/zs-carry${options.tag ?? ""}.XXXXXX)`,
    `chmod 700 "$out"`,
    `trap 'rc=$?; if [ $rc -ne 0 ]; then rm -rf "$out"; fi' EXIT`,
    `at=$(date +%s)`,
    `cd "$chats"`,
    `: > "$out/dirs"; : > "$out/chats"`,
    `for c in *; do`,
    `  [ -e "$c" ] || [ -L "$c" ] || continue`,
    `  if [ -L "$c" ]; then exit 3; fi`,
    `  case "$c" in *[!a-f0-9]*) exit 3;; esac`,
    `  [ "\${#c}" -eq 64 ] || exit 3`,
    `  [ -d "$c" ] || exit 3`,
    // Found by `find`, which never follows a link, rather than a shell glob, which would follow a chat's link in a middle folder and remove files elsewhere as root.
    ...(options.purge ? [`  if [ -d "$c/work" ] && [ ! -L "$c/work" ]; then find "$c/work" -mindepth 1 \\( ${CARRY_PURGE_CACHES.map((cache) => `-path "$c/work/${cache}"`).join(" -o ")} \\) -type d -prune -exec rm -rf {} +; fi`] : []),
    `  for s in work files; do`,
    `    if [ -L "$c/$s" ]; then exit 3; fi`,
    `    if [ -d "$c/$s" ]; then echo "$c/$s" >> "$out/dirs"; fi`,
    `  done`,
    `done`,
    ...(since === undefined ? [] : [
      `ref="$out/ref"`,
      `touch -d "@${since - DELTA_SLACK_S}" "$ref" 2>/dev/null || touch -t "$(date -r ${since - DELTA_SLACK_S} +%Y%m%d%H%M.%S)" "$ref"`,
    ]),
    `: > "$out/list"; files=0`,
    `while IFS= read -r p; do`,
    `  bad=$(find "$p" \\( -type l -o \\( ! -type f ! -type d \\) -o \\( -type f -links +1 \\) \\) ${cacheSkips} -print -quit)`,
    `  [ -z "$bad" ] || exit 4`,
    `  find "$p" -type d ${cacheSkips} -print0 >> "$out/list"`,
    `  find "$p" -type f ${videoNames} ${cacheSkips}${newer} -print0 >> "$out/list"`,
    `  n=$(find "$p" -type f ${videoNames} ${cacheSkips}${newer} | wc -l); files=$((files + n))`,
    `done < "$out/dirs"`,
    ...include.flatMap((entry) => [`[ -f ${shellQuote(entry)} ] && [ ! -L ${shellQuote(entry)} ] || exit 6`, `printf '%s\\0' ${shellQuote(entry)} >> "$out/list"; files=$((files + 1))`]),
    `if [ "$files" -eq 0 ]; then rm -rf "$out"; ${since === undefined ? `echo '{"none":true}'` : `printf '{"empty":true,"at":%s}\\n' "$at"`}; exit 0; fi`,
    `if [ "$files" -gt ${limits.files} ]; then printf '{"over":true,"files":%s,"kib":0}\\n' "$files"; exit 5; fi`,
    `f="$out/carry.tar.gz"`,
    `tar -czf "$f" --no-recursion --null -T "$out/list"`,
    `sum=$(${HASH})`,
    `bytes=$(wc -c < "$f" | tr -d ' ')`,
    `if [ "$bytes" -gt ${limits.bytes} ]; then printf '{"over":true,"files":%s,"kib":%s}\\n' "$files" "$((bytes / 1024))"; exit 5; fi`,
    `tr '\\0' '\\n' < "$out/list" | cut -d/ -f1 | sort -u | tr '\\n' ' ' > "$out/chats"`,
    `printf '{"dir":"%s","at":%s,"files":%s,"tarBytes":%s,"sha256":"%s","chats":"%s"}\\n' "$out" "$at" "$files" "$bytes" "$sum" "$(cat "$out/chats")"`,
  ].join("\n");
}

/**
 * Runs as root in the new sandbox after every chat account exists: checks the uploaded archive's hash and that every member is `<chat>/work|files/...` with no `..` or absolute
 * name and that it holds the files its record says, extracts without taking the owners, and gives each chat's folders to that chat's own account (the numbers `ls -ln` shows for
 * the chat's home).
 */
export function restoreScript(chats: string, dir: string, expect: { sha256: string; files: number; chats: string[] }): string {
  const pattern = "^[a-f0-9]{64}/(work|files)(/.*)?$";
  return [
    "set -eu",
    `chats=${shellQuote(chats)}; dir=${shellQuote(dir)}; f="$dir/carry.tar.gz"`,
    `[ -d "$chats" ] && [ ! -L "$chats" ] && [ -f "$f" ] && [ ! -L "$f" ] || exit 3`,
    `sum=$(${HASH})`,
    `[ "$sum" = ${shellQuote(expect.sha256)} ] || exit 4`,
    `tar -tzf "$f" > "$dir/members"`,
    `if grep -Ev ${shellQuote(pattern)} "$dir/members" | grep -q . ; then exit 5; fi`,
    `if grep -E '(^|/)\\.\\.(/|$)' "$dir/members" | grep -q . ; then exit 5; fi`,
    `n=$(grep -vc '/$' "$dir/members" || true)`,
    `[ "$n" -eq ${expect.files} ] || exit 7`,
    `cd "$chats"`,
    `for c in ${expect.chats.map(shellQuote).join(" ")}; do [ -d "$c" ] && [ ! -L "$c" ] || exit 6; done`,
    `tar -xpzf "$f" --no-same-owner`,
    `for c in ${expect.chats.map(shellQuote).join(" ")}; do`,
    `  ids=$(ls -ldn "$c" | awk '{print $3":"$4}')`,
    `  for s in work files; do`,
    `    if [ -d "$c/$s" ]; then chown -hR "$ids" "$c/$s"; fi`,
    `  done`,
    `done`,
    `rm -rf "$dir"`,
    `echo ok`,
  ].join("\n");
}

const carryDir = (stateDir: string, brandId: string): string => path.join(stateDir, "carry", brandId);
const manifestObject = (brandId: string): string => `${chatBackupPrefix(brandId)}manifest.json`;
const OBJECT = /^chat-files\/[0-9a-f-]{36}\/(base|delta)-\d{1,12}-[a-f0-9]{16}\.tar\.gz$/;

function summarize(brandId: string, entries: BackupEntry[]): CarryManifest {
  return { v: 2, brandId, entries, chats: [...new Set(entries.flatMap((entry) => entry.chats))].sort(), files: entries.reduce((sum, entry) => sum + entry.files, 0) };
}

function validEntries(brandId: string, value: unknown, where: string): BackupEntry[] {
  const record = value as { v?: unknown; brandId?: unknown; entries?: unknown } | null;
  if (!record || record.v !== 2 || record.brandId !== brandId || !Array.isArray(record.entries) || record.entries.length === 0) throw refuse(CARRY_REFUSED, `${where} is malformed`);
  const entries = record.entries as BackupEntry[];
  const prefix = chatBackupPrefix(brandId);
  entries.forEach((entry, index) => {
    if (!entry || typeof entry.object !== "string" || !entry.object.startsWith(prefix) || !OBJECT.test(entry.object) || entry.kind !== (index === 0 ? "base" : "delta") || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !Number.isSafeInteger(entry.at) || !Number.isSafeInteger(entry.files) || !Number.isSafeInteger(entry.tarBytes) || !Array.isArray(entry.chats) || !entry.chats.every((chat) => CHAT_ID.test(chat))) throw refuse(CARRY_REFUSED, `${where} is malformed`);
  });
  return entries;
}

/** The record the last archive step left for the new sandbox, or null when there is none. Throws (`CarryOverRefused`) when a record exists and cannot be used: nothing is restored by guessing it away. */
export function readPendingCarry(stateDir: string, brandId: string): { manifest: CarryManifest } | null {
  let text: string;
  try { text = fs.readFileSync(path.join(carryDir(stateDir, brandId), "carry.json"), "utf8"); } catch (error) {
    // No record at all is the only "nothing pending"; a record that cannot be read is a refusal that keeps it for the next attempt.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw refuse(CARRY_REFUSED, `the pending restore record could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`, path.join(carryDir(stateDir, brandId), "carry.json"));
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw refuse(CARRY_REFUSED, "the pending restore record is not valid JSON", path.join(carryDir(stateDir, brandId), "carry.json")); }
  return { manifest: summarize(brandId, validEntries(brandId, raw, "a pending restore record")) };
}

/** Drops this attempt's pending-restore record when the attempt is refused before the old sandbox is retired (the sandbox still holds every original; the bucket copies stay as a valid backup). */
export function dropUnusedCarry(stateDir: string, brandId: string): void {
  fs.rmSync(path.join(carryDir(stateDir, brandId), "carry.json"), { force: true });
}

function writePending(stateDir: string, manifest: CarryManifest): void {
  const dir = carryDir(stateDir, manifest.brandId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  // Written aside and renamed in, so a crash mid-write leaves the previous record (or none), never a truncated one that now refuses every restore.
  const record = path.join(dir, "carry.json");
  const aside = `${record}.${process.pid}.tmp`;
  const fd = fs.openSync(aside, "w", 0o600);
  try { fs.writeSync(fd, Buffer.from(JSON.stringify(manifest))); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(aside, record);
}

const inflight = new Map<string, Promise<unknown>>();
/** One backup or upgrade archive of a brand at a time, so two never write the manifest over each other. */
function serial<T>(brandId: string, work: () => Promise<T>): Promise<T> {
  const run = (inflight.get(brandId) ?? Promise.resolve()).catch(() => undefined).then(work);
  const tail = run.catch(() => undefined);
  inflight.set(brandId, tail);
  void tail.then(() => { if (inflight.get(brandId) === tail) inflight.delete(brandId); });
  return run;
}

export async function readBackup(store: ChatBackupStore, brandId: string): Promise<CarryManifest | null> {
  let raw: unknown;
  try { raw = await store.getJson(manifestObject(brandId)); } catch (error) { throw refuse(CARRY_REFUSED, `the chat-files backup record could not be read (${error instanceof Error ? error.message : "error"})`); }
  return raw === null ? null : summarize(brandId, validEntries(brandId, raw, "the chat-files backup record"));
}

/**
 * Makes the brand's stored chat-files backup (base, then deltas) the pending restore of its next new sandbox: the record an upgrade's carry writes, for a
 * sandbox that can no longer be read (Daytona marks it unrecoverable). A pending record already there (an upgrade's own carry) is kept. Returns how many
 * archives are pending (0: the brand has no backup). Throws (`CarryOverRefused`) when the backup record cannot be read.
 */
export async function queueBackupRestore(input: { brandId: string; store: ChatBackupStore; stateDir: string }): Promise<number> {
  return serial(input.brandId, async () => {
    const pending = readPendingCarry(input.stateDir, input.brandId);
    if (pending) return pending.manifest.entries.length;
    const backup = await readBackup(input.store, input.brandId);
    if (!backup || backup.entries.length === 0) return 0;
    writePending(input.stateDir, backup);
    return backup.entries.length;
  });
}

/** An outbox video left behind, with why: older than OUTBOX_VIDEO_MAX_AGE_MS (`aged`), beyond a chat's or the brand's budget (`over_budget`), or named with a control character, a line separator or bytes that are not UTF-8 (`unsafe_name`: no file name). */
export interface Released { reason: "aged" | "over_budget" | "unsafe_name"; chat: string; file?: string; ageDays?: number; bytes?: number }
/** `released`: one entry per video left behind, so the caller logs every one with a code. */
export interface MediaCounts { carried: number; sent: number; released: Released[] }

export interface BackupInput {
  brandId: string; chats: string; root: RootRun; files: SandboxFiles; store: ChatBackupStore; stateDir: string; tag?: string; now?: () => number; limits?: { files: number; bytes: number };
  /** Whether the server's own records say a chat's outbox file was sent (or may have been: an unknown outcome is never sent again). An outbox video it does not cover is carried. Absent: no outbox video is. */
  sentMedia?: (chat: string, name: string, modifiedMs: number) => boolean;
  /** Called with what became of the outbox videos: carried (no send record), left out because a send record covers them (`sent`), or left behind with a reason (`released`, see OUTBOX_VIDEO_MAX_AGE_MS and the budgets). */
  onMedia?(counts: MediaCounts): void;
  /**
   * Called after the archive is stored, with the archive on the server's disk and the outbox videos it carries (`<chat>/files/outbox/<name>`): a built video no
   * send covers is kept as a brand file too (cross-chat order, 2026-11-12), so any chat of the brand can send it by id. A failure is reported to `keepFailed`, never fails the backup.
   */
  keepCarried?(archive: string, carried: readonly string[]): Promise<void>;
  keepFailed?(error: unknown): void;
}

/**
 * The outbox videos to carry: those under `files/outbox` whose file name the server has no send record for. Throws (`CarryOverRefused`, detail `media_scan_failed`) when the scan cannot run or
 * answers anything but plain paths, so a video is never left behind because the list was unreadable.
 */
export async function unsentOutboxVideos(root: RootRun, chats: string, sentMedia: (chat: string, name: string, modifiedMs: number) => boolean, now: number): Promise<MediaCounts & { carry: string[] }> {
  const failed = (why: string): Error => refuse(CARRY_REFUSED, `the outbox videos could not be listed (${why})`, "media_scan_failed");
  const result = await root(outboxVideosScript(chats)).catch((error: unknown) => { throw failed(error instanceof Error ? error.message : "exec failed"); });
  if (result.code !== 0) throw failed(`exit ${result.code}`);
  const lines = result.stdout.split("\n").filter((line) => line !== "");
  const released: Released[] = [];
  const listed: { path: string; modifiedMs: number; bytes: number }[] = [];
  for (const line of lines) {
    const match = /^(\d{1,12}) (\d{1,15}) ((?:[0-9a-f]{2})+)$/.exec(line);
    if (!match) throw failed("an unreadable line");
    const raw = Buffer.from(match[3]!, "hex");
    const chat = raw.subarray(0, 64).toString("latin1");
    if (!/^[a-f0-9]{64}$/.test(chat)) throw failed("an unreadable line");
    const text = raw.toString("utf8");
    // A name with a control character or line separator, or bytes that are not UTF-8, cannot be put into the archive list safely (nor named in the server's records): released with its code.
    if (!Buffer.from(text, "utf8").equals(raw) || /[\u0000-\u001f\u007f\u2028\u2029]/.test(text)) { released.push({ reason: "unsafe_name", chat, bytes: Number(match[2]) }); continue; }
    if (!INCLUDE_PATH.test(text)) throw failed("an unreadable line");
    listed.push({ path: text, modifiedMs: Number(match[1]) * 1000, bytes: Number(match[2]) });
  }
  const nameOf = (entry: { path: string }): string => entry.path.slice(entry.path.lastIndexOf("/") + 1);
  const unsent = listed.filter((entry) => !sentMedia(entry.path.slice(0, 64), nameOf(entry), entry.modifiedMs));
  // Fair selection under the brand's budget: every chat's newest candidate is considered before anyone's second (a modification time in the future counts as now), and within a round the
  // smaller file first, so one chat's large or numerous files cannot take another chat's brief; a chat is also held to its own file and byte caps. Only candidates younger than the age
  // limit compete (a chat whose videos are all aged takes nothing); what does not fit is released with its reason.
  const carry: string[] = [];
  const queues = new Map<string, typeof unsent>();
  for (const entry of [...unsent].sort((left, right) => Math.min(right.modifiedMs, now) - Math.min(left.modifiedMs, now) || left.path.localeCompare(right.path))) {
    const chat = entry.path.slice(0, 64);
    const ageDays = Math.floor(Math.max(0, now - entry.modifiedMs) / 86_400_000);
    if (now - entry.modifiedMs > OUTBOX_VIDEO_MAX_AGE_MS) { released.push({ reason: "aged", chat, file: nameOf(entry), ageDays, bytes: entry.bytes }); continue; }
    queues.set(chat, [...(queues.get(chat) ?? []), entry]);
  }
  const perChat = new Map<string, { files: number; bytes: number }>();
  let total = 0;
  for (let round = 0; ; round++) {
    const turn = [...queues.values()].filter((queue) => queue.length > round).map((queue) => queue[round]!).sort((left, right) => left.bytes - right.bytes || left.path.localeCompare(right.path));
    if (turn.length === 0) break;
    for (const entry of turn) {
      const chat = entry.path.slice(0, 64);
      const used = perChat.get(chat) ?? { files: 0, bytes: 0 };
      const ageDays = Math.floor(Math.max(0, now - entry.modifiedMs) / 86_400_000);
      if (used.files + 1 > OUTBOX_VIDEO_CHAT_MAX_FILES || used.bytes + entry.bytes > OUTBOX_VIDEO_CHAT_MAX_BYTES || total + entry.bytes > OUTBOX_VIDEO_TOTAL_MAX_BYTES) released.push({ reason: "over_budget", chat, file: nameOf(entry), ageDays, bytes: entry.bytes });
      else { carry.push(entry.path); perChat.set(chat, { files: used.files + 1, bytes: used.bytes + entry.bytes }); total += entry.bytes; }
    }
  }
  return { carry, carried: carry.length, sent: listed.length - unsent.length, released };
}
export type BackupOutcome = { result: "none" } | { result: "fresh" } | { result: "base" | "delta" | "unchanged"; manifest: CarryManifest; bytes: number };

/**
 * Backs the brand's chat files up to its prefix in the bucket. `mode: "base"` is the daily full backup of a live sandbox (skipped as "fresh" when the stored base is younger than a day
 * unless `force`); `mode: "delta"` is the upgrade's: files changed since the last stored archive, then a pending-restore record on the server's disk for the new sandbox.
 * Throws (name `CarryOverRefused`) when anything cannot be archived whole or stored; the caller then keeps the old sandbox.
 */
export function backupChatFiles(input: BackupInput & { mode: "base" | "delta"; force?: boolean }): Promise<BackupOutcome> {
  return serial(input.brandId, async () => {
    const now = input.now ?? Date.now;
    const existing = await readBackup(input.store, input.brandId);
    const base = input.mode === "base" || !existing;
    if (input.mode === "base" && existing && !input.force && now() - existing.entries[0]!.at * 1000 < BASE_MAX_AGE_MS) return { result: "fresh" };
    const since = base ? undefined : existing!.entries[existing!.entries.length - 1]!.at;
    const media = input.sentMedia ? await unsentOutboxVideos(input.root, input.chats, input.sentMedia, now()) : { carry: [], carried: 0, sent: 0, released: [] };
    const include = media.carry;
    if (input.sentMedia) input.onMedia?.({ carried: media.carried, sent: media.sent, released: media.released });
    const script = archiveScript(input.chats, { limits: input.limits, tag: input.tag, since, purge: input.mode === "delta", include });
    const result = await input.root(script).catch((error: unknown) => { throw refuse(CARRY_REFUSED, `the chat files could not be archived (${error instanceof Error ? error.message : "exec failed"})`); });
    if (result.code !== 0) {
      let over: { files?: unknown; kib?: unknown } = {};
      if (result.code === 5) try { over = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}"); } catch { /* the counts are only for the log */ }
      const counts: Record<string, number> = Number.isSafeInteger(over.files) && Number.isSafeInteger(over.kib) ? { carryFiles: over.files as number, carryKib: over.kib as number } : {};
      throw refuse(CARRY_REFUSED, `the chat files cannot be backed up (exit ${result.code})`, EXIT_DETAIL[result.code ?? -1] ?? "archive_failed", counts);
    }
    let report: { none?: boolean; empty?: boolean; at?: number; dir?: string; files?: number; tarBytes?: number; sha256?: string; chats?: string };
    try { report = JSON.parse(result.stdout.trim().split("\n").pop() ?? ""); } catch { throw refuse(CARRY_REFUSED, "the archive report cannot be read"); }
    if (report.none) return { result: "none" };
    if (report.empty) {
      // A delta with nothing new: the stored archives are the whole backup. The pending record is what the new sandbox restores from.
      if (input.mode === "delta" && existing) { writePending(input.stateDir, existing); return { result: "unchanged", manifest: existing, bytes: 0 }; }
      return { result: "none" };
    }
    const dir = report.dir ?? "";
    const dirOk = /^\/var\/tmp\/zs-carry(-[a-z0-9]+)?\.[A-Za-z0-9]+$/.test(dir);
    const cleanup = async (): Promise<void> => { if (dirOk) await input.root(`rm -rf ${shellQuote(dir)}`).catch(() => undefined); };
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zs-chatbackup-"));
    try {
      const chats = (report.chats ?? "").split(" ").filter(Boolean);
      if (!dirOk || typeof report.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(report.sha256) || !Number.isSafeInteger(report.files) || !Number.isSafeInteger(report.tarBytes) || !Number.isSafeInteger(report.at)
        || chats.length === 0 || !chats.every((chat) => CHAT_ID.test(chat))) throw refuse(CARRY_REFUSED, "the archive report is invalid");
      if (report.tarBytes! > (input.limits?.bytes ?? CARRY_MAX_BYTES)) throw refuse(CARRY_REFUSED, "the archive is over the size bound");
      const data = await input.files.download(`${dir}/carry.tar.gz`);
      if (data.length !== report.tarBytes || sha256(data) !== report.sha256) throw refuse(CARRY_REFUSED, "the downloaded archive does not match what the sandbox made");
      const kind = base ? "base" : "delta";
      const entry: BackupEntry = { object: `${chatBackupPrefix(input.brandId)}${kind}-${report.at}-${report.sha256.slice(0, 16)}.tar.gz`, kind, at: report.at!, files: report.files!, tarBytes: data.length, sha256: report.sha256, chats };
      const file = path.join(scratch, "a.tar.gz");
      fs.writeFileSync(file, data, { mode: 0o600 });
      await input.store.put(entry.object, file).catch((error: unknown) => { throw refuse(CARRY_REFUSED, `the archive could not be stored (${error instanceof Error ? error.message : "error"})`); });
      const manifest = summarize(input.brandId, base ? [entry] : [...existing!.entries, entry]);
      await input.store.putJson(manifestObject(input.brandId), manifest).catch((error: unknown) => { throw refuse(CARRY_REFUSED, `the backup record could not be stored (${error instanceof Error ? error.message : "error"})`); });
      // The new base replaces the old chain: the old objects are no longer in the record, so they go (best effort: an orphan is harmless, only storage).
      if (base && existing) for (const old of existing.entries) await input.store.remove(old.object).catch(() => undefined);
      if (input.keepCarried && media.carry.length > 0) await input.keepCarried(file, media.carry).catch((error: unknown) => input.keepFailed?.(error));
      if (input.mode === "delta") writePending(input.stateDir, manifest);
      return { result: base ? "base" : "delta", manifest, bytes: data.length };
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); await cleanup(); }
  });
}

/** The upgrade's step: archives what changed since the last backup (a full base when there is none) and records what the new sandbox restores. Null when no chat holds a file. */
export async function archiveChatFiles(input: BackupInput): Promise<CarryManifest | null> {
  const outcome = await backupChatFiles({ ...input, mode: "delta" });
  return "manifest" in outcome ? outcome.manifest : null;
}

/** Puts the pending backup (base, then deltas) into the new sandbox. Returns false when none is pending. Throws (`CarryOverRefused`) on any failure; the record stays for the next attempt. */
export async function restoreChatFiles(input: { brandId: string; chats: string; root: RootRun; files: SandboxFiles; stateDir: string; store: ChatBackupStore; ensureChat(chat: string): Promise<void> }): Promise<{ entries: number; files: number } | false> {
  const pending = readPendingCarry(input.stateDir, input.brandId);
  if (!pending) return false;
  const { manifest } = pending;
  for (const chat of manifest.chats) await input.ensureChat(chat);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zs-chatrestore-"));
  try {
    for (const entry of manifest.entries) {
      const file = path.join(scratch, "a.tar.gz");
      await input.store.get(entry.object, file).catch((error: unknown) => { throw refuse(CARRY_REFUSED, `a stored archive could not be read (${error instanceof Error ? error.message : "error"})`); });
      const data = fs.readFileSync(file);
      if (data.length !== entry.tarBytes || sha256(data) !== entry.sha256) throw refuse(CARRY_REFUSED, "a stored archive does not match its record");
      const dir = `/var/tmp/zs-carry-${entry.sha256.slice(0, 16)}`;
      await input.files.upload(`${dir}/carry.tar.gz`, data, "0600");
      const result = await input.root(restoreScript(input.chats, dir, { sha256: entry.sha256, files: entry.files, chats: entry.chats })).catch((error: unknown) => { throw refuse(CARRY_REFUSED, `the chat files could not be restored (${error instanceof Error ? error.message : "exec failed"})`); });
      if (result.code !== 0 || result.stdout.trim().split("\n").pop() !== "ok") throw refuse(CARRY_REFUSED, `the chat files could not be restored (exit ${result.code})`);
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  fs.rmSync(path.join(carryDir(input.stateDir, input.brandId), "carry.json"), { force: true });
  return { entries: manifest.entries.length, files: manifest.files };
}
