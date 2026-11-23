import type { FileSessionStore } from "@zygstinct/marshal-sdk-port";

type BackendTranscriptStore = NonNullable<FileSessionStore["transcripts"]>;
import { BROWSER_REDACTION_NOTICE, ownerBrowserResult, redactedCallIds } from "../sandbox/transcript-redaction.js";

type Entry = { type: string; uuid?: string; [k: string]: unknown };
type Key = { projectKey: string; sessionId: string; subpath?: string };
type Json = Record<string, unknown>;

const object = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);
const blocks = (entry: Json): Json[] => {
  const content = object(entry.message)?.content;
  return Array.isArray(content) ? content.map(object).filter((block): block is Json => block !== null) : [];
};

/** What replaces a result whose call could not be checked because the stored transcript could not be read (fail closed, LN03). */
export const UNCHECKED_REDACTION_NOTICE = "[Tool result removed from the stored transcript: its call could not be checked]";

/** Reports a failed read of the stored transcript (the org store passes its logger's warn). */
export type RedactionLog = (event: string, fields: Record<string, unknown>) => void;

type State = { notices: Map<string, string>; calls: Set<string>; loaded: boolean };

/**
 * The stored transcript keeps the conversation but not what Workspace, owner-browser or routine-state tools returned (SB19, sandbox/transcript-redaction.ts).
 * Batches are mirrored live, so the call and its result can arrive in different batches: the ids of redacted calls are kept per transcript for the life of the
 * process. A process that starts on an existing session (a restart) learns the earlier calls from the store the first time a result arrives whose call it has
 * not seen. If that read fails, the failure is logged and every such result in the batch is dropped (it may be an owner's-browser or Workspace answer); the
 * read is tried again with the next batch that needs it.
 */
export class TranscriptRedactor {
  private readonly state = new Map<string, State>();

  constructor(private readonly log: RedactionLog) {}

  async redact(scope: string, store: BackendTranscriptStore, key: Key, entries: Entry[]): Promise<Entry[]> {
    const mapKey = `${scope}\u0000${key.projectKey}\u0000${key.sessionId}\u0000${key.subpath ?? ""}`;
    const state = this.state.get(mapKey) ?? { notices: new Map<string, string>(), calls: new Set<string>(), loaded: false };
    this.state.set(mapKey, state);
    const known = state.notices;
    const learn = (batch: Entry[]) => {
      for (const [id, notice] of redactedCallIds(batch.map((entry) => JSON.stringify(entry)).join("\n"))) known.set(id, notice);
      for (const entry of batch) for (const block of blocks(entry)) if (block.type === "tool_use" && typeof block.id === "string") state.calls.add(block.id);
    };
    learn(entries);
    const resultIds = entries.flatMap((entry) => blocks(entry).filter((block) => block.type === "tool_result" && typeof block.tool_use_id === "string").map((block) => block.tool_use_id as string));
    let unchecked = new Set<string>();
    if (!state.loaded && resultIds.some((id) => !state.calls.has(id))) {
      // A result for a call this process has not seen: read what is stored once, for the calls that came before it.
      try {
        const stored = await store.load(key);
        if (stored) learn(stored as Entry[]);
        state.loaded = true;
      } catch (error) {
        unchecked = new Set(resultIds.filter((id) => !state.calls.has(id) && !known.has(id)));
        this.log("org_store.redact_load_failed", { sessionId: key.sessionId, dropped: unchecked.size, error: error instanceof Error ? error.message : String(error) });
      }
    }
    // The owner's-Chrome mark on a result is the authority (the VM provider sets it from the backend that ran the call); the call-text match above is the
    // extra net for a result whose mark a runtime script dropped.
    for (const entry of entries) {
      for (const block of blocks(entry)) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string" || known.has(block.tool_use_id)) continue;
        if (ownerBrowserResult(block.content) || ownerBrowserResult(entry.toolUseResult)) known.set(block.tool_use_id, BROWSER_REDACTION_NOTICE);
      }
    }
    const noticeOf = (id: unknown) => (typeof id !== "string" ? undefined : known.get(id) ?? (unchecked.has(id) ? UNCHECKED_REDACTION_NOTICE : undefined));
    if (known.size === 0 && unchecked.size === 0) return entries;
    return entries.map((entry) => {
      let notice: string | undefined;
      let copy: Json | undefined;
      for (const block of blocks(entry)) {
        if (block.type === "tool_result" && noticeOf(block.tool_use_id)) {
          copy ??= structuredClone(entry) as Json;
          notice = noticeOf(block.tool_use_id);
        }
      }
      if (!copy || !notice) return entry;
      for (const block of blocks(copy)) {
        const replaced = block.type === "tool_result" ? noticeOf(block.tool_use_id) : undefined;
        if (replaced) block.content = replaced;
      }
      if ("toolUseResult" in copy) copy.toolUseResult = notice;
      return copy as Entry;
    });
  }

  /** `store` with every append redacted; the other methods pass through. */
  wrap(scope: string, store: BackendTranscriptStore): BackendTranscriptStore {
    const redactor = this;
    return new Proxy(store, {
      get(target, property, receiver) {
        if (property === "append") return async (key: Key, entries: Entry[]) => target.append(key, await redactor.redact(scope, target, key, entries));
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}

/** An org transcript store whose bound views redact before they append. */
export function redactingTranscripts<T extends BackendTranscriptStore>(transcripts: T, log: RedactionLog): T {
  const redactor = new TranscriptRedactor(log);
  return new Proxy(transcripts, {
    get(target, property, receiver) {
      if (property === "bind") return (marshalSessionId: string) => redactor.wrap(marshalSessionId, target.bind!(marshalSessionId));
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
