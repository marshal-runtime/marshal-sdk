import {
  RoomWriteError,
  deriveRoomActor,
  type RoomActor,
  type RoomEvent,
  type RoomKindSchema,
} from "@marshal/agent-runtime-org";
import type { InvocationContext } from "@marshal/runtime";

import { createLogger } from "../../host-deps";
import { ConversationRoom, isBuiltinRoomKind } from "./rooms-conversation";
import {
  OrgRoomsManager,
  type FetchLike,
  type RoomsCaller,
  type RoomsEndpoint,
} from "./rooms-manager";
import type { RoomsSocketFactory } from "./rooms-socket";

const log = createLogger("OrgRoomsService");
const EVENT_RING = 500;
const MAX_WAIT_MS = 25_000;

export interface OrgRoomsServiceDeps {
  /** `org.rooms` and the organization's `rooms` feature: the endpoint, or undefined when off. */
  endpoint: () => Promise<RoomsEndpoint | undefined>;
  token: () => Promise<string>;
  person: () => Promise<`user:${string}` | undefined>;
  root: string;
  createSocket: RoomsSocketFactory;
  fetch?: FetchLike;
  /** `contributes.rooms` of an installed, enabled extension. */
  declarationsOf: (extensionIdentity: string) => Promise<readonly RoomKindSchema[]>;
  /**
   * The native application invocation behind a call, from the token only the native app controller
   * mints (agent tool calls have it stripped by `trustedDelegationContext`). Undefined: not a screen.
   * `extension` is the extension whose application the token was minted for.
   */
  applicationOf: (
    context: InvocationContext,
  ) => { foreground: boolean; sessionId?: string; extension: string } | undefined;
  /** The runtime and model of a Marshal session, for the agent actor. */
  describeSession: (sessionId: string) => { runtime: string; model?: string } | undefined;
  /** Push to open screens of the extension that owns the room's kind. */
  onRoomEvent?: (room: { id: string; kind: string; extension: string }, event: RoomEvent) => void;
}

export type RoomsCallerResult = { ok: true; caller: RoomsCaller } | { ok: false; code: string };

/** The extension identity a room kind belongs to: `<identity>/<short kind>`, identity possibly scoped. */
export function extensionOfKind(kind: string): string {
  const slash = kind.lastIndexOf("/");
  return slash > 0 ? kind.slice(0, slash) : kind;
}

/**
 * Rooms for the signed-in organization, behind `org.rooms`: starts the manager when the organization
 * announces `rooms`, stops it when the flag, the sign-in or the endpoint goes away.
 */
