/* eslint-disable no-await-in-loop -- a link syncs one page at a time: each page's position is recorded before the next */
import os from "node:os";

import type { OrgClient, OrgTranscriptMessage, UserPrincipal } from "@marshal/agent-runtime-org";

import type { SessionMessage } from "../host-deps";
import { createLogger } from "../host-deps";
import {
  isLocalOnlyMessage,
  orgMessageIdFor,
  orgTitleFor,
  toOrgTranscriptMessage,
} from "./cloud-session-sanitizer";
import { orgPrincipalLabel } from "./common/org-principal";
import type {
  OrgGetSharedLinkResult,
  OrgJoinSharedSessionResult,
  OrgListSharedLinksResult,
  OrgSharedLink,
  OrgSharedLiveView,
  OrgSharedRole,
} from "./contract/org-types";
import { classifyOrgFailure } from "./org-errors";
import type { OrgFlags } from "./org-service";
import { paginateTranscript } from "./org-session-sharing";
import { buildSharedContextLine } from "./org-shared-context";
import {
  MAX_PARTICIPANTS,
  type OrgSharedLinkEntry,
  type OrgSharedLinkStore,
} from "./org-shared-link-store";

const log = createLogger("OrgSharedSessions");

/** How often a linked session open in a window, and one that is not, asks for new messages. */
export const SHARED_SYNC_OPEN_MS = 4_000;
export const SHARED_SYNC_BACKGROUND_MS = 30_000;
const SHARED_SYNC_MAX_BACKOFF_MS = 5 * 60_000;
const TICK_MS = 2_000;
/** Most transcript pages one sync reads before yielding to the other links. */
const MAX_PULL_PAGES = 20;
/** How often this person's own shared sessions are looked up to link them; an org change asks again at once. */
export const OWNER_SCAN_MS = 10 * 60_000;
const MAX_OWNER_SCAN_PAGES = 10;
/** How often the loop looks for links whose local session was deleted. */
const MISSING_CHECK_MS = 30_000;
/** How often a joined link asks the organization for its role and title (a role raised again reactivates a revoked link). */
export const SHARED_RECHECK_MS = 60_000;
/** How long a directory name is kept, and how soon a failed or missing lookup is tried again. */
const NAME_TTL_MS = 6 * 60 * 60_000;
const NAME_RETRY_MS = 10 * 60_000;
const MAX_NAME_CHARS = 64;

export type SharedClient = Pick<
  OrgClient,
  | "supports"
  | "whoami"
  | "listSessions"
  | "getSession"
  | "getTranscript"
  | "putTranscript"
  | "searchDirectory"
>;

/** A local session as the sync reads it. */
export interface SharedLocalSession {
  name?: string;
  messages: readonly SessionMessage[];
  repoPath?: string;
}

export interface SharedSessionInfo {
  name: string;
  repoPath?: string;
  /** The session belongs to the runtime active now, so this person can send in it here. */
  usableHere: boolean;
}

/** What the sync needs from the session layer. */
export interface SharedSessionHost {
  /** The whole stored session, under any runtime; costly for a long session, so only read when there is work. */
  loadSession(localSessionId: string): SharedLocalSession | null;
  /** What the stored header says, under any runtime, without reading messages; null when the session is gone. */
  sessionInfo(localSessionId: string): SharedSessionInfo | null;
  /** The runtime active now gives a turn what others wrote (the shared-session context); one that cannot is refused. */
  canTakePart(): boolean;
  /** A turn, send or steer is running: an assistant message may still be followed by more of the same turn. */
  isBusy(localSessionId: string): boolean;
  /** The session is shown in a window, so it syncs more often. */
  isOpen(localSessionId: string): boolean;
  /** Stores a display-only message from someone else and shows it; false when it was already there. */
  appendRemote(localSessionId: string, message: SessionMessage): boolean;
  /** A new local session for a shared session this person joins. */
  createLinkedSession(input: {
    title: string;
    workspaceName?: string;
    initialMessages: SessionMessage[];
  }): Promise<string>;
  /** The local workspace whose git origin maps to the organization workspace, if any. */
  localWorkspaceFor(orgWorkspaceId: string): Promise<string | undefined>;
  subscribe(
    listener: (
      sessionId: string,
      event: { type: string; origin?: string; message?: { role: string } },
    ) => void,
  ): () => void;
  changed(localSessionId: string): void;
  /** Renames a joined copy to the organization title. */
  renameSession(localSessionId: string, title: string): Promise<void>;
  /** Stores the owner's envelope again (its title changed); false when it could not. */
  refreshEnvelope(localSessionId: string): Promise<boolean>;
}

export interface OrgSharedSessionsDeps {
  getFlags: () => OrgFlags;
  getClient: () => Promise<SharedClient | null>;
  getSignedInOrgId: () => string | undefined;
  store: OrgSharedLinkStore;
  host: SharedSessionHost;
  homeDir?: () => string;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => { unref?: () => void };
}

/** The rooms path of shared sessions, attached when rooms are wired. */
export interface SharedLivePath {
  isLive(localSessionId: string): boolean;
  view(localSessionId: string): OrgSharedLiveView | undefined;
  setComposing(localSessionId: string, composing: boolean): void;
}

/** What an agent's `messageSession` to a shared session should do. */
export type SharedAgentTarget =
  | { kind: "local"; localSessionId: string }
  | { kind: "inbox" }
  | { kind: "refused"; error: string; message: string };

