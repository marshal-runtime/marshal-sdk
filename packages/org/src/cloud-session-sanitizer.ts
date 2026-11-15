import {
  isOrgWorkspaceId,
  isSessionId,
  type OrgSessionUpload,
  type OrgTranscriptMessage,
  type UserPrincipal,
} from "@marshal/agent-runtime-org";

import { type OrgShareRestrictedItem } from "./contract/org-types";
import { isHiddenInternalControlMessage, type SessionMessage } from "../host-deps";
import { scrubSecrets } from "../host-deps";

/** The contract caps one message at 64 KiB and a title at 256 characters. */
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_TITLE_CHARS = 256;
const MAX_ITEM_LABEL_CHARS = 80;
const MAX_RESTRICTED_ITEMS = 200;
const TRUNCATION_MARK = "\n[truncated]";
const RUNTIME_PATTERN = /^[a-z][a-z0-9._-]{0,31}$/;

export interface ShareableSession {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  runtimeId?: string;
  runtimeAgentRole?: string;
  permissionMode?: string;
  workspaceName?: string;
  repoPath?: string;
  messages: readonly SessionMessage[];
}

export interface SanitizeContext {
  owner: UserPrincipal;
  workspaceId: string;
  homeDir?: string;
  /** Give each message the transcript id {@link orgMessageIdFor} derives from its local id (shared sessions). */
  withIds?: boolean;
}

export interface SanitizedSession {
  upload: OrgSessionUpload;
  messages: OrgTranscriptMessage[];
  /** The local id of each message in `messages`, in the same order. */
  sourceIds: string[];
  restrictedItems: OrgShareRestrictedItem[];
}

export type SanitizeResult =
  | { success: true; session: SanitizedSession }
  | { success: false; error: "invalid-session-id" | "invalid-workspace" };

