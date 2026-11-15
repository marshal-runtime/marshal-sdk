import {
  isOrgWorkspaceId,
  OrgApiError,
  OrgContractError,
  OrgFeatureUnavailableError,
  type OrgClient,
  type OrgRunFlag,
  type OrgRunMessage,
  type OrgRunQuery,
  type OrgRunRow,
  type OrgRunSort,
  type OrgRunSource,
  type OrgRunStatus,
} from "@marshal/agent-runtime-org";

import type {
  OrgRemoteResult,
  OrgRemoteSessionDetail,
  OrgRemoteSessionError,
} from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import { RuntimeIdempotencyStore } from "../marshal-runtime/idempotency";
import { RuntimeApiError } from "../marshal-runtime/runtime-api-error";
import { wrapUntrusted } from "../untrusted-wrap";
import { OrgNotSignedInError, type OrgFlags } from "./org-service";

const log = createLogger("OrgSessionAudit");

export const AUDIT_MAX_ROWS = 100;
export const AUDIT_MAX_MESSAGES = 100;
export const AUDIT_MAX_OPENS_PER_CALL = 5;
export const AUDIT_MAX_OPENS_PER_MINUTE = 10;
export const AUDIT_MAX_ANALYSIS_CHARS = 200_000;
const SESSION_LIST_PAGE = 100;
const SESSION_LIST_MAX_PAGES = 3;
const MINUTE_MS = 60_000;
const IDEMPOTENCY_TTL_MS = 10 * MINUTE_MS;
const IDEMPOTENCY_MAX_ENTRIES = 256;
const MAX_ANALYSIS_MESSAGE_CHARS = 20_000;
const MAX_LABEL_CHARS = 80;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ORG_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const RUN_VIEW_PREFIX = "run:";

export type OrgAuditError =
  | "disabled"
  | "not-signed-in"
  | "unauthorized"
  | "not-found"
  | "unsupported"
  | "unavailable"
  | "unreachable"
  | "contract"
  | "invalid-request"
  | "transcript-unavailable"
  | "too-large"
  | "rate-limited"
  | "refused"
  | "conflict";

export type OrgAuditResult<T> = ({ ok: true } & T) | { ok: false; error: OrgAuditError };

type RunRow = OrgRunRow;
type RunMessage = OrgRunMessage;

/** The part of the organization client this service uses. */
export type OrgSessionAuditClient = Pick<
  OrgClient,
  | "supports"
  | "listRuns"
  | "getRun"
  | "getRunMessages"
  | "listSessions"
  | "getSession"
  | "getTranscript"
>;

export interface OrgSessionAuditDeps {
  getFlags: () => OrgFlags;
  getClient: () => Promise<OrgSessionAuditClient | null>;
  /** Asks the renderer to show a run in the shared-session view. */
  showView: (viewId: string) => void;
  /** Starts a read-only analysis session over wrapped transcript text, as a child of `parentSessionId` when the caller has one. */
  startAnalysis: (request: {
    title: string;
    transcript: string;
    question?: string;
    parentSessionId?: string;
  }) => Promise<{ sessionId: string }>;
  now?: () => number;
}

export type AuditSearchInput = {
  q?: string;
  workspace?: string;
  workflow?: string;
  source?: OrgRunSource;
  status?: OrgRunStatus;
  flag?: OrgRunFlag;
  requester?: string;
  since?: string;
  until?: string;
  sort?: OrgRunSort;
  limit?: number;
  includeSessions?: boolean;
};

const USER_PRINCIPAL = /^user:.+$/;

function runQueryOf(input: AuditSearchInput, limit: number): OrgRunQuery | undefined {
  const { limit: _limit, includeSessions: _sessions, workspace, requester, ...rest } = input;
  if (workspace !== undefined && !isOrgWorkspaceId(workspace)) return undefined;
  if (requester !== undefined && requester !== "me" && !USER_PRINCIPAL.test(requester))
    return undefined;
  return {
    ...rest,
    ...(workspace === undefined ? {} : { workspace }),
    ...(requester === undefined
      ? {}
      : { requester: requester === "me" ? "me" : `user:${requester.slice("user:".length)}` }),
    limit,
  };
}

