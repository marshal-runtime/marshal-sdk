import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

import {
  isRelativeRepoPath,
  isValidBranchName,
  type OrgPlacementManifest,
} from "@marshal/agent-runtime-org";

import type { OrgPlacementPreview } from "./contract/org-types";
import { type WipBundle, type WipPlan, type WipSkip, MAX_BUNDLE_BYTES } from "./org-wip-bundle";

export const CLOUD_MOUNT_ID = "m1";
export const CLOUD_MOUNT_PATH = "/work/m1";

export const INTERRUPTED_BY_MOVE =
  "This tool call was interrupted by a move to the cloud. It may or may not have completed: verify its effects before retrying it.";

/** Tools the cloud host does not have; declared in the manifest and shown on the preview card. */
export const CLOUD_UNAVAILABLE_TOOLS: ReadonlyArray<{ name: string; why: string }> = [
  { name: "browser (logged-in)", why: "local-profile" },
  { name: "computer use and local apps", why: "local-only" },
  { name: "mcp servers", why: "not-approved-for-cloud" },
  { name: "subagents", why: "not-in-the-cloud-host" },
];

const toBinary = (text: string) => Buffer.from(text, "utf8").toString("latin1");
const WORD = /[A-Za-z0-9_-]/;
const BEFORE_PATH = /[A-Za-z0-9_.-]/;

/** True when the character after a match continues a name: a word character, or a dot that starts an extension (`.git`). A dot that ends a sentence does not. */
function continuesName(content: string, at: number): boolean {
  const next = content[at];
  if (next === undefined) return false;
  if (WORD.test(next)) return true;
  return next === "." && content[at + 1] !== undefined && WORD.test(content[at + 1]);
}

/**
 * Replaces every occurrence of each `from` (as a path prefix) with `to` in a JSONL transcript, in both its plain and its JSON-escaped
 * spelling. Works on bytes so no other part of the file is re-encoded. A match is a whole path prefix: one that continues
 * with a name character (`/a/repo-old` is not `/a/repo`) or that sits inside another path (`/mnt/a/repo` is not `/a/repo`) is
 * left alone, while a path that ends a sentence (`/a/repo.`) is rewritten.
 */
export function rewriteTranscriptPaths(
  bytes: Uint8Array,
  from: string | readonly string[],
  to: string,
): Uint8Array {
  const roots = [from].flat().filter((root) => root !== "" && root !== "/");
  if (roots.length === 0) return bytes;
  let content = Buffer.from(bytes).toString("latin1");
  const spellings = new Set(roots.flatMap((root) => [root, JSON.stringify(root).slice(1, -1)]));
  for (const spelling of [...spellings].sort((first, second) => second.length - first.length)) {
    const needle = toBinary(spelling);
    const replacement = toBinary(to);
    let out = "";
    let cursor = 0;
    for (;;) {
      const at = content.indexOf(needle, cursor);
      if (at === -1) break;
      const previous = at > 0 ? content[at - 1] : undefined;
      out += content.slice(cursor, at);
      const afterEscape = content[at - 2] === "\\";
      const inside =
        (previous !== undefined &&
          BEFORE_PATH.test(previous) &&
          !afterEscape &&
          needle.startsWith("/")) ||
        continuesName(content, at + needle.length);
      out += inside ? needle : replacement;
      cursor = at + needle.length;
    }
    content = out + content.slice(cursor);
  }
  return new Uint8Array(Buffer.from(content, "latin1"));
}

/**
 * The spellings of the repository root that a transcript can hold: the one git reports (the real path) and, for a session folder
 * reached through a symlink, the same root as the session spells its folder.
 */
