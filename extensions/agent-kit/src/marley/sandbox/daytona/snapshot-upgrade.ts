import { UA_DURABLE_PATTERNS, UA_SCRATCH_PATTERNS } from "../../routine-state/ua-files.js";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { syncRuntimeRepo, verifyRuntimeSource } from "../../brand-runtime-repo.js";
import type { BrandMirror, DivergedArchiveResult, MirrorVm } from "../../mirror/mirror.js";
import { OperationError } from "../../operation-error.js";
import { shellQuote, type ExecResult } from "../ssh.js";
import type { SshTarget } from "../ssh-target.js";
import { archiveChatFiles, backupChatFiles, dropUnusedCarry, queueBackupRestore, restoreChatFiles, type MediaCounts, type SandboxFiles } from "./carry-over.js";
import type { ChatBackupStore } from "./chat-backup-store.js";
import { CAPTURE_REFUSED, NOT_ROOT_REFUSED, WORK_FILES_REFUSED, DIVERGED_ARCHIVE_FAILED, type DivergedArchive, type RootRun, type SnapshotUpgrade, type UpgradeHoldMode, type WorkFileScope } from "./provider.js";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;

export interface SnapshotUpgradeDeps {
  /** Runs a command on the sandbox as the brand user (leased, so the sandbox is not stopped meanwhile). */
  run(target: SshTarget, brandId: string, command: string, options?: { stdin?: string | Buffer; timeoutMs?: number }): Promise<ExecResult>;
  mirror: BrandMirror;
  /** Keeps a VM history the mirror cannot follow (the mirror's `archiveDiverged`): required, so no wiring can leave a diverged sandbox unarchivable. */
  archiveDiverged(brandId: string, vm: MirrorVm): Promise<DivergedArchiveResult>;
  /** The folder with one bare repo per brand (`<brand id>.git`). */
  mirrorDir: string;
  repoDir(brandId: string): string;
  /** Folders whose files are in neither the repo nor the mirror (the brand's work and files folders, `.marshal/` in the repo): a rebuild would lose them. */
  workDirs(brandId: string): string[];
  /** The folder holding every chat's home (`chats/<id>`, 0700, owned by the chat's own user); each chat's `work` folder is checked there, as root. */
  chatsRoot(brandId: string): string;
  /**
   * Commits the routine state of every chat of the brand to the server's store (routine state, D121): UA's durable files, and store-watch's files from before the
   * server kept them when the store has none yet. Throws when one cannot be kept. Called inside the hold, before the work-file check. Returns the routines whose
   * `work/<routine>` folders are now held by the store, so the check lets them go with the sandbox. `chats` are the chat ids whose home holds a routine file (one
   * root scan, `routineChats`); only those are logged into, so a brand with hundreds of chats fits the upgrade's window.
   */
  capture?(brandId: string, target: SshTarget, chats: ReadonlySet<string>): Promise<{ secured: string[] } | void>;
  /** The server's own state folder: the record of which stored archives the new sandbox restores waits in `<stateDir>/carry/<brand id>/` between the old sandbox's deletion and the restore. */
  stateDir: string;
  /** Where chat files are backed up (the brand's prefix in the private chat-files bucket). */
  chatBackup: ChatBackupStore;
  /**
   * Whether the server's own records say the outbox file `name` of chat `chat` (its 64-hex folder id), last written at `modifiedMs`, was sent, or may have been (an unknown outcome is never repeated). An outbox video it does
   * not cover is carried, because a built video that was never sent exists nowhere else. Typed records only: never a file-name pattern.
   */
  sentMedia(brandId: string): (chat: string, name: string, modifiedMs: number) => boolean;
  /** Keeps the outbox videos an archive carries as brand files (see BackupInput.keepCarried). Absent: they are only carried. */
  keepCarried?(brandId: string): (archive: string, carried: readonly string[]) => Promise<void>;
  /** Operational log lines (`daytona.chat_files_backed_up`, `daytona.chat_files_restored`, `daytona.outbox_videos`). */
  log?(event: string, fields: Record<string, unknown>): void;
  /** The same for a line that needs attention (`daytona.outbox_video_released`); falls back to `log`. */
  warn?(event: string, fields: Record<string, unknown>): void;
  /** Makes a chat's account in the sandbox at `target` (its home must exist before its files are put back). */
  ensureChat(target: SshTarget, brandId: string, chatId: string): Promise<void>;
  /** The brand's hold, taken as `mode` says (see UpgradeHoldMode; "now", the default, only when nothing of the brand runs). */
  hold(brandId: string, mode?: UpgradeHoldMode): Promise<{ release(): void } | { refused: string; detail?: string }>;
}

