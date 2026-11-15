/**
 * A host's sessions as the org layer sees them from inside a runtime extension (@marshal/org): only through
 * capabilities, never the host's own objects, so the same extension runs in the SDK and later in the desktop.
 *
 * - `marshal.agent.*` (the runtime's agent provider; desktop names) lists sessions and runs instructions:
 *   `marshal.agent.list`, `marshal.agent.send` then `marshal.agent.wait`, `marshal.agent.cancel`.
 * - When the host also offers the link in process (`marshal.link.call`, the SDK host), full transcripts and the native
 *   conversation state come from the link API: `marshal.agent.transcript` shows at most the last 20 messages and no
 *   native state, so without the link a long gap is marked in the published transcript and no checkpoint is left.
 *
 * It satisfies what publishToOrg and the org bridge read from a store (`root`, `list`, `messages`), after `refresh()`.
 */
import fs from "node:fs";
import { gunzipSync } from "node:zlib";

import type { LinkRelay } from "./org-host-room.js";
import type { DeliveryResult, SessionEnvelope } from "./session-messages.js";
import type { SessionRecord, SessionState, TranscriptMessage } from "./session-store.js";

/** Calls one capability and returns its output; throws with the capability's error. */
export type CapabilityCall = (name: string, input: Record<string, unknown>) => Promise<Record<string, any>>;

export interface HostSessionsOptions {
  call: CapabilityCall;
  /** Where the org ledgers live (org-published.json, org-inbox.json). */
  root: string;
  host: { id: string; kind: string };
  /** The host's link in process; without it, marshal.agent.* only. */
  link?: LinkRelay;
  /** The org transcript's run id for these sessions. Default `host-<host id>`. */
  runId?: string;
}

interface AgentSummary {
  id: string;
  name: string;
  state: "running" | "idle";
  createdAt: string;
  updatedAt: string;
  model?: string;
  reasoningEffort?: string;
  sessionId?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; costUsd?: number };
}

const WAIT_SLICE_MS = 300_000;

export class HostSessions {
  readonly root: string;
  private records: SessionRecord[] = [];
  private readonly transcripts = new Map<string, { count: number; updatedAt: string; messages: TranscriptMessage[] }>();
  private readonly natives = new Map<string, { updatedAt: string; bytes: Uint8Array }>();