function normalizeRoot(root: string | undefined): string | undefined {
  if (!root) return undefined;
  const trimmed = root.replace(/[\\/]+$/, "");
  return trimmed.length > 1 ? trimmed : undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathPrefixPattern(root: string): RegExp {
  const flexible = escapeRegExp(root).replace(/\\\\|\//g, "[\\\\/]");
  return new RegExp(`${flexible}(?=[\\\\/]|$|[^A-Za-z0-9_.-])`, "g");
}

/**
 * A PEM private key block (RSA, EC, OPENSSH, ENCRYPTED, PGP...), also when its line breaks are the
 * two characters `\n` inside a JSON string. A block cut off before its END line loses its header and the base64 lines that follow.
 */

export { scrubSecrets };

/**
 * Removes secrets and machine-specific absolute paths from text. The workspace root becomes a
 * relative path, and any other home-directory path collapses to `~`.
 */
export function scrubText(
  text: string,
  roots: { workspaceRoot?: string; homeDir?: string },
): string {
  let result = scrubSecrets(text);
  const workspaceRoot = normalizeRoot(roots.workspaceRoot);
  if (workspaceRoot) {
    result = result.replace(
      new RegExp(`${pathPrefixPattern(workspaceRoot).source}[\\\\/]?`, "g"),
      "./",
    );
  }
  const homeDir = normalizeRoot(roots.homeDir);
  if (homeDir) result = result.replace(pathPrefixPattern(homeDir), "~");
  result = result.replace(/\/(?:Users|home)\/[^/\s"'`:]+(?=\/|\b)/g, "~");
  result = result.replace(/[A-Za-z]:\\Users\\[^\\\s"'`:]+/g, "~");
  return result;
}

function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  const budget = maxBytes - encoder.encode(TRUNCATION_MARK).length;
  let end = Math.min(text.length, budget);
  while (end > 0 && encoder.encode(text.slice(0, end)).length > budget) end -= 1;
  const cut = text.charCodeAt(end - 1);
  if (cut >= 0xd800 && cut <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${TRUNCATION_MARK}`;
}

function toIso(value: string, fallback: string): string {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? fallback : new Date(ms).toISOString();
}

type Source = OrgShareRestrictedItem["source"];

function sourceOf(toolName: string): Source | null {
  const name = toolName.toLowerCase();
  if (/(^|[._:-])(knowledge|brain|graph)([._:-]|$)/.test(name) || name.includes("brain")) {
    return "brain";
  }
  if (/(^|[._:-])(memory|memories|recall|remember|listmemories)([._:-]|$)/.test(name)) {
    return "memory";
  }
  return null;
}

function isTeamAudience(audience: unknown): boolean {
  if (audience === "team") return true;
  return Array.isArray(audience) && audience.length > 0 && audience.every((a) => a === "team");
}

function audienceText(audience: unknown): string | null {
  if (typeof audience === "string") return audience.slice(0, 64);
  if (Array.isArray(audience)) {
    const parts = audience.filter((a): a is string => typeof a === "string");
    return parts.length > 0 ? parts.join(",").slice(0, 64) : null;
  }
  return null;
}

function labelOf(hit: Record<string, unknown>, roots: Parameters<typeof scrubText>[1]): string {
  for (const key of ["title", "name", "fact", "path", "id"]) {
    const value = hit[key];
    if (typeof value === "string" && value.trim()) {
      return scrubText(value.trim().replace(/\s+/g, " "), roots).slice(0, MAX_ITEM_LABEL_CHARS);
    }
  }
  return "(untitled result)";
}

function collectAudienceHits(value: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 8 || out.length >= MAX_RESTRICTED_ITEMS || typeof value !== "object" || !value)
    return;
  if (Array.isArray(value)) {
    for (const entry of value) collectAudienceHits(entry, out, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof above
  if ("audience" in record) out.push(record);
  for (const child of Object.values(record)) collectAudienceHits(child, out, depth + 1);
}

function parseJsonOutput(output: string): unknown {
  try {
    return JSON.parse(output) as unknown; // SF-4: the result is only read, never trusted
  } catch {
    return undefined;
  }
}

/** Brain and memory tool results in the session whose audience is not `team`. */
export function findRestrictedItems(
  messages: readonly SessionMessage[],
  roots: Parameters<typeof scrubText>[1] = {},
): OrgShareRestrictedItem[] {
  const items: OrgShareRestrictedItem[] = [];
  for (const message of messages) {
    const calls = [
      ...(message.toolCalls ?? []),
      ...(message.contentBlocks ?? []).flatMap((block) =>
        block.type === "tools" ? block.toolCalls : [],
      ),
    ];
    const seen = new Set<string>();
    calls.forEach((call, callIndex) => {
      const source = sourceOf(call.name);
      if (!source || !call.output) return;
      const callKey = call.id ?? `${callIndex}:${call.name}`;
      if (seen.has(callKey)) return;
      seen.add(callKey);
      const hits: Record<string, unknown>[] = [];
      collectAudienceHits(parseJsonOutput(call.output), hits);
      hits.forEach((hit, hitIndex) => {
        if (isTeamAudience(hit.audience) || items.length >= MAX_RESTRICTED_ITEMS) return;
        items.push({
          id: `${message.id}:${callKey}:${hitIndex}`,
          source,
          tool: call.name.slice(0, 64),
          audience: audienceText(hit.audience) ?? "unknown",
          label: labelOf(hit, roots),
        });
      });
    });
  }
  return items;
}

const ORG_MESSAGE_ID_MAX = 128;

/** The transcript id of a local message: stable, so a desktop recognises on the server what it wrote. */
export function orgMessageIdFor(localMessageId: string): string {
  const cleaned = localMessageId.replace(/[^A-Za-z0-9._:-]/g, "-");
  return `m:${cleaned}`.slice(0, ORG_MESSAGE_ID_MAX);
}

/** Local messages that never leave the machine as this person's own: hidden turns, notices and other people's messages. */
export function isLocalOnlyMessage(message: SessionMessage): boolean {
  return (
    isHiddenInternalControlMessage(message) ||
    message.suppressedAgentStatusResponse === true ||
    message.goalContinuation === true ||
    message.orgRemote !== undefined
  );
}

/** The title a session carries in the organization: scrubbed, capped, never empty. */
export function orgTitleFor(name: string, roots: Parameters<typeof scrubText>[1]): string {
  return scrubText(name, roots).trim().slice(0, MAX_TITLE_CHARS) || "Untitled";
}

/**
 * One local message as a transcript message: the participant's own words for an old participant turn, scrubbed of
 * secrets and local paths and capped at the contract's size. `undefined` when nothing is left to share.
 */
export function toOrgTranscriptMessage(
  message: SessionMessage,
  roots: Parameters<typeof scrubText>[1],
  options: { at?: string; withId?: boolean } = {},
): OrgTranscriptMessage | undefined {
  const participant = message.role === "user" ? message.orgParticipant : undefined;
  // A message another local session sent (messageSession) shares only its words, never the delivery header naming that session.
  const agentBody = message.role === "user" ? message.agentMessage?.body : undefined;
  const text = scrubText(participant?.text ?? agentBody ?? message.content, roots).trim();
  if (!text) return undefined;
  return {
    role: message.role,
    text: truncateUtf8(text, MAX_MESSAGE_BYTES),
    at: toIso(message.timestamp, options.at ?? new Date().toISOString()),
    ...(participant ? { messageId: participant.orgMessageId } : {}),
    ...(options.withId ? { id: orgMessageIdFor(message.id) } : {}),
  };
}

/**
 * Turns a local session into the organization contract's envelope and transcript. Only user,
 * assistant and system text leaves the machine: tool inputs and outputs, reasoning, attachments
 * and hidden control turns stay local, and every message is scrubbed of secrets and local paths.
 */
export function sanitizeSessionForOrg(
  session: ShareableSession,
  context: SanitizeContext,
  now: Date = new Date(),
): SanitizeResult {
  if (!isSessionId(session.id)) return { success: false, error: "invalid-session-id" };
  if (!isOrgWorkspaceId(context.workspaceId)) return { success: false, error: "invalid-workspace" };
  const roots = { workspaceRoot: session.repoPath, homeDir: context.homeDir };
  const fallback = now.toISOString();

  const messages: OrgTranscriptMessage[] = [];
  const sourceIds: string[] = [];
  for (const message of session.messages) {
    if (isLocalOnlyMessage(message)) continue;
    const converted = toOrgTranscriptMessage(message, roots, {
      at: fallback,
      withId: context.withIds === true,
    });
    if (!converted) continue;
    messages.push(converted);
    sourceIds.push(message.id);
  }

  const restrictedItems = findRestrictedItems(session.messages, roots);
  const title = orgTitleFor(session.name, roots);
  const runtime =
    session.runtimeId && RUNTIME_PATTERN.test(session.runtimeId) ? session.runtimeId : "local";
  return {
    success: true,
    session: {
      upload: {
        id: session.id,
        workspaceId: context.workspaceId,
        title,
        owner: context.owner,
        createdAt: toIso(session.createdAt, fallback),
        updatedAt: toIso(session.updatedAt, fallback),
        labels: restrictedItems.length > 0 ? "restricted" : "team",
        runtime,
      },
      messages,
      sourceIds,
      restrictedItems,
    },
  };
}
