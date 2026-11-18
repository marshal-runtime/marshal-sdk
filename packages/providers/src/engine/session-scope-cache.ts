import type { PersistedSession } from "../../host/engine-host-types";

/**
 * Session fields whose size follows the conversation: a saved conversation state or a pinned
 * system message runs from tens of kilobytes to megabytes. A snapshot stays in memory for every
 * session the store has touched since startup, so it must not carry them: with them, 8,400
 * sessions held 800 MB of the main process heap (2026-11-18 out-of-memory crashes). Read these
 * from the stored header or the full session.
 */
type ConversationSizedField =
  | "runtimeConversationState"
  | "liveTurnCheckpoint"
  | "runtimeExecutions"
  | "permissionCards"
  | "contextSummary"
  | "systemPromptOverride"
  | "systemPromptAppend";

/** A fork's place in its group, without the parent's pinned system message. */
export type SessionForkSummary = Readonly<
  Omit<NonNullable<PersistedSession["fork"]>, "systemMessage">
>;

/** The persisted session fields that stay small: no transcript and no conversation-sized field. */
export type SessionMetadataSnapshot = Readonly<
  Omit<PersistedSession, "messages" | "fork" | ConversationSizedField> & {
    fork?: SessionForkSummary;
  }
>;

/** The session fields that runtime authority, delegation and scope checks need. */
export type SessionScope = Pick<
  PersistedSession,
  | "id"
  | "name"
  | "workspaceName"
  | "repoPath"
  | "source"
  | "runtimeId"
  | "backendOrigin"
  | "automationId"
  | "runtimeDelegationId"
  | "runtimeTaskController"
>;

export function sessionScopeOf(session: SessionScope): SessionScope {
  return {
    id: session.id,
    name: session.name,
    ...(session.workspaceName === undefined ? {} : { workspaceName: session.workspaceName }),
    ...(session.repoPath === undefined ? {} : { repoPath: session.repoPath }),
    ...(session.source === undefined ? {} : { source: session.source }),
    ...(session.runtimeId === undefined ? {} : { runtimeId: session.runtimeId }),
    ...(session.backendOrigin === undefined ? {} : { backendOrigin: session.backendOrigin }),
    ...(session.automationId === undefined ? {} : { automationId: session.automationId }),
    ...(session.runtimeDelegationId === undefined
      ? {}
      : { runtimeDelegationId: session.runtimeDelegationId }),
    ...(session.runtimeTaskController === undefined
      ? {}
      : { runtimeTaskController: session.runtimeTaskController }),
  };
}

/** A full session or its stored header; either carries fields metadata must not keep. */
type SessionMetadataSource = Omit<PersistedSession, "messages"> & {
  readonly messages?: unknown;
  readonly storageFormat?: unknown;
  readonly chunkGen?: unknown;
  readonly chunkCount?: unknown;
  readonly messageCount?: unknown;
  readonly lastMessagePreview?: unknown;
};

function metadataOf(session: SessionMetadataSource): SessionMetadataSnapshot {
  const {
    messages: _messages,
    storageFormat: _storageFormat,
    chunkGen: _chunkGen,
    chunkCount: _chunkCount,
    messageCount: _messageCount,
    lastMessagePreview: _lastMessagePreview,
    runtimeConversationState: _runtimeConversationState,
    liveTurnCheckpoint: _liveTurnCheckpoint,
    runtimeExecutions: _runtimeExecutions,
    permissionCards: _permissionCards,
    contextSummary: _contextSummary,
    systemPromptOverride: _systemPromptOverride,
    systemPromptAppend: _systemPromptAppend,
    fork,
    ...metadata
  } = session;
  if (!fork) return Object.freeze(metadata);
  const { systemMessage: _systemMessage, ...forkSummary } = fork;
  return Object.freeze({ ...metadata, fork: Object.freeze(forkSummary) });
}

/**
 * Metadata (the small fields, see SessionMetadataSnapshot) of every session read or written
 * since startup, so per-call policy and scope checks neither rebuild the transcript nor decrypt
 * the header. The store refreshes an entry every time it writes that session's header and drops
 * it when the session is deleted.
 */
export class SessionMetadataCache {
  readonly #entries = new Map<string, SessionMetadataSnapshot>();

  get(id: string): SessionMetadataSnapshot | undefined {
    return this.#entries.get(id);
  }

  remember(session: SessionMetadataSource): SessionMetadataSnapshot {
    const metadata = metadataOf(session);
    this.#entries.set(metadata.id, metadata);
    return metadata;
  }

  forget(id: string): void {
    this.#entries.delete(id);
  }
}
