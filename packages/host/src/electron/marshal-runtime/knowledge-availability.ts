import * as fs from "node:fs";
import * as path from "node:path";

import { createLogger } from "../../common/marshal-logger";
import type { MarshalRuntimeApi, MarshalRuntimeScope } from "./contracts";

const log = createLogger("KnowledgeAvailability");

const KNOWLEDGE_SEARCH = "knowledge.search";

/**
 * Fallback provider that answers to `knowledge.search` when no Brain serves
 * the scope. A match from it means "no Brain here", not "Brain available".
 */
export const KNOWLEDGE_STUB_PROVIDER_ID = "marshal.brain-not-configured";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_PROBE_DEADLINE_MS = 15_000;
// A remembered "yes" only stands in for a probe that did not answer while it is this fresh. A Brain refused on
// 2026-11-20 kept a "yes" from 2026-11-11 in every prompt because no probe after it ever settled.
const DEFAULT_LAST_KNOWN_MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_CACHED_SESSIONS = 200;

type SearchMatch = {
  readonly capability?: { readonly name?: string };
  readonly provider?: { readonly id?: string };
};

/** True when a search match is a real `knowledge.search`, not the no-Brain stub. */
export function isLiveKnowledgeSearchMatch(match: SearchMatch): boolean {
  return (
    match.capability?.name === KNOWLEDGE_SEARCH && match.provider?.id !== KNOWLEDGE_STUB_PROVIDER_ID
  );
}

export interface KnowledgeAvailabilityOptions {
  readonly api: Pick<MarshalRuntimeApi, "search">;
  readonly resolveScope: (sessionId: string) => Promise<MarshalRuntimeScope | null>;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  /** How long one probe may run before it counts as unanswered. */
  readonly probeDeadlineMs?: number;
  /** How old a workspace's remembered answer may be and still stand in for an unanswered probe. */
  readonly lastKnownMaxAgeMs?: number;
  /** File that keeps each workspace's last answer across restarts. */
  readonly persistPath?: string;
  readonly now?: () => number;
}

export interface KnowledgeAvailability {
  /** Whether a Brain serves this session's scope; on timeout or error falls back to the workspace's recent last known answer (else false). Cached per session. */
  check(sessionId: string, timeoutMs?: number): Promise<boolean>;
  /** The last settled answer for the session, or undefined when none is cached. */
  peek(sessionId: string): boolean | undefined;
}

type Remembered = { readonly available: boolean; readonly at: number };
type ProbeResult = { readonly available: boolean; readonly definite: boolean };

/**
 * Per-session check that a Brain answers `knowledge.search` in the session's
 * own runtime scope (the Brain routes by workspace, so this is per workspace).
 */