/** The head of the server mirror's main, or null when there is no mirror or it has no main. */
export async function mirrorMainHead(mirrorDir: string, brandId: string): Promise<string | null> {
  const git = path.join(mirrorDir, `${brandId}.git`);
  if (!fs.existsSync(git)) return null;
  try {
    const out = await execFileAsync("git", ["--git-dir", git, "rev-parse", "--verify", "refs/heads/main"], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
    const head = out.stdout.trim();
    return head || null;
  } catch {
    return null;
  }
}

/**
 * The head of the server mirror's main for a decision that serves a sandbox (`repoProof`): null only for a proven absence (no mirror directory, or a
 * mirror with no main whose refs all verify). A mirror that cannot be read, is not a repository, has a broken ref or times out throws `mirror_head`.
 */
export async function provenMirrorHead(mirrorDir: string, brandId: string): Promise<string | null> {
  const git = path.join(mirrorDir, `${brandId}.git`);
  try { fs.statSync(git); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new OperationError("mirror_head", null);
  }
  let head: string;
  try {
    const out = await execFileAsync("git", ["--git-dir", git, "rev-parse", "--verify", "-q", "refs/heads/main"], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
    head = out.stdout.trim();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== 1) throw new OperationError("mirror_head", typeof code === "number" ? code : null);
    // Exit 1 is a missing main but also a broken one (a ref file that is not a valid object id). `git show-ref` with no pattern verifies every ref: exit 128
    // on any broken ref, 1 when the mirror has none, 0 with the full list. (Git 2.39 in the server image has no `show-ref --exists`.)
    const refs = await execFileAsync("git", ["--git-dir", git, "show-ref"], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } }).then(
      (out) => ({ code: 0 as unknown, stdout: out.stdout }),
      (failure: unknown) => ({ code: (failure as { code?: unknown }).code, stdout: "" }),
    );
    if (refs.code === 1) return null;
    if (refs.code !== 0) throw new OperationError("mirror_head", typeof refs.code === "number" ? refs.code : null);
    if (refs.stdout.split("\n").some((line) => line.split(" ")[1] === "refs/heads/main")) throw new OperationError("mirror_head", 1);
    return null;
  }
  if (!SHA.test(head)) throw new OperationError("mirror_head", 0);
  return head;
}

/**
 * Throws when a work folder holds a file (they are in no repo or mirror) or cannot be checked. Routine state (D121) is on the server: hydrated copies in `state/<routine>/` are disposable, an uncommitted run folder (`state/<routine>/runs/`) or an unknown entry directly in `state/` is not (same classes as `state_busy` in brand-runtime-state.ts). Runs as root: the brand user cannot see `chats/<id>/work`
 * (`chats/<id>` is 0700, owned by the chat's user). One file is enough to refuse; anything that cannot be traversed or inspected (find exits non-zero) is
 * refused too. The chats go first, so a failure there is not hidden by a later folder's success.
 */
/**
 * The -path globs of a chat's UA files the server keeps or may discard (routine-state/ua-files.ts), so only unknown files under `work/ua` refuse a move. Globs, not a
 * regex, because `find -regex` is not portable; the lists use only `\\d`, `\\.`, one `(a|b)` group, `{16}` and a trailing `+`, which expand exactly (`+` to `*`).
 */
