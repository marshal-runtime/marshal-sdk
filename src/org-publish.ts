import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import type {
  OrgClient,
  OrgSessionLabel,
  OrgTranscriptMessage,
  OrgWorkspaceId,
  UserPrincipal,
} from "@marshal/agent-runtime-org";

import type { FileSessionStore, SessionRecord, TranscriptMessage } from "./session-store.js";

/** What publishing needs from an organization client; `OrgClient` satisfies it, a test passes a fake. */
export type OrgPublishClient = Pick<
  OrgClient,
  "supports" | "putSession" | "putTranscript" | "acquireLease" | "putEnvelope" | "releaseLease"
>;

export interface OrgPublishOptions {
  client: OrgPublishClient;
  store: Pick<FileSessionStore, "root" | "list" | "messages">;
  /**
   * Who owns the published sessions: the person the run was for. The organization accepts a session only from its
   * owner, so `client` must hold that person's token (see the report for what a service needs).
   */
  owner: UserPrincipal;
  workspaceId: OrgWorkspaceId;
  /** Lease host id for the envelope upload, for example the sandbox id. */
  host: string;
  /** Only sessions of this run. Default: every session in the store. */
  runId?: string;
  label?: OrgSessionLabel;
  /**
   * The org envelope's runtime. Default `marshal-sdk`, which names where the run came from; forks ignore it, but the
   * desktop's take-back of a cloud session accepts only `claude` (electron/org/org-cloud-move.ts), so pass `claude`
   * when the owner should be able to take the session itself home rather than a fork of it.
   */
  runtime?: string;
  /** Upload each idle session's native Claude state, so a teammate can fork it and continue. Default true. */
  envelopes?: boolean;
  /** Reads a session's native state; default reads `<configDir or ~/.claude>/projects/<cwd>/<native id>.jsonl`. */
  nativeState?: (record: SessionRecord) => Uint8Array | undefined;
  /** Only these local sessions. */
  sessionIds?: readonly string[];
  /**
   * The caller drives these sessions from the org (src/org-bridge.ts) and holds their leases: a checkpoint still
   * releases the lease (the org records a checkpoint only on release), then takes it again at once.
   */
  holdLease?: boolean;
  /** The org inbox message a local user message ran, so the org names its author (live sessions). */
  inboxMessageId?: (sessionId: string, index: number) => string | undefined;
}

export interface OrgPublishResult {
  sessionId: string;
  orgSessionId: string;
  /** Messages the organization holds for it after this call (the header included). */
  messageCount: number;
  appended: number;
  envelope: "uploaded" | "unchanged" | "skipped-running" | "no-native-state" | "unsupported" | "off";
  error?: string;
}

/** The organization's runtime id for these sessions (`^[a-z][a-z0-9._-]{0,31}$`). */
export const ORG_RUNTIME = "marshal-sdk";
export const NATIVE_FORMAT = "claude-jsonl";
const LEDGER_FILE = "org-published.json";
const ID_PREFIX = "msdk-";
const MAX_TITLE = 256;
const MAX_MESSAGES_PER_PAGE = 200;
const MAX_PAGE_BYTES = 256 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const LEASE_TTL_SECONDS = 120;

interface LedgerEntry {
  orgSessionId: string;
  /** Messages the organization holds (the header included). */
  messageCount: number;
  /** Local transcript messages already sent. */
  sent: number;
  envelopeSha256?: string;
}

/**
 * Publishes a marshal-sdk session store to a Marshal organization as org sessions, the way a desktop shares one:
 * the envelope (`putSession`), the transcript in bounded pages (`putTranscript`, append with `expectedCount`),
 * and for an idle session its native Claude state as a checkpoint (lease, `putEnvelope`, release with the checkpoint),
 * which is what `forkSession` needs to let a teammate continue it in their own Marshal.
 *
 * Repeat calls send only what is new; `org-published.json` in the store remembers what was sent.
 */