export function createKnowledgeAvailability(
  options: KnowledgeAvailabilityOptions,
): KnowledgeAvailability {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probeDeadlineMs = options.probeDeadlineMs ?? DEFAULT_PROBE_DEADLINE_MS;
  const lastKnownMaxAgeMs = options.lastKnownMaxAgeMs ?? DEFAULT_LAST_KNOWN_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  const pending = new Map<string, { readonly at: number; readonly available: Promise<boolean> }>();
  const settled = new Map<string, boolean>();
  // A slow probe (loaded machine) must not drop the Brain section for a workspace that had one.
  const workspaceOf = new Map<string, string>();
  const lastKnownByWorkspace = readPersisted(options.persistPath);
  const remember = (workspace: string, available: boolean): void => {
    lastKnownByWorkspace.set(workspace, { available, at: now() });
    writePersisted(options.persistPath, lastKnownByWorkspace);
  };

  const lastKnown = (sessionId: string): boolean | undefined => {
    const workspace = workspaceOf.get(sessionId);
    const entry = workspace === undefined ? undefined : lastKnownByWorkspace.get(workspace);
    if (!entry) return undefined;
    if (entry.available && now() - entry.at > lastKnownMaxAgeMs) return undefined;
    return entry.available;
  };

  const unanswered = (sessionId: string, reason: string): ProbeResult => {
    const fallback = lastKnown(sessionId) ?? false;
    log.warn(
      `Brain probe did not answer (${reason}); using ${fallback ? "the recent positive" : "no Brain"} for workspace ${workspaceOf.get(sessionId) ?? "unknown"}`,
    );
    return { available: fallback, definite: false };
  };

  const lookUp = async (sessionId: string): Promise<ProbeResult> => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const scope = await options.resolveScope(sessionId);
      if (!scope) return { available: false, definite: true };
      if (workspaceOf.size >= MAX_CACHED_SESSIONS) workspaceOf.clear();
      workspaceOf.set(sessionId, scope.workspaceName);
      const expired = new Promise<"deadline">((resolve) => {
        deadline = setTimeout(() => resolve("deadline"), probeDeadlineMs);
      });
      const result = await Promise.race([
        options.api.search({ ...scope, name: KNOWLEDGE_SEARCH, limit: 1 }),
        expired,
      ]);
      if (result === "deadline") return unanswered(sessionId, `no reply in ${probeDeadlineMs} ms`);
      if (!result.ok) return unanswered(sessionId, `search failed: ${result.error.code}`);
      const available = result.value.matches.some(isLiveKnowledgeSearchMatch);
      remember(scope.workspaceName, available);
      return { available, definite: true };
    } catch (error) {
      return unanswered(sessionId, error instanceof Error ? error.name : "error");
    } finally {
      clearTimeout(deadline);
    }
  };

  const cached = (sessionId: string): Promise<boolean> => {
    const entry = pending.get(sessionId);
    if (entry && Date.now() - entry.at < ttlMs) return entry.available;
    if (pending.size >= MAX_CACHED_SESSIONS) pending.clear();
    if (settled.size >= MAX_CACHED_SESSIONS) settled.clear();
    const available = lookUp(sessionId).then((result) => {
      // An unanswered probe is not an answer: the next check probes again instead of reusing it.
      if (result.definite) settled.set(sessionId, result.available);
      else pending.delete(sessionId);
      return result.available;
    });
    pending.set(sessionId, { at: Date.now(), available });
    return available;
  };

  return {
    async check(sessionId, timeoutMs = defaultTimeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(lastKnown(sessionId) ?? false), timeoutMs);
      });
      const available = await Promise.race([cached(sessionId), timedOut]);
      clearTimeout(timer);
      return available;
    },
    peek(sessionId) {
      return settled.get(sessionId) ?? lastKnown(sessionId);
    },
  };
}

function readPersisted(persistPath: string | undefined): Map<string, Remembered> {
  const answers = new Map<string, Remembered>();
  if (!persistPath) return answers;
  try {
    const parsed = JSON.parse(fs.readFileSync(persistPath, "utf8")) as unknown;
    let mtime = 0;
    try {
      mtime = fs.statSync(persistPath).mtimeMs;
    } catch {
      // The file was just read; a failed stat only makes old-format answers count as stale.
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [workspace, value] of Object.entries(parsed)) {
        // Files written before answers carried a time hold a bare boolean; the file's mtime dates them.
        if (typeof value === "boolean") {
          answers.set(workspace, { available: value, at: mtime });
          continue;
        }
        if (!value || typeof value !== "object") continue;
        const available: unknown = Reflect.get(value, "available");
        const at: unknown = Reflect.get(value, "at");
        if (typeof available === "boolean" && typeof at === "number") {
          answers.set(workspace, { available, at });
        }
      }
    }
  } catch {
    // Missing or unreadable file: start with no remembered answers.
  }
  return answers;
}

function writePersisted(persistPath: string | undefined, answers: Map<string, Remembered>): void {
  if (!persistPath) return;
  const body = JSON.stringify(Object.fromEntries(answers));
  void fs.promises
    .mkdir(path.dirname(persistPath), { recursive: true })
    .then(() => fs.promises.writeFile(persistPath, body))
    .catch(() => undefined);
}