export type AuditSearchRow =
  | {
      type: "run";
      id: string;
      workspace: string;
      workflow: string;
      source: string;
      title: string;
      status: string;
      startedAt: string;
      costUsd: number;
      requester?: string;
      toolErrors: number;
      flags: string[];
      hasTranscript: boolean;
    }
  | {
      type: "session";
      id: string;
      workspace: string;
      title: string;
      owner: string;
      updatedAt: string;
      runtime: string;
      messageCount: number;
    };

export type AuditMessage = {
  n: number;
  role: string;
  at?: string;
  text?: string;
  tool?: { name: string; isError: boolean; input?: string };
  withheld?: boolean;
};

export type AuditTranscript = {
  id: string;
  session?: string;
  sessions?: {
    session: string;
    role: string;
    status: string;
    hasTranscript: boolean;
    unavailableReason?: string;
  }[];
  messages: AuditMessage[];
  total: number;
  nextFrom?: number;
};

export type AuditRunDetail = {
  title: string;
  owner: string;
  workspaceId: string;
  startedAt: string;
  messages: { id: string; role: "user" | "assistant" | "tool"; text: string; at: string }[];
  total: number;
};

export type AuditOpenAs = "view" | "analyze";

export type AuditOpenTarget = { id: string; session?: string };

export type OpenRequest = {
  identity: string;
  idempotencyKey: string;
  targets: AuditOpenTarget[];
  question?: string;
  /** The session that asked; the analysis session becomes its child. */
  callerSessionId?: string;
};

class OpenRateLimited extends Error {}

export type AuditOpened = {
  id: string;
  as: AuditOpenAs;
  sessionId?: string;
  error?: OrgAuditError;
};

const REMOTE_ERROR_OF: Record<OrgAuditError, OrgRemoteSessionError> = {
  disabled: "disabled",
  "not-signed-in": "not-signed-in",
  unauthorized: "unauthorized",
  "not-found": "not-shared",
  unsupported: "unsupported",
  unavailable: "unavailable",
  unreachable: "unreachable",
  contract: "unavailable",
  "invalid-request": "not-shared",
  "transcript-unavailable": "unavailable",
  "too-large": "unavailable",
  "rate-limited": "unavailable",
  refused: "disabled",
  conflict: "unavailable",
};

const wrap = (text: string): string => wrapUntrusted("org_session", text);

const markForAnalysis = (text: string): string =>
  wrap(
    text.length > MAX_ANALYSIS_MESSAGE_CHARS
      ? `${text.slice(0, MAX_ANALYSIS_MESSAGE_CHARS)}\n[message cut at ${MAX_ANALYSIS_MESSAGE_CHARS} characters]`
      : text,
  );

/** Maps a failed organization call to a short code; never carries the server's message. */
export function auditErrorCode(error: unknown): OrgAuditError {
  if (error instanceof OrgNotSignedInError) return "unauthorized";
  if (error instanceof OrgFeatureUnavailableError) return "unsupported";
  if (error instanceof OrgContractError) return "contract";
  if (error instanceof OrgApiError) {
    if (error.status === 401) return "unauthorized";
    if (error.status === 404) return "not-found";
    if (error.status === 400) return "invalid-request";
    if (error.status === 409) return "transcript-unavailable";
    if (error.status === 413) return "too-large";
    if (error.status === 503) return "unavailable";
  }
  return "unreachable";
}

/** Splits `run:<id>[:<session>]` into its parts; undefined for anything that is not a run view id. */
export function parseRunViewId(value: string): { runId: string; session?: string } | undefined {
  if (!value.startsWith(RUN_VIEW_PREFIX)) return undefined;
  const [runId, session, ...rest] = value.slice(RUN_VIEW_PREFIX.length).split(":");
  if (rest.length > 0 || !runId || !RUN_ID_PATTERN.test(runId)) return undefined;
  if (session !== undefined && !SESSION_NAME_PATTERN.test(session)) return undefined;
  return session === undefined ? { runId } : { runId, session };
}