export class OrgRoomsService {
  private current: { manager: OrgRoomsManager; key: string } | undefined;
  private refreshing: Promise<void> | undefined;
  private ready = false;
  private readonly rings = new Map<
    string,
    { next: number; events: { n: number; event: RoomEvent }[] }
  >();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly deps: OrgRoomsServiceDeps) {}

  /** The running manager, or undefined while rooms are off. */
  get manager(): OrgRoomsManager | undefined {
    return this.current?.manager;
  }

  /**
   * Allows refreshes from now on and runs the first. Called after app.whenReady: the endpoint reads
   * the encrypted organization session, and safeStorage must not be touched before ready.
   */
  start(): Promise<void> {
    this.ready = true;
    return this.refresh();
  }

  /** Re-reads flag and discovery; call on org status changes and settings changes. */
  refresh(): Promise<void> {
    if (!this.ready) return Promise.resolve();
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    let endpoint: RoomsEndpoint | undefined;
    try {
      endpoint = await this.deps.endpoint();
    } catch (error) {
      log.warn("Rooms endpoint unavailable:", error instanceof Error ? error.name : "unknown");
      endpoint = undefined;
    }
    const key = endpoint
      ? `${endpoint.orgId}|${endpoint.apiBase}|${endpoint.socketUrl}`
      : undefined;
    if (this.current && this.current.key === key) return;
    this.stop();
    if (!endpoint || !key) return;
    const manager = new OrgRoomsManager({
      endpoint,
      token: this.deps.token,
      person: this.deps.person,
      root: this.deps.root,
      createSocket: this.deps.createSocket,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      onRoomEvent: (room, event) => this.onRoomEvent(room, event),
    });
    this.current = { manager, key };
    manager.start();
    log.info("Rooms started for the organization");
  }

  /** Stops rooms and refuses further refreshes (app quit). */
  shutdown(): void {
    this.ready = false;
    this.stop();
  }

  stop(): void {
    const current = this.current;
    this.current = undefined;
    current?.manager.stop();
    for (const set of this.waiters.values()) for (const wake of set) wake();
    this.waiters.clear();
    this.rings.clear();
  }

  private onRoomEvent(room: { id: string; kind: string }, event: RoomEvent): void {
    const ring = this.rings.get(room.id) ?? { next: 1, events: [] };
    ring.events.push({ n: ring.next++, event });
    if (ring.events.length > EVENT_RING) ring.events.splice(0, ring.events.length - EVENT_RING);
    this.rings.set(room.id, ring);
    for (const wake of this.waiters.get(room.id) ?? []) wake();
    // Built-in kinds (conversations) belong to the host; no extension screen gets their events.
    if (!isBuiltinRoomKind(room.kind))
      this.deps.onRoomEvent?.({ ...room, extension: extensionOfKind(room.kind) }, event);
  }

  /** The organization and person rooms act for, while rooms are on. */
  async identity(): Promise<{ orgId: string; person: `user:${string}` } | undefined> {
    const manager = this.manager;
    const person = manager ? await this.deps.person() : undefined;
    return manager && person ? { orgId: manager.orgId, person } : undefined;
  }

  /** The latest event number of a room (0 before any). */
  cursor(roomId: string): number {
    return (this.rings.get(roomId)?.next ?? 1) - 1;
  }

  /**
   * Events after `after`, waiting up to `timeoutMs` for the first one. `missed` is true when older
   * events fell out of the ring, so the caller re-reads the room instead of trusting the gap.
   */
  async wait(
    roomId: string,
    after: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ events: { n: number; event: RoomEvent }[]; cursor: number; missed: boolean }> {
    const read = () => {
      const ring = this.rings.get(roomId);
      const events = (ring?.events ?? []).filter((entry) => entry.n > after);
      const oldest = ring?.events[0]?.n;
      return {
        events,
        cursor: this.cursor(roomId),
        missed: oldest !== undefined && oldest > after + 1,
      };
    };
    const first = read();
    if (first.events.length > 0 || timeoutMs <= 0) return first;
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(roomId) ?? new Set<() => void>();
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(timeoutMs, MAX_WAIT_MS));
      signal?.addEventListener("abort", done, { once: true });
      set.add(done);
      this.waiters.set(roomId, set);
    });
    return read();
  }

  /**
   * Who is calling, from the host's own invocation context. The extension identity is the one the
   * extension manager stamped on `execute()`. The actor is a person only under a live application
   * token minted for that same extension's screen. `principal.kind`, any other metadata, a made-up
   * token, or another extension's token all leave the call acting as an agent.
   */
  async callerFor(context: InvocationContext): Promise<RoomsCallerResult> {
    const metadataIdentity = context.metadata?.runtimeExtensionIdentity;
    const extension =
      typeof metadataIdentity === "string" && metadataIdentity ? metadataIdentity : undefined;
    const resolved = this.deps.applicationOf(context);
    const application =
      resolved && extension !== undefined && resolved.extension === extension
        ? resolved
        : undefined;
    // A person's click in the extension's screen acts as the person; a background job of the
    // extension and an agent's tool call act as an agent of this desktop, tied to their session.
    const person = application?.foreground === true;
    const sessionId = application ? application.sessionId : context.scope?.sessionId;
    const derived = this.deriveActor(person, sessionId, application ? "extension-job" : "unknown");
    if (!derived.ok) return { ok: false, code: derived.code };
    return {
      ok: true,
      caller: {
        ...(extension ? { extension } : {}),
        actor: derived.actor,
        declarations: extension ? await this.deps.declarationsOf(extension) : [],
      },
    };
  }

  private deriveActor(
    person: boolean,
    sessionId: string | undefined,
    unknownRuntime: string,
  ): { ok: true; actor: RoomActor } | { ok: false; code: string } {
    const session = sessionId ? this.deps.describeSession(sessionId) : undefined;
    return deriveRoomActor({
      principalKind: person ? "user" : "agent",
      placement: "desktop",
      ...(sessionId ? { sessionId } : {}),
      ...(person ? {} : { runtime: session?.runtime ?? unknownRuntime }),
      ...(!person && session?.model ? { model: session.model } : {}),
    });
  }

  /**
   * Host code (the shared-sessions lane): the conversation room of an org session, or undefined while
   * rooms are off. Writers are the person or one of this desktop's agent sessions; the actor, with the
   * session's runtime and model, is derived here.
   */
  conversation(orgSessionId: string): ConversationRoom | undefined {
    const manager = this.manager;
    if (!manager) return undefined;
    return new ConversationRoom(
      {
        manager,
        actorOf: (writer) => {
          const derived = this.deriveActor(
            writer.kind === "person",
            writer.kind === "agent" ? writer.sessionId : undefined,
            "unknown",
          );
          if (!derived.ok) throw new RoomWriteError("forbidden", { message: derived.code });
          return derived.actor;
        },
      },
      orgSessionId,
    );
  }
}