export async function publishToOrg(options: OrgPublishOptions): Promise<OrgPublishResult[]> {
  const ledgerPath = path.join(options.store.root, LEDGER_FILE);
  const ledger = readLedger(ledgerPath);
  const wantEnvelopes = options.envelopes !== false;
  const canEnvelope = wantEnvelopes && options.client.supports("leases") && options.client.supports("cloudRuns");
  const results: OrgPublishResult[] = [];
  const only = options.sessionIds ? new Set(options.sessionIds) : undefined;
  const records = options.store.list(options.runId ? { runId: options.runId } : {}).filter((record) => !only || only.has(record.id));
  for (const record of records) {
    const orgSessionId = orgSessionIdOf(record.id);
    const entry: LedgerEntry = ledger[record.id] ?? { orgSessionId, messageCount: 0, sent: 0 };
    const result: OrgPublishResult = {
      sessionId: record.id,
      orgSessionId,
      messageCount: entry.messageCount,
      appended: 0,
      envelope: wantEnvelopes ? "unsupported" : "off",
    };
    try {
      await options.client.putSession({
        id: orgSessionId,
        workspaceId: options.workspaceId,
        title: orgTitle(record),
        owner: options.owner,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        labels: options.label ?? "team",
        runtime: options.runtime ?? ORG_RUNTIME,
      });
      const local = options.store.messages(record.id);
      const fresh = entry.messageCount === 0;
      const pending: OrgTranscriptMessage[] = [
        ...(fresh ? [headerMessage(record)] : []),
        ...local.slice(entry.sent).map((message, offset) => toOrgMessage(message, options.inboxMessageId?.(record.id, entry.sent + offset))),
      ];
      let first = true;
      for (const page of pages(pending)) {
        const replace = fresh && first;
        const ref = await options.client.putTranscript(orgSessionId, {
          mode: replace ? "replace" : "append",
          messages: page,
          ...(replace ? {} : { expectedCount: entry.messageCount }),
        });
        entry.messageCount = ref.messageCount;
        result.appended += page.length;
        first = false;
      }
      entry.sent = local.length;
      result.messageCount = entry.messageCount;

      if (canEnvelope) {
        result.envelope = await publishEnvelope(options, record, entry);
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    ledger[record.id] = entry;
    writeLedger(ledgerPath, ledger);
    results.push(result);
  }
  return results;
}

async function publishEnvelope(
  options: OrgPublishOptions,
  record: SessionRecord,
  entry: LedgerEntry,
): Promise<OrgPublishResult["envelope"]> {
  // A checkpoint is taken between turns only: a fork must never start from the middle of one.
  if (record.state === "running") return "skipped-running";
  const raw = (options.nativeState ?? readClaudeNativeState)(record);
  if (!raw) return "no-native-state";
  const gzipped = new Uint8Array(gzipSync(raw));
  const sha256 = createHash("sha256").update(gzipped).digest("hex");
  if (sha256 === entry.envelopeSha256) return "unchanged";
  const orgSessionId = entry.orgSessionId;
  await options.client.acquireLease(orgSessionId, { host: options.host, ttlSeconds: LEASE_TTL_SECONDS });
  let released = false;
  try {
    await options.client.putEnvelope(orgSessionId, {
      host: options.host,
      format: NATIVE_FORMAT,
      messageCount: entry.messageCount,
      sha256,
      bytes: gzipped.byteLength,
      body: gzipped,
    });
    await options.client.releaseLease(orgSessionId, {
      host: options.host,
      checkpoint: { messageCount: entry.messageCount, stateRef: `sha256:${sha256}` },
    });
    released = true;
  } finally {
    if (!released) await options.client.releaseLease(orgSessionId, { host: options.host }).catch(() => undefined);
    if (options.holdLease) await options.client.acquireLease(orgSessionId, { host: options.host, ttlSeconds: LEASE_TTL_SECONDS });
  }
  entry.envelopeSha256 = sha256;
  return "uploaded";
}

/** Claude keeps a session at `<config dir>/projects/<cwd with every non-alphanumeric as '-'>/<session id>.jsonl`. */
export function claudeNativePath(record: Pick<SessionRecord, "native">): string | undefined {
  const { native } = record;
  if (native.kind !== "claude" || !native.sessionId) return undefined;
  const configDir = native.configDir ?? path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects", native.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${native.sessionId}.jsonl`);
}

function readClaudeNativeState(record: SessionRecord): Uint8Array | undefined {
  const file = claudeNativePath(record);
  if (!file) return undefined;
  try {
    return new Uint8Array(fs.readFileSync(file));
  } catch {
    return undefined;
  }
}

/**
 * The org envelope has a title and nothing else of ours, so the title names the run and the first transcript
 * message carries what has no field: run, host, model, effort, labels, parent, native id and usage. Org search
 * reads transcripts, so a run id or label finds the session.
 */
function orgTitle(record: SessionRecord): string {
  const suffix = ` · run ${record.runId.slice(0, 8)} on ${record.host.id}`;
  return `${record.title.slice(0, MAX_TITLE - suffix.length)}${suffix}`;
}

function headerMessage(record: SessionRecord): OrgTranscriptMessage {
  const lines = [
    `Marshal SDK session ${record.id}`,
    `run ${record.runId} on host ${record.host.id} (${record.host.kind})`,
    `model ${record.model ?? "default"}${record.reasoningEffort ? ` at ${record.reasoningEffort}` : ""}`,
    ...(record.parentId ? [`parent ${record.parentId}`] : []),
    ...(record.native.sessionId ? [`native ${record.native.kind} ${record.native.sessionId}`] : []),
    ...(Object.keys(record.labels).length
      ? [`labels ${Object.entries(record.labels).map(([key, value]) => `${key}=${value}`).join(" ")}`]
      : []),
  ];
  return { role: "system", text: lines.join("\n"), at: record.createdAt };
}

function toOrgMessage(message: TranscriptMessage, inboxMessageId?: string): OrgTranscriptMessage {
  return {
    role: message.role,
    text: clip(message.content, MAX_MESSAGE_BYTES),
    at: message.timestamp,
    ...(inboxMessageId && message.role === "user" ? { messageId: inboxMessageId } : {}),
  };
}

/** The org session id of a local session (`msdk-<id>`), and back; undefined for an org session this host did not publish. */
export const orgSessionIdOf = (sessionId: string): string => `${ID_PREFIX}${sessionId}`;
export const localSessionIdOf = (orgSessionId: string): string | undefined =>
  orgSessionId.startsWith(ID_PREFIX) ? orgSessionId.slice(ID_PREFIX.length) : undefined;

function clip(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = "\n[cut: the full message is in the run's own transcript]";
  let cut = text.slice(0, maxBytes - marker.length);
  while (Buffer.byteLength(cut) > maxBytes - marker.length) cut = cut.slice(0, Math.floor(cut.length * 0.95));
  return `${cut}${marker}`;
}

function* pages(messages: OrgTranscriptMessage[]): Generator<OrgTranscriptMessage[]> {
  let page: OrgTranscriptMessage[] = [];
  let bytes = 0;
  for (const message of messages) {
    const size = Buffer.byteLength(message.text);
    if (page.length && (page.length >= MAX_MESSAGES_PER_PAGE || bytes + size > MAX_PAGE_BYTES)) {
      yield page;
      page = [];
      bytes = 0;
    }
    page.push(message);
    bytes += size;
  }
  if (page.length) yield page;
}

function readLedger(file: string): Record<string, LedgerEntry> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, LedgerEntry>) : {};
  } catch {
    return {};
  }
}

function writeLedger(file: string, ledger: Record<string, LedgerEntry>): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(ledger, null, 1));
  fs.renameSync(temporary, file);
}