export function uaKeptGlobs(): string[] {
  const expand = (pattern: string): string[] => {
    const body = pattern.replace(/^\^/, "").replace(/\$$/, "");
    const group = /\(([^()]*)\)/.exec(body);
    const variants = group ? group[1]!.split("|").map((option) => body.replace(group[0], option)) : [body];
    return variants.map((text) => text.replaceAll("\\d", "[0-9]").replaceAll("\\.", ".").replace(/(\[[^\]]*\])\{(\d+)\}/g, (_m, set: string, n: string) => set.repeat(Number(n))).replace(/\+$/, "*"));
  };
  return [...UA_DURABLE_PATTERNS, ...UA_SCRATCH_PATTERNS].flatMap(expand);
}

/**
 * Folders whose files are never carried: what a turn or tool leaves behind and rebuilds (videos, voice and briefs it rendered, downloads, a routine edit's
 * scratch, media from `files/outbox`: the check ignores it, and the archive carries the videos no send record covers, see `sentMedia`), and the runtime's journals in the repo's `.marshal/runtime` (one per runtime process, a new one each start).
 */
export const TEMP_WORK_DIRS = ["video-browser", "copycat", "downloads", "video", "voice", "brief", "routine-edit"] as const;
const ROUTINE_DIR = /^[a-z][a-z0-9-]{0,40}$/;
/**
 * The exec as root: a confirmed uid 0 runs as is; any other exec user retries under `sudo -n` (the Daytona default user has it) and is refused, as `not_root`, when sudo
 * does not give uid 0 either. `unchecked` turns an exec failure or an unreadable uid into the caller's refusal.
 */
async function asRoot(exec: RootRun, unchecked: (error: unknown) => Error): Promise<RootRun> {
  const who = await exec("id -u").catch((error: unknown) => { throw unchecked(error); });
  if (who.code !== 0) throw unchecked(new Error("the user id cannot be read"));
  if (who.stdout.trim() === "0") return exec;
  const viaSudo = (command: string) => exec(`sudo -n sh -c ${shellQuote(command)}`);
  const sudoWho = await viaSudo("id -u").catch(() => null);
  if (!sudoWho || sudoWho.code !== 0 || sudoWho.stdout.trim() !== "0") throw Object.assign(new Error("the sandbox exec is not root and sudo -n does not give root"), { name: NOT_ROOT_REFUSED });
  return viaSudo;
}