const AGENT_REFUSALS: Record<string, string> = {
  "other-runtime":
    "This shared session's copy here belongs to another runtime. Switch to that runtime to write in it.",
  "runtime-unsupported": "The runtime in use cannot take part in shared sessions.",
  forbidden: "You can only read this session: its owner gave you the viewer role.",
  "not-found": "This session is no longer shared with you.",
  "not-signed-in": "Sign in to your organization to write in shared sessions.",
  failed: "The shared session could not be opened here. Try again later.",
};

function isWritableRole(role: string): role is OrgSharedRole {
  return role === "owner" || role === "driver" || role === "collaborator";
}

/** The local id of a message from someone else that has a transcript id: the same whether the room or the transcript delivered it. */
export function remoteMessageLocalId(orgSessionId: string, orgMessageId: string): string {
  return `org-shared:${orgSessionId}:m:${orgMessageId}`;
}

/** A local message this person's desktop shares: their own words and their Marshal's replies, never local-only ones. */
export function isShareable(message: SessionMessage): boolean {
  return (
    (message.role === "user" || message.role === "assistant") &&
    message.origin !== "external" &&
    !isLocalOnlyMessage(message)
  );
}

/** A directory display name as a one-line label: no control characters or angle brackets, capped. */
function cleanName(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    out += code <= 0x1f || code === 0x7f || char === "<" || char === ">" ? " " : char;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS).trim();
}

function linkMatches(link: OrgSharedLinkEntry, key: { orgId: string; principal: string }): boolean {
  return link.orgId === key.orgId && link.principal === key.principal;
}

/**
 * Shared sessions: a local session linked to an organization session whose transcript every writer appends
 * to. Each person's own Marshal answers their own messages; this class only moves text. It pulls what others
 * wrote into the local session as display-only messages (never a turn), pushes this person's messages and
 * their Marshal's replies, and hands the model what others wrote as untrusted context at the start of a turn.
 * Inert unless `org.liveSessions` is on and the organization serves `sharedTranscript`.
 */
export class OrgSharedSessions {
  private links: OrgSharedLinkEntry[] | null = null;
  private loading: Promise<OrgSharedLinkEntry[]> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly nextAt = new Map<string, number>();
  private readonly backoff = new Map<string, number>();
  private readonly joining = new Map<string, Promise<OrgJoinSharedSessionResult>>();
  private principal: { orgId: string; value: UserPrincipal } | null = null;
  private nextOwnerScanAt = 0;
  private nextMissingCheckAt = 0;
  private ownerScan: Promise<void> | null = null;
  private readonly nextRecheckAt = new Map<string, number>();
  private readonly names = new Map<string, { label: string; until: number }>();
  /** Links with local changes the server may not have yet: the only ones whose session a pass reads without new messages. */
  private readonly dirty = new Set<string>();
  /** Links whose reply was still being written: one load when the session is next found idle, none while it runs. */
  private readonly sendWhenIdle = new Set<string>();
  private lastSaved: string | undefined;
  private unsubscribe: (() => void) | null = null;
  private live: SharedLivePath | null = null;

  constructor(private readonly deps: OrgSharedSessionsDeps) {}

