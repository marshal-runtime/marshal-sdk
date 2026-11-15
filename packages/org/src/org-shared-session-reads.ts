import { resolveSessionRuntimeId } from "../host-deps";
import type { ISessionStore } from "../host-deps";
import type { SharedSessionHost } from "./org-shared-sessions";

/**
 * The host's reads of stored sessions, under any runtime. `sessionInfo` and `isOpen` run on
 * every sync pass (every 4 s for the open session), so they use the store's in-memory
 * metadata and index; decrypting the header there cost a disk read on each pass.
 */
export function storedSessionReads(
  store: ISessionStore,
  activeRuntimeId: () => string,
): Pick<SharedSessionHost, "loadSession" | "sessionInfo" | "isOpen"> {
  return {
    loadSession: (sessionId) => store.loadSessionData(sessionId),
    sessionInfo: (sessionId) => {
      const metadata = store.loadSessionMetadata
        ? store.loadSessionMetadata(sessionId)
        : store.loadSessionHeader(sessionId);
      if (!metadata) return null;
      return {
        name: metadata.name,
        ...(metadata.repoPath ? { repoPath: metadata.repoPath } : {}),
        usableHere: resolveSessionRuntimeId(metadata) === activeRuntimeId(),
      };
    },
    isOpen: (sessionId) =>
      (store.loadIndexReadOnly?.() ?? store.loadIndex()).activeSessionId === sessionId,
  };
}
