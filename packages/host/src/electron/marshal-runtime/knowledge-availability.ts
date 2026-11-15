import * as fs from "node:fs";
import * as path from "node:path";

import type { MarshalRuntimeApi, MarshalRuntimeScope } from "./contracts";

const KNOWLEDGE_SEARCH = "knowledge.search";

/**
 * Fallback provider that answers to `knowledge.search` when no Brain serves
 * the scope. A match from it means "no Brain here", not "Brain available".
 */
export const KNOWLEDGE_STUB_PROVIDER_ID = "marshal.brain-not-configured";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 500;
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
  /** File that keeps each workspace's last answer across restarts. */
  readonly persistPath?: string;
}

export interface KnowledgeAvailability {
  /** Whether a Brain serves this session's scope; on timeout or error falls back to the workspace's last known answer (else false). Cached per session. */
  check(sessionId: string, timeoutMs?: number): Promise<boolean>;
  /** The last settled answer for the session, or undefined when none is cached. */
  peek(sessionId: string): boolean | undefined;
}

/**
 * Per-session check that a Brain answers `knowledge.search` in the session's
 * own runtime scope (the Brain routes by workspace, so this is per workspace).
 */
export function createKnowledgeAvailability(
  options: KnowledgeAvailabilityOptions,
): KnowledgeAvailability {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = new Map<string, { readonly at: number; readonly available: Promise<boolean> }>();
  const settled = new Map<string, boolean>();
  // A slow probe (loaded machine) must not drop the Brain section for a workspace that had one.
  const workspaceOf = new Map<string, string>();
  const lastKnownByWorkspace = readPersisted(options.persistPath);
  const remember = (workspace: string, available: boolean): void => {
    if (lastKnownByWorkspace.get(workspace) === available) return;
    lastKnownByWorkspace.set(workspace, available);
    writePersisted(options.persistPath, lastKnownByWorkspace);
  };

  const lastKnown = (sessionId: string): boolean | undefined => {
    const workspace = workspaceOf.get(sessionId);
    return workspace === undefined ? undefined : lastKnownByWorkspace.get(workspace);
  };

  const lookUp = async (sessionId: string): Promise<boolean> => {
    try {
      const scope = await options.resolveScope(sessionId);
      if (!scope) return false;
      if (workspaceOf.size >= MAX_CACHED_SESSIONS) workspaceOf.clear();
      workspaceOf.set(sessionId, scope.workspaceName);
      const result = await options.api.search({ ...scope, name: KNOWLEDGE_SEARCH, limit: 1 });
      if (!result.ok) return lastKnown(sessionId) ?? false;
      const available = result.value.matches.some(isLiveKnowledgeSearchMatch);
      remember(scope.workspaceName, available);
      return available;
    } catch {
      return lastKnown(sessionId) ?? false;
    }
  };

  const cached = (sessionId: string): Promise<boolean> => {
    const entry = pending.get(sessionId);
    if (entry && Date.now() - entry.at < ttlMs) return entry.available;
    if (pending.size >= MAX_CACHED_SESSIONS) pending.clear();
    if (settled.size >= MAX_CACHED_SESSIONS) settled.clear();
    const available = lookUp(sessionId).then((value) => {
      settled.set(sessionId, value);
      return value;
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

function readPersisted(persistPath: string | undefined): Map<string, boolean> {
  const answers = new Map<string, boolean>();
  if (!persistPath) return answers;
  try {
    const parsed = JSON.parse(fs.readFileSync(persistPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [workspace, available] of Object.entries(parsed)) {
        if (typeof available === "boolean") answers.set(workspace, available);
      }
    }
  } catch {
    // Missing or unreadable file: start with no remembered answers.
  }
  return answers;
}

function writePersisted(persistPath: string | undefined, answers: Map<string, boolean>): void {
  if (!persistPath) return;
  const body = JSON.stringify(Object.fromEntries(answers));
  void fs.promises
    .mkdir(path.dirname(persistPath), { recursive: true })
    .then(() => fs.promises.writeFile(persistPath, body))
    .catch(() => undefined);
}