  constructor(private readonly options: HostSessionsOptions) {
    this.root = options.root;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  /** Whether full transcripts and checkpoints are available (the host's link in process). */
  get full(): boolean {
    return !!this.options.link;
  }

  /** Reads the sessions, their new messages and, for idle sessions that changed, their native state. */
  async refresh(): Promise<void> {
    this.records = this.options.link ? await this.fromLink(this.options.link) : await this.fromAgents();
  }

  list(filter: { runId?: string } = {}): SessionRecord[] {
    return this.records.filter((record) => !filter.runId || record.runId === filter.runId);
  }

  messages(sessionId: string): TranscriptMessage[] {
    return this.transcripts.get(sessionId)?.messages ?? [];
  }

  /** The conversation file of an idle session, fetched at the last refresh (link only). */
  nativeState = (record: SessionRecord): Uint8Array | undefined => {
    const native = this.natives.get(record.id);
    return native && native.updatedAt === record.updatedAt ? native.bytes : undefined;
  };

  /**
   * Runs a person's instruction in a session through marshal.agent.send, then waits for that turn
   * (marshal.agent.wait, in slices of at most 5 minutes) up to `timeoutMs`.
   */
  async deliver(envelope: SessionEnvelope): Promise<DeliveryResult> {
    const from = envelope.from.kind === "person" ? `Message from ${envelope.from.name ?? envelope.from.personId ?? "a teammate"} through the organization:\n\n` : "";
    let sent: Record<string, any>;
    try {
      sent = await this.options.call("marshal.agent.send", { agentId: envelope.to.sessionId, message: `${from}${envelope.body}`, deliveryMode: envelope.deliveryMode });
    } catch (error) {
      return { success: false, accepted: false, messageId: envelope.messageId, error: (error as Error).message };
    }
    const messageId = typeof sent.messageId === "string" ? sent.messageId : envelope.messageId;
    if (!envelope.waitForResponse) return { success: true, accepted: true, messageId, deliveryState: sent.deliveryState === "queued" ? "queued" : "started" };
    const deadline = Date.now() + (envelope.timeoutMs ?? 30 * 60_000);
    while (Date.now() < deadline) {
      const timeoutMs = Math.max(1, Math.min(WAIT_SLICE_MS, deadline - Date.now()));
      const waited = await this.options.call("marshal.agent.wait", { agentId: envelope.to.sessionId, ...(typeof sent.messageId === "string" ? { messageId: sent.messageId } : {}), timeoutMs });
      if (waited.state !== "completed") continue;
      // A failed turn also completes (the agent goes idle); its error is the newest transcript message.
      const last = ((await this.options.call("marshal.agent.transcript", { agentId: envelope.to.sessionId, limit: 1 })).messages as TranscriptMessage[] | undefined)?.at(-1) as (TranscriptMessage & { error?: boolean }) | undefined;
      if (last?.error) return { success: false, accepted: true, messageId, error: last.content };
      return { success: true, accepted: true, messageId, response: typeof waited.result === "string" ? waited.result : "" };
    }
    return { success: true, accepted: true, messageId, status: "timeout" };
  }

  private async fromLink(link: LinkRelay): Promise<SessionRecord[]> {
    const listed = await link({ method: "GET", path: "/v1/sessions" });
    if (listed.error) throw new Error(`link sessions: ${listed.error.message}`);
    const records = ((listed.body as { sessions?: SessionRecord[] }).sessions ?? []).filter((record) => record.source === "marshal-sdk" || record.id);
    for (const record of records) {
      const known = this.transcripts.get(record.id);
      if (!known || known.count !== record.messageCount || known.updatedAt !== record.updatedAt) {
        const read = await link({ method: "GET", path: `/v1/sessions/${encodeURIComponent(record.id)}/transcript` });
        const messages = read.error ? (known?.messages ?? []) : ((read.body as { messages?: TranscriptMessage[] }).messages ?? []);
        this.transcripts.set(record.id, { count: record.messageCount, updatedAt: record.updatedAt, messages });
      }
      if (record.state !== "running" && this.natives.get(record.id)?.updatedAt !== record.updatedAt) {
        const native = await link({ method: "GET", path: `/v1/sessions/${encodeURIComponent(record.id)}/native` });
        const state = (native.body as { state?: { encoding?: string; data?: string } } | undefined)?.state;
        if (!native.error && state?.encoding === "gzip-base64" && typeof state.data === "string") {
          this.natives.set(record.id, { updatedAt: record.updatedAt, bytes: new Uint8Array(gunzipSync(Buffer.from(state.data, "base64"))) });
        }
      }
    }
    return records;
  }

  private async fromAgents(): Promise<SessionRecord[]> {
    const { agents } = (await this.options.call("marshal.agent.list", {})) as { agents: AgentSummary[] };
    const records: SessionRecord[] = [];
    for (const agent of agents) {
      const known = this.transcripts.get(agent.id);
      if (!known || known.updatedAt !== agent.updatedAt) {
        const read = await this.options.call("marshal.agent.transcript", { agentId: agent.id, limit: 20 });
        this.transcripts.set(agent.id, { count: read.messageCount, updatedAt: agent.updatedAt, messages: merge(known?.messages ?? [], read.messages ?? [], read.messageCount) });
      }
      records.push(recordOf(agent, this.options.host, this.options.runId ?? `host-${this.options.host.id}`, this.transcripts.get(agent.id)!.messages.length));
    }
    return records;
  }
}

/** Known messages plus the new ones from a window of the latest; a gap the window could not cover is marked once. */
function merge(known: TranscriptMessage[], window: TranscriptMessage[], total: number): TranscriptMessage[] {
  const ids = new Set(known.map((message) => message.id));
  const fresh = window.filter((message) => !ids.has(message.id));
  const realKnown = known.filter((message) => !message.id.startsWith("gap-")).length;
  const missing = total - realKnown - fresh.length;
  const gap: TranscriptMessage[] =
    missing > 0
      ? [{ id: `gap-${realKnown}`, role: "system", content: `[${missing} earlier messages are not shown: this host offers only the latest 20 through marshal.agent.transcript]`, timestamp: fresh[0]?.timestamp ?? new Date().toISOString() }]
      : [];
  return [...known, ...gap, ...fresh];
}

function recordOf(agent: AgentSummary, host: { id: string; kind: string }, runId: string, messageCount: number): SessionRecord {
  const usage = agent.usage ?? {};
  return {
    schemaVersion: 1,
    id: agent.id,
    title: agent.name,
    state: agent.state as SessionState,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    source: "marshal-sdk",
    runtime: "claude",
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
    native: { kind: "claude", cwd: "", ...(agent.sessionId ? { sessionId: agent.sessionId } : {}) },
    runId,
    host,
    labels: {},
    messageCount,
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cachedInputTokens ?? 0,
      cacheWriteTokens: 0,
      costUsd: usage.costUsd ?? 0,
      turns: 0,
    },
  };
}