export function repoRootSpellings(sessionCwd: string, repoRoot: string): string[] {
  const roots = new Set([repoRoot]);
  for (let folder = sessionCwd; ; ) {
    try {
      if (realpathSync(folder) === repoRoot) {
        roots.add(folder);
        break;
      }
    } catch {
      break;
    }
    const parent = path.dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return [...roots];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    // SF-4: a transcript line the session wrote; a non-object or a parse failure is skipped.
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function contentBlocks(line: Record<string, unknown>): Record<string, unknown>[] {
  const message = line.message;
  if (!isRecord(message)) return [];
  const content = message.content;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

/**
 * A transcript that ends in a `tool_use` with no `tool_result` cannot be resumed by Claude. Appends one result line that says the
 * call was interrupted by the move, chained to the last unanswered call. Returns the tool name of the first unanswered call, or
 * `undefined` (and the bytes unchanged) when every call has a result.
 */
export function closeInterruptedToolCalls(
  bytes: Uint8Array,
  now: () => Date = () => new Date(),
): { bytes: Uint8Array; tool: string } | undefined {
  const text = Buffer.from(bytes).toString("utf8");
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const calls = new Map<string, { tool: string; uuid?: string }>();
  const answered = new Set<string>();
  let template: Record<string, unknown> | undefined;
  for (const raw of lines) {
    const line = parseLine(raw);
    if (!line) continue;
    if (typeof line.sessionId === "string") template = line;
    for (const block of contentBlocks(line)) {
      if (block.type === "tool_use" && typeof block.id === "string") {
        calls.set(block.id, {
          tool: typeof block.name === "string" ? block.name : "tool",
          ...(typeof line.uuid === "string" ? { uuid: line.uuid } : {}),
        });
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        answered.add(block.tool_use_id);
      }
    }
  }
  const open = [...calls.entries()].filter(([id]) => !answered.has(id));
  if (open.length === 0 || !template) return undefined;
  const parent = open[open.length - 1][1].uuid;
  const result: Record<string, unknown> = {
    parentUuid: parent ?? null,
    isSidechain: false,
    type: "user",
    message: {
      role: "user",
      content: open.map(([id]) => ({
        type: "tool_result",
        tool_use_id: id,
        content: INTERRUPTED_BY_MOVE,
        is_error: true,
      })),
    },
    uuid: randomUUID(),
    timestamp: now().toISOString(),
    ...(parent ? { sourceToolAssistantUUID: parent } : {}),
  };
  for (const key of ["sessionId", "cwd", "version", "gitBranch", "userType", "entrypoint"]) {
    if (template[key] !== undefined) result[key] = template[key];
  }
  const separator = text.endsWith("\n") ? "" : "\n";
  const appended = Buffer.concat([
    Buffer.from(bytes),
    Buffer.from(`${separator}${JSON.stringify(result)}\n`, "utf8"),
  ]);
  return { bytes: new Uint8Array(appended), tool: open[0][1].tool };
}

const CONTROL_CHARACTERS = /\p{Cc}/u;
/** What the organization's server refuses in a label or note: a path or URL, a drive letter, another person's `~name`, a rooted home path. */
const REFUSED_LABEL = new RegExp(
  [
    String.raw`^[\\/]`,
    "^[A-Za-z]:",
    "^file:",
    String.raw`^~[^\\/]`,
    String.raw`(?<![A-Za-z0-9._~-])(?:[A-Za-z]:)?[\\/]+(?:Users|home)[\\/]`,
    String.raw`\\\\[^\\/\s]+[\\/](?:Users|home)[\\/]`,
    String.raw`(?<![A-Za-z0-9._~-])~[^\s\\/]+(?=[\\/]|$)`,
  ].join("|"),
  "iu",
);
/** The longest skipped path the organization's server accepts (the pack's parser allows more). */
export const MAX_SKIPPED_PATH_CHARS = 512;
const MAX_LABEL_CHARS = 200;
const MAX_TOOL_CHARS = 128;

/** Names a session's folder for the manifest without its absolute path; a folder name the organization would refuse is replaced by a neutral label, so the move does not fail after the uploads. */
export function mountLabel(repoRoot: string): string {
  const name = path.basename(repoRoot);
  return !name ||
    name.length > MAX_LABEL_CHARS ||
    CONTROL_CHARACTERS.test(name) ||
    REFUSED_LABEL.test(name)
    ? "repository"
    : name;
}

function toolName(tool: string): string {
  const clean = tool
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, MAX_TOOL_CHARS);
  return clean && !REFUSED_LABEL.test(clean) ? clean : "tool";
}

export function previewOf(plan: WipPlan, extra: { runningChildren: number }): OrgPlacementPreview {
  const blocked = extra.runningChildren > 0;
  return {
    repo: plan.repo,
    ...(plan.branch ? { branch: plan.branch } : {}),
    ...(plan.baseBranch ? { baseBranch: plan.baseBranch } : {}),
    localCommits: plan.localCommits,
    tracked: plan.tracked.length,
    trackedBytes: plan.trackedBytes,
    untracked: plan.untracked.length,
    untrackedBytes: plan.untrackedBytes,
    skipped: plan.skipped,
    skippedTotal: plan.skippedTotal,
    refusals: [
      ...(blocked
        ? [
            {
              code: "running-children",
              message: `Finish or stop ${extra.runningChildren} child session${extra.runningChildren === 1 ? "" : "s"} first.`,
            },
          ]
        : []),
      ...plan.refusals,
    ] satisfies OrgPlacementPreview["refusals"],
    trackedOnly: plan.trackedOnly,
    ...(plan.overBudget ? { overBudget: plan.overBudget } : {}),
    maxBundleBytes: MAX_BUNDLE_BYTES,
    unavailableTools: CLOUD_UNAVAILABLE_TOOLS.map((tool) => ({ ...tool })),
  };
}

/** The skipped files the manifest lists. A path the organization would refuse (over 512 characters, a control character, not relative to the repository) is left off the list; the file stays on the computer either way. */
export function skippedForManifest(skipped: readonly WipSkip[]): WipSkip[] {
  return skipped
    .filter(
      (entry) =>
        entry.path.length <= MAX_SKIPPED_PATH_CHARS &&
        !CONTROL_CHARACTERS.test(entry.path) &&
        isRelativeRepoPath(entry.path),
    )
    .map((entry) => ({ path: entry.path, why: entry.why }));
}

export function buildManifest(input: {
  sessionId: string;
  hostId: string;
  boundary: string;
  now: Date;
  plan: WipPlan;
  bundle: WipBundle | undefined;
  midTurn?: { tool: string };
}): OrgPlacementManifest {
  const { plan, bundle } = input;
  return {
    version: 1,
    sessionId: input.sessionId,
    createdBy: input.hostId,
    createdAt: input.now.toISOString(),
    boundary: input.boundary,
    cwdMount: CLOUD_MOUNT_ID,
    mounts: [
      {
        id: CLOUD_MOUNT_ID,
        kind: "git",
        localLabel: mountLabel(plan.repoRoot),
        cloudPath: CLOUD_MOUNT_PATH,
        repo: plan.repo,
        baseCommit: plan.baseCommit,
        ...(plan.baseBranch && isValidBranchName(plan.baseBranch)
          ? { baseBranch: plan.baseBranch }
          : {}),
        ...(bundle
          ? {
              wip: {
                transport: "bundle" as const,
                sha256: bundle.sha256,
                bytes: bundle.bytes.byteLength,
                tracked: bundle.tracked,
                untracked: bundle.untracked,
                localCommits: bundle.localCommits,
                skipped: skippedForManifest(plan.skipped),
              },
            }
          : {}),
      },
    ],
    tools: {
      available: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "brain.*"],
      unavailable: CLOUD_UNAVAILABLE_TOOLS.map((tool) => ({ ...tool })),
    },
    ...(input.midTurn
      ? { midTurn: { interrupted: true, tool: toolName(input.midTurn.tool) } }
      : {}),
  };
}