function rowOfRun(row: RunRow): AuditSearchRow {
  return {
    type: "run",
    id: `${RUN_VIEW_PREFIX}${row.id}`,
    workspace: row.workspace,
    workflow: row.workflow,
    source: row.source,
    title: wrap(row.title),
    status: row.status,
    startedAt: row.startedAt,
    costUsd: row.costUsd,
    ...(row.requester ? { requester: row.requester } : {}),
    toolErrors: row.toolErrors,
    flags: row.flags,
    hasTranscript: row.hasTranscript,
  };
}

/** A name or role from the organization, reduced to a short token so it cannot carry markup or instructions into a prompt. */
export function safeLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, MAX_LABEL_CHARS);
}

function messageOf(message: RunMessage, mark: (text: string) => string): AuditMessage {
  return {
    n: message.n,
    role: safeLabel(message.role),
    ...(message.at ? { at: message.at } : {}),
    ...(message.text === undefined ? {} : { text: mark(message.text) }),
    ...(message.tool
      ? {
          tool: {
            name: safeLabel(message.tool.name),
            isError: message.tool.isError,
            ...(message.tool.input === undefined ? {} : { input: mark(message.tool.input) }),
          },
        }
      : {}),
    ...(message.withheld ? { withheld: true } : {}),
  };
}

const CREDENTIAL_WITHHELD = "(withheld: matched a credential rule)";
const HIDDEN_FOR_REQUESTERS = "(hidden for requesters)";

/** The stand-in for a withheld message. A tool line with no tool name is the stub an older organization server sent a requester in place of tool lines; any other withheld message matched a credential rule. */
const withheldBody = (message: { role: string; tool?: unknown }): string =>
  message.role === "tool" && !message.tool ? HIDDEN_FOR_REQUESTERS : CREDENTIAL_WITHHELD;

function messageBlock(message: AuditMessage): string {
  const head = `[${message.n}] ${message.role}${message.tool ? ` (${message.tool.name}${message.tool.isError ? ", error" : ""})` : ""}`;
  const body = message.withheld
    ? withheldBody(message)
    : [message.text, message.tool?.input].filter(Boolean).join("\n");
  return `${head}\n${body}`;
}

/** Joins whole messages up to `maxChars`; a message is never cut, so a wrapped block is never split. Returns how many messages fit and whether any were left out. */
function transcriptOfBlocks(
  messages: AuditMessage[],
  maxChars: number,
): { text: string; included: number } {
  const blocks: string[] = [];
  let chars = 0;
  for (const message of messages) {
    const block = messageBlock(message);
    if (chars + block.length > maxChars) break;
    blocks.push(block);
    chars += block.length + 2;
  }
  return { text: blocks.join("\n\n"), included: blocks.length };
}

/**
 * Searches and reads organization runs and shared sessions for a signed-in auditor. Read-only,
 * inert unless `org.sessionAudit` is on, bounded in every direction (rows, messages, opens), and
 * every piece of transcript text it returns is wrapped as untrusted external content.
 */
export class OrgSessionAudit {
  private readonly opens: number[] = [];
  private readonly idempotency: RuntimeIdempotencyStore;