  private get enabled(): boolean {
    return this.deps.getFlags().liveSessions === true;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Starts the sync loop; call once safeStorage is ready. Inert while the flag is off. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.host.subscribe((sessionId, event) => {
      if (event.type !== "turn:message-committed" && event.type !== "turn:idle") return;
      if (event.origin === "external") return;
      if (!this.enabled || !this.links?.some((link) => link.localSessionId === sessionId)) return;
      // Part of a reply committed mid-turn has nothing to send yet; the turn's end (or the next pass that finds it over) does.
      if (
        event.type === "turn:message-committed" &&
        event.message?.role === "assistant" &&
        this.deps.host.isBusy(sessionId)
      ) {
        this.sendWhenIdle.add(sessionId);
        return;
      }
      this.dirty.add(sessionId);
      void this.syncNow(sessionId);
    });
    this.schedule();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** The rooms path: while a link's conversation room is live, the transcript poll runs at the background rate. */
  attachLive(live: SharedLivePath): void {
    this.live = live;
  }

  /** The live state of a linked session from its conversation room, when it has one. */
  liveView(localSessionId: string): OrgSharedLiveView | undefined {
    return this.enabled ? this.live?.view(localSessionId) : undefined;
  }

  setComposing(localSessionId: string, composing: boolean): void {
    if (this.enabled) this.live?.setComposing(localSessionId, composing);
  }

  /** Active links of the person signed in now, for the rooms path. */
  liveLinks(): { localSessionId: string; orgSessionId: string; me: UserPrincipal }[] {
    if (!this.enabled) return [];
    const key = this.currentKey();
    const me = this.principal?.value;
    if (!key || !me || !this.links) return [];
    return this.links
      .filter(
        (link) => linkMatches(link, key) && link.status !== "revoked" && link.status !== "gone",
      )
      .map((link) => ({
        localSessionId: link.localSessionId,
        orgSessionId: link.orgSessionId,
        me,
      }));
  }

  /** The display name of a person in a shared session (the directory name when known). */
  labelOf(principal: string): string {
    return this.nameOf(principal);
  }

  /**
   * Learns the directory names of people seen in a session's room (presence comes before their first
   * message), so their messages and the who-is-here line carry names, not addresses. True when a
   * name was learned that was not known before.
   */
  async learnNamesOf(principals: readonly string[]): Promise<boolean> {
    const unknown = principals.filter((principal) => !this.names.has(principal));
    if (unknown.length === 0) return false;
    const connected = await this.connect();
    if (!connected.ok) return false;
    await this.learnNames(connected.client, unknown);
    return true;
  }

  /** Someone wrote in a linked session through its room: remember them as a participant. */
  notePersonFor(localSessionId: string, principal: string): void {
    const link = this.findLink(localSessionId);
    if (!link || this.peopleOf(link).has(principal)) return;
    this.notePerson(link, principal);
    void this.persist();
    this.deps.host.changed(localSessionId);
  }

  /** The organization envelope of a shared session, for creating its conversation room. */
  async describeForRoom(
    orgSessionId: string,
  ): Promise<{ workspaceId: string; title: string } | undefined> {
    const connected = await this.connect();
    if (!connected.ok) return undefined;
    try {
      const view = await connected.client.getSession(orgSessionId);
      return { workspaceId: view.session.workspaceId, title: view.session.title };
    } catch (error) {
      const failure = classifyOrgFailure(error);
      log.info(`Reading a session for its room failed: code=${failure.code}`);
      return undefined;
    }
  }

  private schedule(): void {
    const setTimer = this.deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    const handle = setTimer(() => {
      if (!this.unsubscribe) return;
      void this.tick().finally(() => {
        if (this.unsubscribe) this.schedule();
      });
    }, TICK_MS);
    handle.unref?.();
  }

  /** Look up this person's own shared sessions again on the next tick (sign-in or the organization changed). */
  scanOwnedSoon(): void {
    this.nextOwnerScanAt = 0;
  }

  /** One pass of the loop: links this person's own shared sessions now and then, drops deleted ones, and syncs every link that is due. */
  async tick(): Promise<void> {
    if (!this.enabled) return;
    const startedAt = this.now();
    if (startedAt >= this.nextOwnerScanAt) {
      this.nextOwnerScanAt = startedAt + OWNER_SCAN_MS;
      await this.linkOwnedSessions();
    }
    if (startedAt >= this.nextMissingCheckAt) {
      this.nextMissingCheckAt = startedAt + MISSING_CHECK_MS;
      await this.dropMissing();
    }
    const links = await this.loadLinks();
    if (links.length === 0) return;
    // After a restart nothing has asked who is signed in yet; links are kept per person.
    if (!this.currentKey() && !(await this.connect()).ok) return;
    const key = this.currentKey();
    if (!key) return;
    const now = this.now();
    for (const link of links) {
      if (!linkMatches(link, key) || link.status === "gone") continue;
      if (link.role !== "owner" && (this.nextRecheckAt.get(link.localSessionId) ?? 0) <= now) {
        this.nextRecheckAt.set(link.localSessionId, now + SHARED_RECHECK_MS);
        await this.recheck(link);
      }
      if (link.status === "revoked") continue;
      if ((this.nextAt.get(link.localSessionId) ?? 0) > now) continue;
      await this.syncNow(link.localSessionId);
    }
  }

  private currentKey(): { orgId: string; principal: string } | null {
    const orgId = this.deps.getSignedInOrgId();
    if (!orgId || this.principal?.orgId !== orgId) return null;
    return { orgId, principal: this.principal.value };
  }

  private async connect(): Promise<
    | { ok: true; client: SharedClient; orgId: string; me: UserPrincipal }
    | { ok: false; error: "not-enabled" | "not-signed-in" | "failed" }
  > {
    if (!this.enabled) return { ok: false, error: "not-enabled" };
    const orgId = this.deps.getSignedInOrgId();
    if (!orgId) return { ok: false, error: "not-signed-in" };
    let client: SharedClient | null;
    try {
      client = await this.deps.getClient();
    } catch {
      return { ok: false, error: "failed" };
    }
    if (!client) return { ok: false, error: "not-signed-in" };
    if (!client.supports("sharedTranscript")) return { ok: false, error: "not-enabled" };
    try {
      if (this.principal?.orgId !== orgId) {
        this.principal = { orgId, value: (await client.whoami()).principal };
      }
    } catch (error) {
      const failure = classifyOrgFailure(error);
      return { ok: false, error: failure.code === "not-signed-in" ? "not-signed-in" : "failed" };
    }
    return { ok: true, client, orgId, me: this.principal.value };
  }

  private async loadLinks(): Promise<OrgSharedLinkEntry[]> {
    if (this.links) return this.links;
    this.loading ??= this.deps.store.load().then((links) => {
      this.links = links;
      this.lastSaved = JSON.stringify(links);
      // Anything may have been written while the app was closed.
      for (const link of links) this.dirty.add(link.localSessionId);
      return links;
    });
    return this.loading;
  }

  /** Writes the link file only when what it would hold changed: an idle pass writes nothing. */
  private persist(): Promise<void> {
    const snapshot = [...(this.links ?? [])];
    const serialized = JSON.stringify(snapshot);
    if (serialized === this.lastSaved) return this.saving;
    this.lastSaved = serialized;
    this.saving = this.saving
      .then(() => this.deps.store.save(snapshot))
      .catch((error: unknown) => {
        this.lastSaved = undefined;
        log.warn(
          `Saving shared links failed (${error instanceof Error ? error.name : typeof error})`,
        );
      });
    return this.saving;
  }

  private findLink(localSessionId: string): OrgSharedLinkEntry | undefined {
    const key = this.currentKey();
    return this.links?.find(
      (link) => link.localSessionId === localSessionId && (!key || linkMatches(link, key)),
    );
  }

  /** True when the local session is linked to a shared session for the person signed in now. */
  isLinked(localSessionId: string): boolean {
    return this.enabled && this.findLink(localSessionId) !== undefined;
  }

  // ── IPC ──────────────────────────────────────────────────────────────────

  async getLink(localSessionId: string): Promise<OrgGetSharedLinkResult> {
    if (!this.enabled) return { success: false, error: "not-enabled" };
    await this.loadLinks();
    const link = this.findLink(localSessionId);
    if (!link) return { success: true };
    const connected = await this.connect();
    if (connected.ok) await this.learnNames(connected.client, this.peopleOf(link));
    return { success: true, link: this.describe(link) };
  }

  async listLinks(): Promise<OrgListSharedLinksResult> {
    if (!this.enabled) return { success: false, error: "not-enabled" };
    await this.dropMissing();
    const links = await this.loadLinks();
    const key = this.currentKey();
    return {
      success: true,
      links: links
        .filter((link) => !key || linkMatches(link, key))
        .map((link) => ({
          localSessionId: link.localSessionId,
          orgSessionId: link.orgSessionId,
          role: link.role,
          status: link.status,
        })),
    };
  }

  /** Forgets links whose local session was deleted, so the organization row shows again. */
  private async dropMissing(): Promise<void> {
    const links = await this.loadLinks();
    const dropped = links.filter(
      (link) => this.deps.host.sessionInfo(link.localSessionId) === null,
    );
    if (dropped.length === 0) return;
    this.links = links.filter((link) => !dropped.includes(link));
    await this.persist();
    for (const link of dropped) {
      this.nextAt.delete(link.localSessionId);
      this.backoff.delete(link.localSessionId);
      this.deps.host.changed(link.localSessionId);
    }
  }

  /**
   * Links the sessions this person owns that exist here and that someone may write in, so the owner sees the
   * others live without sharing again (a session shared before shared sessions were on has no link yet).
   */
  linkOwnedSessions(): Promise<void> {
    this.ownerScan ??= this.runOwnerScan().finally(() => {
      this.ownerScan = null;
    });
    return this.ownerScan;
  }

  private async runOwnerScan(): Promise<void> {
    const connected = await this.connect();
    if (!connected.ok) return;
    const { client, orgId, me } = connected;
    const links = await this.loadLinks();
    const linked = new Set(
      links
        .filter((link) => linkMatches(link, { orgId, principal: me }))
        .map((link) => link.orgSessionId),
    );
    let cursor: string | undefined;
    for (let page = 0; page < MAX_OWNER_SCAN_PAGES; page += 1) {
      let result;
      try {
        result = await client.listSessions({
          // The server filters by owner only with `cloudList`; otherwise the owner check below does.
          ...(client.supports("cloudList") ? { owner: "me" as const } : {}),
          ...(cursor ? { cursor } : {}),
        });
      } catch (error) {
        const failure = classifyOrgFailure(error);
        log.warn(
          `Listing owned sessions failed: code=${failure.code} status=${failure.status ?? 0}`,
        );
        this.nextOwnerScanAt = Math.min(
          this.nextOwnerScanAt,
          this.now() + SHARED_SYNC_BACKGROUND_MS,
        );
        return;
      }
      for (const listed of result.sessions) {
        const id = listed.session.id;
        if (listed.session.owner !== me || linked.has(id) || listed.placement === "cloud") continue;
        if (this.deps.host.sessionInfo(id) === null) continue;
        let view;
        try {
          view = await client.getSession(id);
        } catch {
          continue;
        }
        const writable = (view.grants ?? []).some(
          (grant) => grant.role === "collaborator" || grant.role === "driver",
        );
        if (!writable || view.placement === "cloud") continue;
        await this.linkOwner(id, { orgId, me, sharedTitle: view.session.title });
        linked.add(id);
        await this.syncNow(id);
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
  }

  /** Everyone seen in the session: the owner, this person, and every author of a message from someone else. */
  private peopleOf(link: OrgSharedLinkEntry): Set<string> {
    return new Set([link.ownerPrincipal, link.principal, ...(link.participants ?? [])]);
  }

  private describe(link: OrgSharedLinkEntry): OrgSharedLink {
    return {
      orgSessionId: link.orgSessionId,
      role: link.role,
      ownerLabel: this.nameOf(link.ownerPrincipal),
      status: link.status,
      participants: [...this.peopleOf(link)].map((principal) => ({
        principal,
        label: this.nameOf(principal),
      })),
    };
  }

  /** The directory display name of a person when known, else their address. */
  private nameOf(principal: string): string {
    return this.names.get(principal)?.label ?? orgPrincipalLabel(principal);
  }

  /** Looks up names not cached yet: one directory search per person, kept for hours; a miss keeps the address for a while. */
  private async learnNames(client: SharedClient, principals: Iterable<string>): Promise<void> {
    if (!client.supports("directory")) return;
    const now = this.now();
    for (const principal of new Set(principals)) {
      const cached = this.names.get(principal);
      if (cached && cached.until > now) continue;
      let label = orgPrincipalLabel(principal);
      let until = now + NAME_RETRY_MS;
      try {
        const entries = await client.searchDirectory({ query: label, limit: 5 });
        const name = cleanName(
          entries.find((entry) => entry.principal === principal)?.displayName ?? "",
        );
        if (name) {
          label = name;
          until = now + NAME_TTL_MS;
        }
      } catch (error) {
        const failure = classifyOrgFailure(error);
        log.warn(`Directory lookup failed: code=${failure.code} status=${failure.status ?? 0}`);
      }
      this.names.set(principal, { label, until });
    }
  }

  // ── Join ─────────────────────────────────────────────────────────────────

  /** Opens a shared session here so this person can write in it: links a new local session, filled with the conversation so far. */
  join(orgSessionId: string): Promise<OrgJoinSharedSessionResult> {
    const pending = this.joining.get(orgSessionId);
    if (pending) return pending;
    const run = this.runJoin(orgSessionId).finally(() => this.joining.delete(orgSessionId));
    this.joining.set(orgSessionId, run);
    return run;
  }

  private async runJoin(orgSessionId: string): Promise<OrgJoinSharedSessionResult> {
    const connected = await this.connect();
    if (!connected.ok) return { success: false, error: connected.error };
    const { client, orgId, me } = connected;
    const links = await this.loadLinks();
    const existing = links.find(
      (link) =>
        link.orgSessionId === orgSessionId &&
        linkMatches(link, { orgId, principal: me }) &&
        this.deps.host.sessionInfo(link.localSessionId) !== null,
    );
    let view;
    try {
      view = await client.getSession(orgSessionId);
    } catch (error) {
      const failure = classifyOrgFailure(error);
      if (failure.code === "not-found") return { success: false, error: "not-found" };
      if (failure.code === "forbidden") return { success: false, error: "forbidden" };
      if (failure.code === "not-signed-in") return { success: false, error: "not-signed-in" };
      if (existing && failure.transient)
        return { success: true, localSessionId: existing.localSessionId };
      return { success: false, error: "failed" };
    }
    if (!isWritableRole(view.role)) return { success: false, error: "forbidden" };
    if (view.placement === "cloud") return { success: false, error: "cloud-session" };
    if (existing) {
      await this.reactivate(existing, view.role);
      if (existing.role !== "owner") await this.applyOrgTitle(existing, view.session.title);
      void this.syncNow(existing.localSessionId);
      return this.writableHere(existing.localSessionId);
    }
    // The owner's own session stays the one copy, whatever runtime it was made under.
    if (view.role === "owner" && this.deps.host.sessionInfo(orgSessionId) !== null) {
      await this.linkOwner(orgSessionId, { orgId, me, sharedTitle: view.session.title });
      await this.syncNow(orgSessionId);
      return this.writableHere(orgSessionId);
    }
    if (!this.deps.host.canTakePart()) return { success: false, error: "runtime-unsupported" };
    let localSessionId: string;
    try {
      const workspaceName = await this.deps.host.localWorkspaceFor(view.session.workspaceId);
      localSessionId = await this.deps.host.createLinkedSession({
        title: view.session.title,
        ...(workspaceName ? { workspaceName } : {}),
        initialMessages: [],
      });
    } catch (error) {
      log.warn(
        `Joining a shared session failed (${error instanceof Error ? error.name : typeof error})`,
      );
      return { success: false, error: "failed" };
    }
    const link: OrgSharedLinkEntry = {
      orgId,
      principal: me,
      localSessionId,
      orgSessionId,
      role: view.role,
      ownerPrincipal: view.session.owner,
      status: "active",
      pulledThrough: 0,
      orgTitle: view.session.title,
      linkedAt: this.now(),
    };
    this.links = [
      ...links.filter(
        (other) => !(other.orgSessionId === orgSessionId && linkMatches(other, link)),
      ),
      link,
    ];
    this.dirty.add(localSessionId);
    await this.persist();
    await this.syncNow(localSessionId);
    this.deps.host.changed(localSessionId);
    return { success: true, localSessionId };
  }

  /** A linked session this person can write in from here: under the runtime active now, which can take part. */
  private writableHere(localSessionId: string): OrgJoinSharedSessionResult {
    if (this.deps.host.sessionInfo(localSessionId)?.usableHere !== true) {
      return { success: false, error: "other-runtime" };
    }
    if (!this.deps.host.canTakePart()) return { success: false, error: "runtime-unsupported" };
    return { success: true, localSessionId };
  }

  private async linkOwner(
    sessionId: string,
    input: { orgId: string; me: UserPrincipal; sharedTitle?: string },
  ): Promise<OrgJoinSharedSessionResult> {
    const links = await this.loadLinks();
    const link: OrgSharedLinkEntry = {
      orgId: input.orgId,
      principal: input.me,
      localSessionId: sessionId,
      orgSessionId: sessionId,
      role: "owner",
      ownerPrincipal: input.me,
      status: "active",
      pulledThrough: 0,
      ...(input.sharedTitle !== undefined ? { sharedTitle: input.sharedTitle } : {}),
      linkedAt: this.now(),
    };
    this.links = [
      ...links.filter((other) => !(other.localSessionId === sessionId && linkMatches(other, link))),
      link,
    ];
    this.dirty.add(sessionId);
    await this.persist();
    this.deps.host.changed(sessionId);
    return { success: true, localSessionId: sessionId };
  }

  /**
   * The owner shared the session: from now on it syncs like any shared session. Called by sharing once the
   * envelope (and, the first time, the transcript) is stored. The first pull recognises the uploaded messages by
   * their ids, so nothing is sent twice; a session already linked just syncs.
   */
  async ownerShared(sessionId: string, sharedTitle?: string): Promise<void> {
    const connected = await this.connect();
    if (!connected.ok) return;
    await this.loadLinks();
    const link = this.findLink(sessionId);
    if (!link) {
      await this.linkOwner(sessionId, { orgId: connected.orgId, me: connected.me, sharedTitle });
    } else if (sharedTitle !== undefined && link.sharedTitle !== sharedTitle) {
      link.sharedTitle = sharedTitle;
      await this.persist();
    }
    await this.syncNow(sessionId);
  }

  /**
   * A revoked or gone link becomes active again (the role was raised, or the person joined again). What they wrote
   * while it was revoked was never sent, as the banner said, so pushing starts after it; those messages stay local.
   */
  private async reactivate(link: OrgSharedLinkEntry, role: OrgSharedRole): Promise<void> {
    if (link.status === "active" && link.role === role) return;
    if (link.status === "revoked" || link.status === "gone") {
      const last = this.deps.host.loadSession(link.localSessionId)?.messages.at(-1);
      if (last) link.pushedThrough = last.id;
      delete link.onServer;
      this.backoff.delete(link.localSessionId);
      this.nextAt.delete(link.localSessionId);
    }
    link.status = "active";
    link.role = role;
    this.dirty.add(link.localSessionId);
    await this.persist();
    this.deps.host.changed(link.localSessionId);
  }

  /** A joined copy follows the organization title when it changes there; a local rename stands until then. */
  private async applyOrgTitle(link: OrgSharedLinkEntry, title: string): Promise<void> {
    if (link.orgTitle === title) return;
    try {
      await this.deps.host.renameSession(link.localSessionId, title);
    } catch (error) {
      log.warn(
        `Renaming a joined session failed (${error instanceof Error ? error.name : typeof error})`,
      );
      return;
    }
    link.orgTitle = title;
    await this.persist();
    this.deps.host.changed(link.localSessionId);
  }

  /** A joined link asks for its role and title now and then: a raised role reactivates it, a new title renames the copy. */
  private async recheck(link: OrgSharedLinkEntry): Promise<void> {
    const connected = await this.connect();
    if (!connected.ok) return;
    let view;
    try {
      view = await connected.client.getSession(link.orgSessionId);
    } catch (error) {
      const failure = classifyOrgFailure(error);
      if (failure.code === "not-found" && link.status !== "gone") {
        link.status = "gone";
        await this.persist();
        this.deps.host.changed(link.localSessionId);
      }
      return;
    }
    await this.applyOrgTitle(link, view.session.title);
    if (link.status === "revoked" && isWritableRole(view.role) && view.placement !== "cloud") {
      await this.reactivate(link, view.role);
    } else if (link.status !== "revoked" && !isWritableRole(view.role)) {
      link.status = "revoked";
      await this.persist();
      this.deps.host.changed(link.localSessionId);
    }
  }

  /** Whether sharing may replace the transcript: nothing is linked yet and the organization serves shared transcripts. */
  async ownerMayReplace(sessionId: string): Promise<boolean> {
    if (!this.enabled) return true;
    await this.loadLinks();
    return !this.findLink(sessionId);
  }

  // ── Agents ───────────────────────────────────────────────────────────────

  /** Where an agent's message to a shared session goes: the linked local session, or the inbox of a cloud session. */
  async resolveForAgent(orgSessionId: string): Promise<SharedAgentTarget> {
    if (!this.enabled) return { kind: "inbox" };
    const joined = await this.join(orgSessionId);
    if (joined.success) return { kind: "local", localSessionId: joined.localSessionId };
    if (joined.error === "not-enabled" || joined.error === "cloud-session")
      return { kind: "inbox" };
    return {
      kind: "refused",
      error: joined.error,
      message: AGENT_REFUSALS[joined.error] ?? AGENT_REFUSALS.failed,
    };
  }

  // ── Turn context ─────────────────────────────────────────────────────────

  /** Others' messages since this person's Marshal last saw them, for the turn starting now; consumed. */
  takeTurnContext(localSessionId: string): string | undefined {
    if (!this.enabled) return undefined;
    const link = this.findLink(localSessionId);
    if (!link) return undefined;
    const messages = this.deps.host.loadSession(localSessionId)?.messages ?? [];
    const start = link.contextThrough
      ? messages.findIndex((message) => message.id === link.contextThrough) + 1
      : 0;
    const fresh = messages.slice(start).filter((message) => message.orgRemote !== undefined);
    if (fresh.length === 0) return undefined;
    link.contextThrough = fresh[fresh.length - 1].id;
    void this.persist();
    return buildSharedContextLine(fresh);
  }

  // ── Sync ─────────────────────────────────────────────────────────────────

  /** Pulls then pushes one linked session. Calls made while it runs fold into one more pass. */
  syncNow(localSessionId: string): Promise<void> {
    const current = this.running.get(localSessionId);
    if (current) {
      this.again.add(localSessionId);
      return current;
    }
    const run = (async () => {
      do {
        this.again.delete(localSessionId);
        await this.syncOnce(localSessionId);
      } while (this.again.has(localSessionId));
    })().finally(() => this.running.delete(localSessionId));
    this.running.set(localSessionId, run);
    return run;
  }

  private async syncOnce(localSessionId: string): Promise<void> {
    const connected = await this.connect();
    if (!connected.ok) return;
    await this.loadLinks();
    const link = this.findLink(localSessionId);
    if (!link || link.status === "revoked" || link.status === "gone") return;
    const info = this.deps.host.sessionInfo(localSessionId);
    if (!info) return;
    const before = link.status;
    try {
      // An idle pass is one small read: the session is loaded only when the server has something new or this desktop does.
      const first = await connected.client.getTranscript(link.orgSessionId, {
        cursor: String(link.pulledThrough),
      });
      if (this.sendWhenIdle.has(localSessionId) && !this.deps.host.isBusy(localSessionId)) {
        this.sendWhenIdle.delete(localSessionId);
        this.dirty.add(localSessionId);
      }
      if (first.messages.length > 0 || this.dirty.has(localSessionId)) {
        this.dirty.delete(localSessionId);
        const session = this.deps.host.loadSession(localSessionId);
        if (session) {
          try {
            await this.pull(connected.client, link, connected.me, session, first);
            await this.push(connected.client, link, session);
          } catch (error) {
            this.dirty.add(localSessionId);
            throw error;
          }
          // A reply still being written goes out when its turn ends, or on the first pass that finds it over.
          if (this.deps.host.isBusy(localSessionId)) this.sendWhenIdle.add(localSessionId);
        }
      }
      if (link.role === "owner") await this.pushTitle(link, info);
      link.status = "active";
      this.backoff.delete(localSessionId);
      this.nextAt.set(
        localSessionId,
        this.now() +
          (this.deps.host.isOpen(localSessionId) && !this.live?.isLive(localSessionId)
            ? SHARED_SYNC_OPEN_MS
            : SHARED_SYNC_BACKGROUND_MS),
      );
    } catch (error) {
      const failure = classifyOrgFailure(error);
      log.warn(`Shared session sync failed: code=${failure.code} status=${failure.status ?? 0}`);
      link.status =
        failure.code === "forbidden"
          ? "revoked"
          : failure.code === "not-found"
            ? "gone"
            : "offline";
      const delay = Math.min(
        (this.backoff.get(localSessionId) ?? SHARED_SYNC_OPEN_MS) * 2,
        SHARED_SYNC_MAX_BACKOFF_MS,
      );
      this.backoff.set(localSessionId, delay);
      this.nextAt.set(localSessionId, this.now() + delay);
    }
    await this.persist();
    if (link.status !== before) this.deps.host.changed(localSessionId);
  }

  /** Reads what the server has after this desktop's position: others' messages become display-only local ones, its own are marked sent. */
  private async pull(
    client: SharedClient,
    link: OrgSharedLinkEntry,
    me: UserPrincipal,
    session: SharedLocalSession,
    first: Awaited<ReturnType<SharedClient["getTranscript"]>>,
  ): Promise<void> {
    const mine = new Map<string, number>();
    session.messages.forEach((message, index) => mine.set(orgMessageIdFor(message.id), index));
    const adopt = link.role === "owner" ? this.adopter(link, me, session) : undefined;
    let added = false;
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const result =
        page === 0
          ? first
          : await client.getTranscript(link.orgSessionId, { cursor: String(link.pulledThrough) });
      await this.learnNames(
        client,
        result.messages
          .map((message) => message.author ?? link.ownerPrincipal)
          .filter((author) => author !== me),
      );
      result.messages.forEach((message, offset) => {
        const index = link.pulledThrough + offset;
        const ownIndex = message.id !== undefined ? mine.get(message.id) : undefined;
        if (ownIndex !== undefined) {
          this.markPushed(link, session, ownIndex);
          return;
        }
        if (adopt?.(message)) return;
        const remote = this.toRemote(link, me, message, index);
        if (remote && this.deps.host.appendRemote(link.localSessionId, remote)) added = true;
        if (remote) this.notePerson(link, remote.orgRemote!.author);
      });
      link.pulledThrough += result.messages.length;
      await this.persist();
      if (result.messages.length === 0 || result.nextCursor === undefined) break;
    }
    if (added) this.deps.host.changed(link.localSessionId);
  }

  /**
   * For the owner over a transcript uploaded before message ids: matches the owner's id-less server messages, in
   * order, to local messages by role and scrubbed text. A matched one is already on the server and here, so it is
   * neither shown again nor pushed; an unmatched one is shown as the owner's (it is missing here), and local
   * messages left unmatched are pushed (they are missing there).
   */
  private adopter(
    link: OrgSharedLinkEntry,
    me: UserPrincipal,
    session: SharedLocalSession,
  ): (message: OrgTranscriptMessage) => boolean {
    const roots = this.rootsFor(session);
    const indexOf = (id: string | undefined) =>
      id ? session.messages.findIndex((message) => message.id === id) : -1;
    let from = indexOf(link.adoptedThrough) + 1;
    const pushedIndex = indexOf(link.pushedThrough);
    const converted = new Map<number, OrgTranscriptMessage | undefined>();
    const convert = (index: number) => {
      if (!converted.has(index)) {
        const local = session.messages[index];
        converted.set(index, isShareable(local) ? toOrgTranscriptMessage(local, roots) : undefined);
      }
      return converted.get(index);
    };
    return (message) => {
      if (message.id !== undefined) return false;
      if (message.author !== undefined && message.author !== me) return false;
      for (let index = from; index < session.messages.length; index += 1) {
        const local = convert(index);
        if (local?.role !== message.role || local.text !== message.text) continue;
        from = index + 1;
        const localId = session.messages[index].id;
        link.adoptedThrough = localId;
        if (index > pushedIndex) link.onServer = [...(link.onServer ?? []), localId];
        return true;
      }
      return false;
    };
  }

  private rootsFor(session: { repoPath?: string }): Parameters<typeof toOrgTranscriptMessage>[1] {
    return { workspaceRoot: session.repoPath, homeDir: this.deps.homeDir?.() ?? os.homedir() };
  }

  private notePerson(link: OrgSharedLinkEntry, principal: string): void {
    if (this.peopleOf(link).has(principal)) return;
    const participants = [...(link.participants ?? []), principal];
    link.participants = participants.slice(-MAX_PARTICIPANTS);
  }

  private markPushed(
    link: OrgSharedLinkEntry,
    session: SharedLocalSession,
    ownIndex: number,
  ): void {
    const current = link.pushedThrough
      ? session.messages.findIndex((message) => message.id === link.pushedThrough)
      : -1;
    if (ownIndex > current) link.pushedThrough = session.messages[ownIndex].id;
  }

  private toRemote(
    link: OrgSharedLinkEntry,
    me: UserPrincipal,
    message: OrgTranscriptMessage,
    index: number,
  ): SessionMessage | undefined {
    if (message.role !== "user" && message.role !== "assistant") return undefined;
    const author = message.author ?? link.ownerPrincipal;
    return {
      // A message with a transcript id keeps the id the room delivers it under, so it is stored once.
      id:
        message.id !== undefined
          ? remoteMessageLocalId(link.orgSessionId, message.id)
          : `org-shared:${link.orgSessionId}:${index}`,
      role: message.role,
      content: message.text,
      timestamp: message.at,
      origin: "external",
      orgRemote: {
        author,
        authorLabel: author === me ? "You" : this.nameOf(author),
        fromAgent: message.role === "assistant",
      },
    };
  }

  /** Appends this person's messages after the last one the server holds, in local order; a reply waits for its turn to end. */
  private async push(
    client: SharedClient,
    link: OrgSharedLinkEntry,
    session: SharedLocalSession,
  ): Promise<void> {
    const start = link.pushedThrough
      ? session.messages.findIndex((message) => message.id === link.pushedThrough) + 1
      : 0;
    const busy = this.deps.host.isBusy(link.localSessionId);
    const roots = this.rootsFor(session);
    const onServer = new Set(link.onServer);
    const outgoing: { message: OrgTranscriptMessage; localId: string }[] = [];
    let lastSkipped: string | undefined;
    for (const local of session.messages.slice(start)) {
      if (local.role === "assistant" && busy) break;
      const converted =
        isShareable(local) && !onServer.has(local.id)
          ? toOrgTranscriptMessage(local, roots, { withId: true })
          : undefined;
      if (converted) outgoing.push({ message: converted, localId: local.id });
      else if (outgoing.length === 0) lastSkipped = local.id;
    }
    if (outgoing.length === 0) {
      if (lastSkipped && !busy) {
        link.pushedThrough = lastSkipped;
        this.forgetPushed(link, session);
        await this.persist();
      }
      return;
    }
    let sent = 0;
    for (const page of paginateTranscript(outgoing.map((entry) => entry.message))) {
      if (page.length === 0) continue;
      const ref = await client.putTranscript(link.orgSessionId, { mode: "append", messages: page });
      sent += page.length;
      link.pushedThrough = outgoing[sent - 1].localId;
      // Our own messages are now on the server: skip past them only when nobody else wrote in between.
      if (ref.messageCount === link.pulledThrough + page.length)
        link.pulledThrough = ref.messageCount;
      this.forgetPushed(link, session);
      await this.persist();
    }
  }

  /** The owner renamed the session here: the organization envelope takes the new title. */
  private async pushTitle(link: OrgSharedLinkEntry, info: SharedSessionInfo): Promise<void> {
    const title = orgTitleFor(info.name, this.rootsFor(info));
    if (link.sharedTitle === title) return;
    if (!(await this.deps.host.refreshEnvelope(link.localSessionId))) return;
    link.sharedTitle = title;
    await this.persist();
  }

  /** Adopted messages at or before `pushedThrough` no longer need remembering. */
  private forgetPushed(link: OrgSharedLinkEntry, session: SharedLocalSession): void {
    if (!link.onServer) return;
    const pushedIndex = link.pushedThrough
      ? session.messages.findIndex((message) => message.id === link.pushedThrough)
      : -1;
    const kept = link.onServer.filter(
      (id) => session.messages.findIndex((message) => message.id === id) > pushedIndex,
    );
    if (kept.length > 0) link.onServer = kept;
    else delete link.onServer;
  }
}