/** The chat ids whose home holds a file under `work/ua` or `work/store-watch`, read as root in one scan (the chat homes are 0700). Throws when the scan fails. */
export async function routineChats(exec: RootRun, chats: string): Promise<Set<string>> {
  const failed = (error: unknown): Error => new Error(`the chats with routine files could not be listed (${error instanceof Error ? error.message : "exec failed"})`);
  const root = await asRoot(exec, failed);
  const script = `if [ -d ${shellQuote(chats)} ]; then find ${shellQuote(chats)} -mindepth 4 -type f \\( -path ${shellQuote(`${chats}/*/work/ua/*`)} -o -path ${shellQuote(`${chats}/*/work/store-watch/*`)} \\) -print || exit 2; fi`;
  const found = await root(script).catch((error: unknown) => { throw failed(error); });
  if (found.code !== 0) throw failed(new Error(`exit ${found.code}`));
  const prefix = `${chats.replace(/\/+$/, "")}/`;
  return new Set(found.stdout.split("\n").filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length).split("/")[0]!).filter((id) => /^[a-f0-9]{64}$/.test(id)));
}

/** Where a refusing file sits, as a fixed-charset class for the log (`chat:work/x`, `brand:work/x`): never a file name, which can carry brand data. */
function workFileClass(hit: string, dirs: string[], chats: string): string {
  const clean = (part: string | undefined): string => (part && /^[A-Za-z0-9._-]{1,40}$/.test(part) ? part.toLowerCase() : "other");
  const chatsPrefix = `${chats.replace(/\/+$/, "")}/`;
  if (hit.startsWith(chatsPrefix)) { const parts = hit.slice(chatsPrefix.length).split("/"); return `chat:${clean(parts[1])}/${parts.length > 3 ? clean(parts[2]) : "-"}`; }
  const dir = dirs.find((candidate) => hit.startsWith(`${candidate.replace(/\/+$/, "")}/`));
  if (!dir) return "other";
  const parts = hit.slice(dir.replace(/\/+$/, "").length + 1).split("/");
  return `brand:${clean(dir.split("/").filter(Boolean).pop())}/${parts.length > 1 ? clean(parts[0]) : "-"}`;
}

function workFileScope(hit: string, dirs: string[], chats: string): WorkFileScope {
  const chatsPrefix = `${chats.replace(/\/+$/, "")}/`;
  if (hit.startsWith(chatsPrefix)) {
    const top = hit.slice(chatsPrefix.length).split("/")[1];
    return top === "work" ? "chat:work" : top === "files" ? "chat:files" : top === "state" ? "chat:state" : "other";
  }
  return dirs.some((dir) => hit.startsWith(`${dir.replace(/\/+$/, "")}/`)) ? "brand" : "other";
}

export async function assertNoWorkFiles(exec: RootRun, dirs: string[], chats: string, options: { secured?: readonly string[]; chatFilesCarried?: boolean } = {}): Promise<void> {
  const refused = (message: string, found?: { detail: string; scope: WorkFileScope }): Error => Object.assign(new Error(message), { name: WORK_FILES_REFUSED, ...(found ?? {}) });
  const unchecked = (error: unknown): Error => refused(`the work folders could not be checked (${error instanceof Error ? error.message : "exec failed"})`);
  // The check is only meaningful as root: another user sees an empty `chats/` (or none) and would pass.
  const root = await asRoot(exec, unchecked);
  const secured = (options.secured ?? []).filter((name) => ROUTINE_DIR.test(name) && name !== "ua");
  const chatDisposable = [...TEMP_WORK_DIRS.map((name) => `work/${name}/*`), "files/outbox/*", ...secured.map((name) => `work/${name}/*`)];
  // chats counts as absent only when its parent can be searched and it is not there: an unsearchable parent, or a chats that exists but is not a readable folder, is a refusal.
  const parent = path.posix.dirname(chats);
  const script = [
    `if [ ! -x ${shellQuote(parent)} ]; then exit 2; fi`,
    `if [ -e ${shellQuote(chats)} ] || [ -L ${shellQuote(chats)} ]; then [ -d ${shellQuote(chats)} ] || exit 2; find ${shellQuote(chats)} -mindepth 3 -type f \\( ${options.chatFilesCarried ? "" : `-path ${shellQuote(`${chats}/*/work/*`)} -o -path ${shellQuote(`${chats}/*/files/*`)} -o `}-path ${shellQuote(`${chats}/*/state/*/runs/*`)} -o \\( -path ${shellQuote(`${chats}/*/state/*`)} ! -path ${shellQuote(`${chats}/*/state/*/*`)} \\) \\) ${uaKeptGlobs().map((glob) => `! -path ${shellQuote(`${chats}/*/work/ua/${glob}`)} `).join("")}${chatDisposable.map((glob) => `! -path ${shellQuote(`${chats}/*/${glob}`)} `).join("")}! -path ${shellQuote(`${chats}/*/.claude/*`)} -print -quit 2>/dev/null || exit 2; fi`,
    ...dirs.map((dir) => `if [ -d ${shellQuote(dir)} ]; then find ${shellQuote(dir)} -type f ${[...TEMP_WORK_DIRS.map((name) => `${dir}/${name}/*`), `${dir}/outbox/*`, `${dir}/runtime/*`].map((glob) => `! -path ${shellQuote(glob)} `).join("")}-print -quit 2>/dev/null || exit 2; fi`),
  ].join("\n");
  // A find that outruns the exec timeout (60 s) on a heavy brand throws here: refused as unchecked, not logged as a repo problem.
  const found = await root(script).catch((error: unknown) => { throw unchecked(error); });
  if (found.code !== 0) throw refused(`the work folders could not be checked (exit ${found.code})`);
  const hit = found.stdout.trim();
  if (hit) throw refused("a work or files folder holds files that are not in the repo", { detail: workFileClass(hit, dirs, chats), scope: workFileScope(hit, dirs, chats) });
}

/**
 * The server side of a snapshot upgrade. `mirrorCurrent` is what makes deleting a sandbox safe: its repo must be clean on main, the mirror run must
 * have taken (or already had) everything, and the sandbox's head must be the mirror's head. A brand without a deploy key (the mirror skips it) or with a
 * diverged repo is refused, so unpushed work is never dropped. `restore` is the import a provider switch does after its first ensure.
 */
export const deletedBrandPrefix = (brandId: string, stamp: string): string => `deleted-brands/${brandId}/${stamp}/`;

export async function archiveDeletedBrand(input: { brandId: string; repo: string; root: RootRun; files: SandboxFiles; store: ChatBackupStore; stamp: string }): Promise<{ object: string; memoryFiles: string[] }> {
  const fail = (what: string): Error => new Error(`the deleted brand's repo could not be archived (${what})`);
  const root = await asRoot(input.root, (error) => fail(error instanceof Error ? error.message : "exec failed"));
  const tmp = `/tmp/zs-deleted-brand-${input.stamp}.tgz`;
  const repo = shellQuote(input.repo);
  const prefix = deletedBrandPrefix(input.brandId, input.stamp);
  // A brand deleted before its sandbox was ever set up has no brand folder at all (2026-11-10, e70c8f06: the reaper started that sandbox every
  // 5 minutes for hours and failed each time, so it never stopped). `test` exits 1 only when the path is absent: that is recorded and the sandbox
  // retired. Any other answer, and a brand folder without a repo, still refuses and keeps the sandbox.
  const brandDir = shellQuote(path.posix.dirname(input.repo));
  const present = await root(`[ -e ${brandDir} ] || [ -L ${brandDir} ]`).catch(() => null);
  if (!present) throw fail("check");
  if (present.code === 1) {
    await input.store.putJson(`${prefix}manifest.json`, { v: 1, brandId: input.brandId, repo: null, memoryFiles: [], reason: "the brand was never set up on this sandbox" });
    return { object: `${prefix}manifest.json`, memoryFiles: [] };
  }
  const made = await root(`set -e; [ -d ${repo} ] && [ ! -L ${repo} ]; tar -czf ${shellQuote(tmp)} -C ${shellQuote(path.posix.dirname(input.repo))} ${shellQuote(path.posix.basename(input.repo))}; chmod 0644 ${shellQuote(tmp)}`).catch(() => null);
  if (!made || made.code !== 0) throw fail("tar");
  const listing = await root(`cd ${repo} && find memory -type f | sort`).catch(() => null);
  if (!listing || listing.code !== 0) throw fail("list");
  const memoryFiles = listing.stdout.split("\n").filter(Boolean);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zs-deleted-brand-"));
  try {
    const file = path.join(scratch, "repo.tar.gz");
    fs.writeFileSync(file, await input.files.download(tmp), { mode: 0o600 });
    await input.store.put(`${prefix}repo.tar.gz`, file);
    await input.store.putJson(`${prefix}manifest.json`, { v: 1, brandId: input.brandId, repo: path.posix.basename(input.repo), memoryFiles });
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); await root(`rm -f ${shellQuote(tmp)}`).catch(() => undefined); }
  return { object: `${prefix}repo.tar.gz`, memoryFiles };
}

/** What became of a brand's outbox videos, as log lines: one summary, and one warning with its reason code per video left behind (named, with its age and size), so no file is left behind unseen. */
function mediaLog(deps: Pick<SnapshotUpgradeDeps, "log" | "warn">, brandId: string, trigger: "upgrade" | "daily"): (counts: MediaCounts) => void {
  return ({ released, ...counts }) => {
    const by = (reason: string): number => released.filter((video) => video.reason === reason).length;
    deps.log?.("daytona.outbox_videos", { brandId, trigger, ...counts, released: released.length, aged: by("aged"), overBudget: by("over_budget"), unsafeName: by("unsafe_name") });
    for (const video of released) (deps.warn ?? deps.log)?.("daytona.outbox_video_released", { brandId, trigger, ...video });
  };
}

export function createSnapshotUpgrade(deps: SnapshotUpgradeDeps): SnapshotUpgrade {
  return {
    hold: (brandId, mode) => deps.hold(brandId, mode),
    async mirrorCurrent(brandId, target, root, progress, files) {
      const at = (step: string): void => { if (progress) progress.step = step; };
      const run = (command: string, options?: { stdin?: string | Buffer; timeoutMs?: number }) => deps.run(target, brandId, command, options);
      at("verify_source");
      await verifyRuntimeSource({ brandId, repo: deps.repoDir(brandId), run: (command) => run(command) });
      at("mirror_push");
      const vm = { run: (command: string, options?: { stdin?: string | Buffer; timeoutMs?: number }) => run(command, options) };
      const result = await deps.mirror(brandId, vm);
      // The sandbox's history no longer contains what the mirror holds (MLY-580: a sandbox a failed create left behind served the brand on a fresh repo). That
      // history is kept first (server mirror ref and a dated GitHub side branch); only then does the retire go on, and the new sandbox is restored from the
      // mirror. When it cannot be kept, the retire is refused as before: nothing is replaced and nothing is dropped.
      let diverged: DivergedArchive | undefined;
      if (result.status === "diverged" && result.kind === "vm_history") {
        at("archive_diverged");
        const kept = await deps.archiveDiverged(brandId, vm);
        if (kept.status !== "archived") throw Object.assign(new Error("the sandbox's diverged repo history could not be archived"), { name: DIVERGED_ARCHIVE_FAILED, archiveStep: kept.step, exitCode: kept.exitCode, vmHead: result.vmHead, mirrorHead: result.mirrorHead });
        diverged = { vmHead: result.vmHead, mirrorHead: result.mirrorHead, ref: kept.ref, branch: kept.branch };
      } else if (result.status !== "pushed" && result.status !== "unchanged") throw new Error(`the repo could not be mirrored (${result.status})`);
      if (!diverged) {
        at("head_compare");
        const mirrorHead = await mirrorMainHead(deps.mirrorDir, brandId);
        if (!mirrorHead) throw new Error("the server has no mirror of the repo");
        const sandbox = await run(`git -C ${shellQuote(deps.repoDir(brandId))} rev-parse --verify HEAD`);
        const sandboxHead = sandbox.stdout.trim();
        if (sandbox.code !== 0 || !SHA.test(sandboxHead)) throw new Error("the sandbox repo head cannot be read");
        if (sandboxHead !== mirrorHead) throw new Error("the sandbox repo head is not the server mirror's head");
      }
      at("capture_routine_files");
      const captured = await (deps.capture ? routineChats(root, deps.chatsRoot(brandId)).then((chats) => deps.capture!(brandId, target, chats)) : Promise.resolve()).catch((error: unknown) => { throw Object.assign(new Error(`the routine state could not be captured (${error instanceof Error ? error.message : "error"})`), { name: CAPTURE_REFUSED, cause: error }); });
      // Only what changed since the brand's last backup goes to the bucket (a full base when there is none), whole or not at all; the scan then ignores chat files (the rest of it is unchanged).
      at("carry_chat_files");
      let carried = false;
      const manifest = files ? await archiveChatFiles({ brandId, chats: deps.chatsRoot(brandId), root, files, stateDir: deps.stateDir, store: deps.chatBackup, sentMedia: deps.sentMedia(brandId), ...(deps.keepCarried ? { keepCarried: deps.keepCarried(brandId), keepFailed: (error: unknown) => (deps.warn ?? deps.log)?.("daytona.outbox_videos_keep_failed", { brandId, error: error instanceof Error ? error.message : "error" }) } : {}), onMedia: mediaLog(deps, brandId, "upgrade") }) : null;
      if (files) carried = true;
      if (manifest) deps.log?.("daytona.chat_files_backed_up", { brandId, trigger: "upgrade", archives: manifest.entries.length, files: manifest.files });
      at("work_files_scan");
      // A refusal here keeps the old sandbox with every original, so this attempt's archive goes: left behind, it would refuse every later attempt.
      try { await assertNoWorkFiles(root, deps.workDirs(brandId), deps.chatsRoot(brandId), { secured: captured?.secured ?? [], chatFilesCarried: carried }); }
      catch (error) { if (manifest) dropUnusedCarry(deps.stateDir, brandId); throw error; }
      return diverged ? { diverged } : undefined;
    },
    async repoProof(brandId, target) {
      const mirrorHead = await provenMirrorHead(deps.mirrorDir, brandId);
      if (!mirrorHead) return { kind: "no_mirror" };
      const repo = shellQuote(deps.repoDir(brandId));
      const head = await deps.run(target, brandId, `git -C ${repo} rev-parse --verify -q main`);
      const vmHead = head.stdout.trim();
      if (head.code !== 0 || !SHA.test(vmHead)) throw new OperationError("repo_head", head.code);
      if (vmHead === mirrorHead) return { kind: "contains" };
      // The mirror's own check (is the mirrored head an ancestor of main), typed by exit code: 1 when the head is missing or not an ancestor.
      const check = await deps.run(target, brandId, `git -C ${repo} cat-file -e ${mirrorHead}^{commit} 2>/dev/null || exit 1; git -C ${repo} merge-base --is-ancestor ${mirrorHead} main`);
      if (check.code === 0) return { kind: "contains" };
      if (check.code === 1) return { kind: "diverged", vmHead, mirrorHead };
      throw new OperationError("repo_ancestry", check.code);
    },
    /** The daily full backup of a live sandbox's chat files (skipped while the stored base is under a day old). Throws when it cannot be made or stored. */
    async backupChats(brandId: string, root: RootRun, files: SandboxFiles) {
      const outcome = await backupChatFiles({ brandId, chats: deps.chatsRoot(brandId), root, files, stateDir: deps.stateDir, store: deps.chatBackup, mode: "base", sentMedia: deps.sentMedia(brandId), ...(deps.keepCarried ? { keepCarried: deps.keepCarried(brandId), keepFailed: (error: unknown) => (deps.warn ?? deps.log)?.("daytona.outbox_videos_keep_failed", { brandId, error: error instanceof Error ? error.message : "error" }) } : {}), onMedia: mediaLog(deps, brandId, "daily") });
      if ("manifest" in outcome) deps.log?.("daytona.chat_files_backed_up", { brandId, trigger: "daily", archives: outcome.manifest.entries.length, files: outcome.manifest.files, bytes: outcome.bytes });
      return outcome.result;
    },
    /** A deleted brand's repo (memory and history) is copied to the bucket under `deleted-brands/<brand>/<stamp>/`, with a listing of its memory files. Throws when any step fails, so the sandbox stays. */
    async archiveDeletedBrand(brandId: string, root: RootRun, files: SandboxFiles, now: Date = new Date()) {
      return archiveDeletedBrand({ brandId, repo: deps.repoDir(brandId), root, files, store: deps.chatBackup, stamp: now.toISOString().replace(/[:.]/g, "-") });
    },
    async queueBackupRestore(brandId: string) {
      return queueBackupRestore({ brandId, store: deps.chatBackup, stateDir: deps.stateDir });
    },
    async restore(brandId, target, sandbox) {
      // Chat files archived by an upgrade come back first (under the chats' new accounts); a failure fails the ensure and the archive stays for the next one.
      if (sandbox) {
        const restored = await restoreChatFiles({ brandId, chats: deps.chatsRoot(brandId), root: sandbox.root, files: sandbox.files, stateDir: deps.stateDir, store: deps.chatBackup, ensureChat: (chat) => deps.ensureChat(target, brandId, chat) });
        if (restored) deps.log?.("daytona.chat_files_restored", { brandId, archives: restored.entries, files: restored.files });
      }
      if (!(await mirrorMainHead(deps.mirrorDir, brandId))) return "no_mirror";
      await syncRuntimeRepo({ brandId, mirrorDir: deps.mirrorDir, repo: deps.repoDir(brandId), run: (command, options) => deps.run(target, brandId, command, options) });
      return "restored";
    },
  };
}