  constructor(private readonly deps: OrgSessionAuditDeps) {
    this.idempotency = new RuntimeIdempotencyStore({
      ttlMs: IDEMPOTENCY_TTL_MS,
      maxEntries: IDEMPOTENCY_MAX_ENTRIES,
      now: () => this.now(),
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** True when the flag is on and a person is signed in; the provider lists nothing otherwise. */
  active(): boolean {
    return this.deps.getFlags().sessionAudit === true;
  }

  private async run<T>(
    work: (client: OrgSessionAuditClient) => Promise<OrgAuditResult<T>>,
  ): Promise<OrgAuditResult<T>> {
    if (!this.active()) return { ok: false, error: "disabled" };
    try {
      const client = await this.deps.getClient();
      if (!client) return { ok: false, error: "not-signed-in" };
      return await work(client);
    } catch (error) {
      const code = auditErrorCode(error);
      log.warn(`Session audit request failed: ${code}`);
      return { ok: false, error: code };
    }
  }

  search(input: AuditSearchInput): Promise<
    OrgAuditResult<{
      rows: AuditSearchRow[];
      indexedThrough?: string;
      truncated: boolean;
    }>
  > {
    return this.run<{
      rows: AuditSearchRow[];
      indexedThrough?: string;
      truncated: boolean;
    }>(async (client) => {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), AUDIT_MAX_ROWS);
      const rows: AuditSearchRow[] = [];
      let indexedThrough: string | undefined;
      let truncated = false;
      if (client.supports("runIndex") && client.listRuns) {
        const query = runQueryOf(input, limit);
        if (!query) return { ok: false, error: "invalid-request" };
        const page = await client.listRuns(query);
        rows.push(...page.runs.slice(0, limit).map(rowOfRun));
        indexedThrough = page.indexedThrough;
        truncated = page.nextCursor !== undefined || page.runs.length > limit;
      }
      if (input.includeSessions !== false && client.supports("sessions")) {
        const needle = input.q?.trim().toLowerCase();
        let cursor: string | undefined;
        for (let page = 0; page < SESSION_LIST_MAX_PAGES && rows.length < limit; page += 1) {
          // eslint-disable-next-line no-await-in-loop -- cursor paging is sequential
          const result = await client.listSessions({ limit: SESSION_LIST_PAGE, cursor });
          for (const view of result.sessions) {
            if (view.role === "owner") continue;
            const { session } = view;
            if (needle && !`${session.title} ${session.owner}`.toLowerCase().includes(needle))
              continue;
            if (input.workspace && session.workspaceId !== input.workspace) continue;
            if (rows.length >= limit) {
              truncated = true;
              break;
            }
            rows.push({
              type: "session",
              id: session.id,
              workspace: session.workspaceId,
              title: wrap(session.title),
              owner: session.owner,
              updatedAt: session.updatedAt,
              runtime: session.runtime,
              messageCount: session.transcript.messageCount,
            });
          }
          cursor = result.nextCursor;
          if (!cursor) break;
        }
        if (cursor) truncated = true;
      }
      return {
        ok: true,
        rows,
        ...(indexedThrough ? { indexedThrough } : {}),
        truncated,
      };
    });
  }

  transcript(input: {
    id: string;
    session?: string;
    from?: number;
    limit?: number;
  }): Promise<OrgAuditResult<AuditTranscript>> {
    return this.readTranscript(input, wrap);
  }

  private readTranscript(
    input: { id: string; session?: string; from?: number; limit?: number },
    mark: (text: string) => string,
  ): Promise<OrgAuditResult<AuditTranscript>> {
    return this.run<AuditTranscript>(async (client) => {
      const limit = Math.min(Math.max(input.limit ?? AUDIT_MAX_MESSAGES, 1), AUDIT_MAX_MESSAGES);
      const from = Math.max(input.from ?? 0, 0);
      const run = parseRunViewId(input.id);
      if (run) {
        if (!client.getRun || !client.getRunMessages) return { ok: false, error: "unsupported" };
        const detail = await client.getRun(run.runId);
        const sessions = detail.sessions.map((entry) => ({
          session: entry.session,
          role: entry.role,
          status: entry.status,
          hasTranscript: entry.hasTranscript,
          ...(entry.unavailableReason ? { unavailableReason: entry.unavailableReason } : {}),
        }));
        const name =
          input.session ??
          run.session ??
          detail.sessions.find((entry) => entry.hasTranscript)?.session;
        if (!name) return { ok: false, error: "transcript-unavailable" };
        if (!SESSION_NAME_PATTERN.test(name)) return { ok: false, error: "invalid-request" };
        const page = await client.getRunMessages(run.runId, name, { from, limit });
        return {
          ok: true,
          id: input.id,
          session: name,
          sessions,
          messages: page.messages.slice(0, limit).map((message) => messageOf(message, mark)),
          total: page.total,
          ...(page.nextFrom === undefined ? {} : { nextFrom: page.nextFrom }),
        };
      }
      if (!ORG_SESSION_ID_PATTERN.test(input.id)) return { ok: false, error: "invalid-request" };
      let cursor: string | undefined;
      let skipped = 0;
      const messages: AuditMessage[] = [];
      let total = 0;
      let nextFrom: number | undefined;
      for (let page = 0; page < 50 && messages.length < limit; page += 1) {
        // eslint-disable-next-line no-await-in-loop -- cursor paging is sequential
        const result = await client.getTranscript(input.id, { cursor, limit: SESSION_LIST_PAGE });
        total = result.total;
        for (const message of result.messages) {
          if (skipped < from) {
            skipped += 1;
            continue;
          }
          if (messages.length >= limit) break;
          messages.push({
            n: from + messages.length,
            role: safeLabel(message.role),
            at: message.at,
            text: mark(message.text),
          });
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      if (from + messages.length < total) nextFrom = from + messages.length;
      return {
        ok: true,
        id: input.id,
        messages,
        total,
        ...(nextFrom === undefined ? {} : { nextFrom }),
      };
    });
  }

  /** Detail for the shared-session view of one `run:<id>[:<session>]` id. */
  runDetail(viewId: string): Promise<OrgAuditResult<AuditRunDetail>> {
    return this.run<AuditRunDetail>(async (client) => {
      const run = parseRunViewId(viewId);
      if (!run || !client.getRun || !client.getRunMessages)
        return { ok: false, error: "invalid-request" };
      const detail = await client.getRun(run.runId);
      const name = run.session ?? detail.sessions.find((entry) => entry.hasTranscript)?.session;
      const messages: {
        id: string;
        role: "user" | "assistant" | "tool";
        text: string;
        at: string;
      }[] = [];
      let total = 0;
      if (name) {
        const page = await client.getRunMessages(run.runId, name, {
          from: 0,
          limit: AUDIT_MAX_MESSAGES,
        });
        total = page.total;
        for (const message of page.messages) {
          const body = message.withheld
            ? withheldBody(message)
            : [
                message.tool ? `${message.tool.name}${message.tool.isError ? " (error)" : ""}` : "",
                message.text ?? "",
                message.tool?.input ?? "",
              ]
                .filter(Boolean)
                .join("\n");
          messages.push({
            id: `${viewId}:${message.n}`,
            role: message.role === "tool" ? "tool" : message.role === "user" ? "user" : "assistant",
            text: body,
            at: message.at ?? detail.run.startedAt,
          });
        }
      }
      return {
        ok: true,
        title: detail.run.title,
        owner: detail.run.requester ?? "unassigned",
        workspaceId: detail.run.workspace,
        startedAt: detail.run.startedAt,
        messages,
        total,
      };
    });
  }

  /** The shared-session view's detail for a `run:<id>[:<session>]` id, in the shape the renderer already shows. */
  async runView(viewId: string): Promise<OrgRemoteResult<OrgRemoteSessionDetail>> {
    const result = await this.runDetail(viewId);
    if (!result.ok) return { success: false, error: REMOTE_ERROR_OF[result.error] };
    return {
      success: true,
      session: {
        id: viewId,
        title: result.title,
        owner: result.owner,
        workspaceId: result.workspaceId,
        role: "viewer",
        updatedAt: result.startedAt,
        runtime: "engine-run",
        messageCount: result.total,
      },
      messages: result.messages,
      truncated: result.total > result.messages.length,
    };
  }

  private takeOpenSlots(count: number): boolean {
    const cutoff = this.now() - MINUTE_MS;
    while (this.opens.length > 0 && (this.opens[0] ?? 0) <= cutoff) this.opens.shift();
    if (this.opens.length + count > AUDIT_MAX_OPENS_PER_MINUTE) return false;
    for (let index = 0; index < count; index += 1) this.opens.push(this.now());
    return true;
  }

  /** Shows up to five runs or sessions in the shared-session view. Needs an idempotency key: a repeat opens nothing twice. */
  view(request: OpenRequest): Promise<OrgAuditResult<{ opened: AuditOpened[] }>> {
    return this.open("view", request);
  }

  /**
   * Starts a read-only analysis session over each of up to five transcripts, as a child of the
   * calling session when there is one, and returns the child session ids. Needs an idempotency key.
   */
  analyze(request: OpenRequest): Promise<OrgAuditResult<{ opened: AuditOpened[] }>> {
    return this.open("analyze", request);
  }

  private async open(
    as: AuditOpenAs,
    request: OpenRequest,
  ): Promise<OrgAuditResult<{ opened: AuditOpened[] }>> {
    if (!this.active()) return { ok: false, error: "disabled" };
    if (request.targets.length === 0 || request.targets.length > AUDIT_MAX_OPENS_PER_CALL)
      return { ok: false, error: "invalid-request" };
    if (!request.idempotencyKey?.trim()) return { ok: false, error: "invalid-request" };
    try {
      const settled = await this.idempotency.execute(
        {
          operation: `marshal.org.sessions.${as}`,
          identity: request.identity,
          idempotencyKey: request.idempotencyKey,
          payload: {
            targets: request.targets,
            question: request.question ?? "",
            callerSessionId: request.callerSessionId ?? "",
          },
          abortAfterStart: false,
        },
        async () => {
          if (!this.takeOpenSlots(request.targets.length)) throw new OpenRateLimited();
          const opened: AuditOpened[] = [];
          for (const target of request.targets) {
            // eslint-disable-next-line no-await-in-loop -- bounded by five, ordered output
            opened.push(await this.openOne(target, as, request));
          }
          return { ok: true, value: { opened }, receipts: [] };
        },
      );
      return settled.ok
        ? { ok: true, opened: settled.value.opened }
        : { ok: false, error: "unavailable" };
    } catch (error) {
      if (error instanceof OpenRateLimited) return { ok: false, error: "rate-limited" };
      if (error instanceof RuntimeApiError && error.code === "idempotency-conflict")
        return { ok: false, error: "conflict" };
      log.warn(`Opening organization sessions failed: ${auditErrorCode(error)}`);
      return { ok: false, error: "unavailable" };
    }
  }

  private async openOne(
    target: AuditOpenTarget,
    as: AuditOpenAs,
    request: OpenRequest,
  ): Promise<AuditOpened> {
    const viewId =
      target.session && !target.id.includes(":", RUN_VIEW_PREFIX.length)
        ? `${target.id}:${target.session}`
        : target.id;
    if (parseRunViewId(target.id) === undefined && !ORG_SESSION_ID_PATTERN.test(target.id))
      return { id: target.id, as, error: "invalid-request" };
    if (as === "view") {
      const check = await this.transcript({ id: viewId, limit: 1 });
      if (!check.ok) return { id: target.id, as, error: check.error };
      this.deps.showView(viewId);
      return { id: target.id, as };
    }
    const messages: AuditMessage[] = [];
    let from = 0;
    let total = 0;
    let chars = 0;
    for (let page = 0; page < 20; page += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential paging
      const result = await this.readTranscript(
        { id: viewId, from, limit: AUDIT_MAX_MESSAGES },
        markForAnalysis,
      );
      if (!result.ok) return { id: target.id, as, error: result.error };
      total = result.total;
      for (const message of result.messages) {
        chars += (message.text?.length ?? 0) + (message.tool?.input?.length ?? 0);
        messages.push(message);
      }
      if (result.nextFrom === undefined || chars >= AUDIT_MAX_ANALYSIS_CHARS) break;
      from = result.nextFrom;
    }
    const body = transcriptOfBlocks(messages, AUDIT_MAX_ANALYSIS_CHARS);
    const notice =
      body.included < total
        ? `\n\n[The recording is cut short: ${body.included} of ${total} messages are included.]`
        : "";
    try {
      const started = await this.deps.startAnalysis({
        title: `Review ${target.id}`,
        transcript: `${body.text}${notice}`,
        ...(request.question ? { question: request.question } : {}),
        ...(request.callerSessionId ? { parentSessionId: request.callerSessionId } : {}),
      });
      return { id: target.id, as, sessionId: started.sessionId };
    } catch (error) {
      log.warn(`Analysis session failed to start: ${auditErrorCode(error)}`);
      return { id: target.id, as, error: "unavailable" };
    }
  }
}
