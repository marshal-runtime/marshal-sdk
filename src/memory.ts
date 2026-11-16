// Memory on every host (docs/memory.md): marshal.tool.remember / recall / forget / link under the desktop's names,
// kept as memory nodes in a Brain graph (Spanner) with links to code, sessions, people and entities. There is no other
// store: no JSON objects, no files, no proposal a person approves. A host never defines its own memory tools; it says
// which Brain store and which scopes a session uses (`memory.store(session)`), and preferences are rendered into every
// session's prompt from a cache that no turn waits on after a scope's first read (R31).
import { RUNTIME_PROTOCOL_VERSION, type CapabilityProvider, type InvocationContext } from "@marshal/runtime";

import { callerSessionId } from "./agent-provider.js";
import type { PromptMemoryEntry, SessionPromptContext } from "./prompt.js";
import type { SessionRecord, SessionStore } from "./session-store.js";

export const MEMORY_CATEGORIES = ["preference", "decision", "fact", "context"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/**
 * A place memories are kept for, inside one Brain store. Marley: `{id: "brand", key: {brand}}` and
 * `{id: "person", key: {brand, member}}`; a single-workspace host: `{id: "workspace", key: {workspace}}`.
 */
export interface MemoryScope {
  /** The scope's name as sessions use it (`appliesTo`): lower-case letters, digits, `-`, `_`. */
  id: string;
  key: Record<string, string>;
}

/** One edge from a memory: exactly one target (a graph node, a code path with an optional symbol, a session, a person). */
export interface BrainMemoryLink {
  nodeId?: string;
  path?: string;
  symbol?: string;
  sessionId?: string;
  personId?: string;
  /** The edge's relation, e.g. `about`, `explains`, `learned_in`. The Brain picks one when absent. */
  rel?: string;
}

/** A memory node as the Brain returns it. */
export interface BrainMemory {
  id: string;
  content: string;
  category: MemoryCategory;
  /** The scope string it lives in (`scopeString`). */
  scope: string;
  /** Rendered into every session of its scope (preferences are always on). */
  alwaysOn: boolean;
  createdAt: string;
  updatedAt?: string;
  links: BrainMemoryLink[];
  /** The session that wrote it. */
  sessionId?: string;
  author?: string;
}

/**
 * A Brain store's memory operations. The company Brain's capabilities through `brainCapabilityRoute`; Marley: the
 * brand's Spanner typed-graph. Every write is a graph node or edge at once; nothing waits for a person.
 */
export interface BrainMemoryRoute {
  /** Stable per store (cache key): `zyg`, `brand:<id>`. */
  id: string;
  create(input: {
    content: string;
    category: MemoryCategory;
    scope: string;
    alwaysOn: boolean;
    links: BrainMemoryLink[];
    /** The memory this one corrects: the Brain removes it or marks it superseded. */
    supersedes?: string;
    sessionId?: string;
    author?: string;
  }): Promise<BrainMemory>;
  /** `links` replaces the memory's whole link set. */
  update(input: { id: string; content?: string; category?: MemoryCategory; alwaysOn?: boolean; links?: BrainMemoryLink[] }): Promise<BrainMemory>;
  /** Adds edges. */
  link(input: { id: string; links: BrainMemoryLink[] }): Promise<BrainMemory>;
  /** False when no memory has that id. */
  delete(input: { id: string }): Promise<boolean>;
  /** The Brain's existing hybrid search restricted to memory nodes of these scopes (its ranking, unchanged). */
  search(input: { query: string; scopes: string[]; limit: number; category?: MemoryCategory }): Promise<BrainMemory[]>;
  /** Memories of one scope, newest first: the prompt block (`alwaysOn`) and a day's review (`since`). */
  list(input: { scope: string; alwaysOn?: boolean; since?: string; limit: number }): Promise<BrainMemory[]>;
}

/** What a session's memory uses: one Brain store and the scopes it reads, broadest first. */
export interface MemoryStore {
  route: BrainMemoryRoute;
  scopes: readonly MemoryScope[];
}

export interface MemoryOptions {
  /**
   * The Brain store and scopes of a session. Default: the kit's company Brain with one `workspace` scope when the host
   * carries the kit's `memory` part; otherwise the session has no memory and the tools say so.
   */
  store?: (session: SessionRecord | undefined) => MemoryStore | undefined;
  /** Memories that are not always-on rendered into the prompt, newest first. Default 20. */
  promptLimit?: number;
  /** Always-on memories rendered at most. Default 50. */
  alwaysOnLimit?: number;
  /**
   * How often, at most, a scope this host already holds is re-read in the background to pick up other hosts' writes.
   * Default 60 s. A turn never waits for it: only the first read of a scope this host has not seen is awaited.
   */
  refreshMs?: number;
}

const SCOPE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const KEY_PART = /[^A-Za-z0-9._-]+/g;

/** `<id>:<k>=<v>/...`: the scope as the Brain stores it, an opaque equality key. */
export function scopeString(scope: MemoryScope): string {
  const parts = Object.entries(scope.key)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key.replace(KEY_PART, "-")}=${String(value).replace(KEY_PART, "-")}`);
  return `${scope.id}:${parts.join("/")}`;
}

/** Runs one Brain capability (the host's runtime, as the host). */
export type BrainCall = (capability: string, input: Record<string, unknown>) => Promise<unknown>;

/**
 * The company Brain's memory capabilities as a route: `memory.create`, `memory.update`, `memory.link`,
 * `memory.delete`, `memory.list` and `memory.search`, each taking and returning the route's shapes.
 */
export function brainCapabilityRoute(id: string, call: BrainCall): BrainMemoryRoute {
  const one = (value: unknown): BrainMemory => {
    const record = (value as { memory?: unknown })?.memory ?? value;
    return record as BrainMemory;
  };
  const many = (value: unknown): BrainMemory[] => {
    const list = (value as { memories?: unknown })?.memories ?? value;
    return Array.isArray(list) ? (list as BrainMemory[]) : [];
  };
  return {
    id,
    create: async (input) => one(await call("memory.create", input)),
    update: async (input) => one(await call("memory.update", input)),
    link: async (input) => one(await call("memory.link", input)),
    delete: async (input) => {
      const answer = (await call("memory.delete", input)) as { deleted?: boolean; success?: boolean } | boolean;
      return typeof answer === "boolean" ? answer : answer?.deleted ?? answer?.success ?? false;
    },
    search: async (input) => many(await call("memory.search", input)),
    list: async (input) => many(await call("memory.list", input)),
  };
}

const unavailable = () => Object.assign(new Error("This session has no memory store: the host connects no Brain."), { code: "unavailable" });

interface Held {
  alwaysOn: BrainMemory[];
  recent: BrainMemory[];
}

/**
 * The host's memory: tools, the prompt block and its cache. `warm(session)` runs before each turn (the port awaits it)
 * but reads the Brain only for a scope this host has never seen; every other scope is served from the cache, which this
 * host's own writes keep current, and is re-read in the background at most every `refreshMs` for other hosts' writes.
 */
export class HostMemory {
  private readonly cache = new Map<string, Held>();
  private readonly readAt = new Map<string, number>();
  private readonly refreshing = new Map<string, Promise<void>>();
  /** Ids this host deleted: a background list that started before the delete must not bring them back. */
  private readonly forgotten = new Set<string>();

  constructor(
    private readonly options: MemoryOptions & { fallback?: (session: SessionRecord | undefined) => MemoryStore | undefined },
    private readonly sessions: SessionStore,
  ) {}

  storeOf(session: SessionRecord | undefined): MemoryStore | undefined {
    const store = this.options.store?.(session) ?? this.options.fallback?.(session);
    if (!store) return undefined;
    for (const scope of store.scopes) if (!SCOPE_ID.test(scope.id)) throw new Error(`Invalid memory scope id "${scope.id}".`);
    if (store.scopes.length === 0) throw new Error("A memory store needs at least one scope.");
    return store;
  }

  scopesOf(session: SessionRecord | undefined): { scope: MemoryScope; key: string }[] {
    return (this.storeOf(session)?.scopes ?? []).map((scope) => ({ scope, key: scopeString(scope) }));
  }

  private cacheKey(route: BrainMemoryRoute, scope: string): string {
    return `${route.id}|${scope}`;
  }

  private async read(route: BrainMemoryRoute, scope: string): Promise<Held> {
    const key = this.cacheKey(route, scope);
    const startedAt = Date.now();
    const [alwaysOn, recent] = await Promise.all([
      route.list({ scope, alwaysOn: true, limit: this.options.alwaysOnLimit ?? 50 }),
      route.list({ scope, alwaysOn: false, limit: this.options.promptLimit ?? 20 }),
    ]);
    // A write by this host while the lists ran is newer than them: keep it.
    const held = this.cache.get(key);
    const newer = (records: BrainMemory[] | undefined, listed: BrainMemory[]) =>
      (records ?? []).filter((record) => Date.parse(record.updatedAt ?? record.createdAt) >= startedAt && !listed.some((other) => other.id === record.id));
    const kept = (listed: BrainMemory[]) => listed.filter((record) => !this.forgotten.has(record.id));
    const merged: Held = {
      alwaysOn: [...newer(held?.alwaysOn, alwaysOn), ...kept(alwaysOn)],
      recent: [...newer(held?.recent, recent), ...kept(recent)],
    };
    this.cache.set(key, merged);
    this.readAt.set(key, Date.now());
    return merged;
  }

  private refresh(route: BrainMemoryRoute, scope: string, log?: (line: string) => void): void {
    const key = this.cacheKey(route, scope);
    if (this.refreshing.has(key) || Date.now() - (this.readAt.get(key) ?? 0) < (this.options.refreshMs ?? 60_000)) return;
    const job = this.read(route, scope)
      .then(() => undefined)
      .catch((error) => log?.(`memory: background read of ${key} failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, job);
  }

  /**
   * Before a turn: awaits the Brain only for a scope this host has never read; a held scope is served from the cache
   * and refreshed in the background. A failed first read leaves the scope empty for this turn and is retried next turn.
   */
  async warm(session: SessionRecord | undefined, log?: (line: string) => void): Promise<void> {
    let store: MemoryStore | undefined;
    try {
      store = this.storeOf(session);
    } catch (error) {
      log?.(`memory: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!store) return;
    for (const { key: scope } of this.scopesOf(session)) {
      if (this.readAt.has(this.cacheKey(store.route, scope))) {
        this.refresh(store.route, scope, log);
        continue;
      }
      try {
        await this.read(store.route, scope);
      } catch (error) {
        log?.(`memory: could not read ${store.route.id} ${scope}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Waits for background reads in flight (shutdown, scripts). */
  async settle(): Promise<void> {
    await Promise.all([...this.refreshing.values()]);
  }

  /** The memory block of a session's prompt: every always-on memory of its scopes, then the newest others. */
  promptContext(session: SessionRecord | undefined): SessionPromptContext["memories"] | undefined {
    let store: MemoryStore | undefined;
    try {
      store = this.storeOf(session);
    } catch {
      return undefined;
    }
    if (!store) return undefined;
    const held = this.scopesOf(session).map(({ key }) => this.cache.get(this.cacheKey(store!.route, key)) ?? { alwaysOn: [], recent: [] });
    const newest = (a: BrainMemory, b: BrainMemory) => b.createdAt.localeCompare(a.createdAt);
    const alwaysOn = held.flatMap((entry) => entry.alwaysOn).sort(newest).slice(0, this.options.alwaysOnLimit ?? 50);
    const recent = held.flatMap((entry) => entry.recent).filter((record) => !record.alwaysOn).sort(newest).slice(0, this.options.promptLimit ?? 20);
    if (alwaysOn.length + recent.length === 0) return undefined;
    const entry = (record: BrainMemory): PromptMemoryEntry => ({ fact: record.content, category: record.category, createdAt: record.createdAt, source: record.sessionId ? "session" : "local" });
    return { entries: [...alwaysOn, ...recent].map(entry) };
  }

  private requireStore(session: SessionRecord | undefined): MemoryStore {
    const store = this.storeOf(session);
    if (!store) throw unavailable();
    return store;
  }

  /** Puts a memory this host just wrote or changed into the cache of its scope. */
  private hold(route: BrainMemoryRoute, record: BrainMemory): void {
    const key = this.cacheKey(route, record.scope);
    const held = this.cache.get(key) ?? { alwaysOn: [], recent: [] };
    const without = (list: BrainMemory[]) => list.filter((existing) => existing.id !== record.id);
    this.cache.set(key, record.alwaysOn ? { alwaysOn: [record, ...without(held.alwaysOn)], recent: without(held.recent) } : { alwaysOn: without(held.alwaysOn), recent: [record, ...without(held.recent)] });
  }

  private drop(route: BrainMemoryRoute, id: string): void {
    this.forgotten.add(id);
    for (const [key, held] of this.cache) {
      if (!key.startsWith(`${route.id}|`)) continue;
      this.cache.set(key, { alwaysOn: held.alwaysOn.filter((record) => record.id !== id), recent: held.recent.filter((record) => record.id !== id) });
    }
  }

  async remember(
    session: SessionRecord | undefined,
    input: { fact: string; category?: string; appliesTo?: string; replaces?: string; links?: BrainMemoryLink[]; alwaysOn?: boolean },
  ): Promise<BrainMemory> {
    const store = this.requireStore(session);
    const fact = input.fact.trim();
    if (!fact) throw Object.assign(new Error("fact is empty."), { code: "invalid-request" });
    const category: MemoryCategory = (MEMORY_CATEGORIES as readonly string[]).includes(input.category ?? "") ? (input.category as MemoryCategory) : "fact";
    const scopes = this.scopesOf(session);
    // A preference is about the person: the narrowest scope; anything else is shared: the broadest. `appliesTo` names one.
    const target = input.appliesTo
      ? scopes.find(({ scope }) => scope.id === input.appliesTo)
      : category === "preference"
        ? scopes.at(-1)
        : scopes[0];
    if (!target) throw Object.assign(new Error(`appliesTo must be one of: ${scopes.map(({ scope }) => scope.id).join(", ")}.`), { code: "invalid-request" });
    const record = await store.route.create({
      content: fact,
      category,
      scope: target.key,
      alwaysOn: input.alwaysOn ?? category === "preference",
      links: checkedLinks(input.links),
      ...(input.replaces ? { supersedes: input.replaces } : {}),
      ...(session ? { sessionId: session.id } : {}),
    });
    if (input.replaces) this.drop(store.route, input.replaces);
    this.hold(store.route, record);
    return record;
  }

  /** Finds memories by meaning (the Brain's search), or a scope's memories since a time when no query is given. */
  async recall(session: SessionRecord | undefined, input: { query?: string; since?: string; category?: string; limit?: number }): Promise<BrainMemory[]> {
    const store = this.requireStore(session);
    const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
    const scopes = this.scopesOf(session).map(({ key }) => key);
    const category = (MEMORY_CATEGORIES as readonly string[]).includes(input.category ?? "") ? (input.category as MemoryCategory) : undefined;
    const query = input.query?.trim();
    if (query) return store.route.search({ query, scopes, limit, ...(category ? { category } : {}) });
    if (!input.since) throw Object.assign(new Error("recall needs a query or since."), { code: "invalid-request" });
    const lists = await Promise.all(scopes.map((scope) => store.route.list({ scope, since: input.since, limit })));
    return lists
      .flat()
      .filter((record) => !category || record.category === category)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async link(session: SessionRecord | undefined, input: { id: string; links: BrainMemoryLink[]; replace?: boolean }): Promise<BrainMemory> {
    const store = this.requireStore(session);
    const links = checkedLinks(input.links);
    const record = input.replace ? await store.route.update({ id: input.id, links }) : await store.route.link({ id: input.id, links });
    this.hold(store.route, record);
    return record;
  }

  async update(
    session: SessionRecord | undefined,
    input: { id: string; fact?: string; category?: string; alwaysOn?: boolean },
  ): Promise<BrainMemory> {
    const store = this.requireStore(session);
    const category = (MEMORY_CATEGORIES as readonly string[]).includes(input.category ?? "") ? (input.category as MemoryCategory) : undefined;
    const record = await store.route.update({
      id: input.id,
      ...(input.fact?.trim() ? { content: input.fact.trim() } : {}),
      ...(category ? { category } : {}),
      ...(typeof input.alwaysOn === "boolean" ? { alwaysOn: input.alwaysOn } : {}),
    });
    this.hold(store.route, record);
    return record;
  }

  /** Deletes a memory node; false when the store holds no memory of that id. */
  async forget(session: SessionRecord | undefined, id: string): Promise<boolean> {
    const store = this.requireStore(session);
    const removed = await store.route.delete({ id });
    if (removed) this.drop(store.route, id);
    return removed;
  }

  sessionOf(context: InvocationContext): SessionRecord | undefined {
    const caller = callerSessionId(context);
    return caller ? this.sessions.get(caller) : undefined;
  }
}

function checkedLinks(links: readonly BrainMemoryLink[] | undefined): BrainMemoryLink[] {
  const out: BrainMemoryLink[] = [];
  for (const link of links ?? []) {
    const targets = [link.nodeId, link.path, link.sessionId, link.personId].filter((value) => typeof value === "string" && value.length > 0);
    if (targets.length !== 1) throw Object.assign(new Error("Each link names exactly one of nodeId, path, sessionId or personId."), { code: "invalid-request" });
    if (link.symbol && !link.path) throw Object.assign(new Error("A link's symbol needs its path."), { code: "invalid-request" });
    out.push(link);
  }
  return out;
}

const TOOL_PREFIX = "marshal.tool.";
const VERSION = "2.0.0";
const LINK_ITEM = {
  type: "object",
  additionalProperties: false,
  properties: {
    nodeId: { type: "string", maxLength: 300, description: "A graph node id (from knowledge.search or recall)." },
    path: { type: "string", maxLength: 1000, description: "A file the memory explains." },
    symbol: { type: "string", maxLength: 300 },
    sessionId: { type: "string", maxLength: 200, description: "The session where it was learned or that it is about." },
    personId: { type: "string", maxLength: 200, description: "The person it is about." },
    rel: { type: "string", maxLength: 60 },
  },
} as const;
const LINKS = { type: "array", maxItems: 20, items: LINK_ITEM } as const;
const RECORD_OUTPUT = {
  type: "object",
  properties: {
    id: { type: "string" },
    fact: { type: "string" },
    category: { type: "string" },
    scope: { type: "string" },
    createdAt: { type: "string" },
    alwaysOn: { type: "boolean" },
    links: LINKS,
  },
  additionalProperties: false,
} as const;

const MEMORY_TOOLS = {
  remember: {
    title: "Remember a fact",
    description:
      "Save a memory as a node in the Brain graph, at once (no approval): a preference, decision, fact or context worth knowing next time. Link it to what it is about (`links`: a graph node id, a file path and symbol, a session id, a person). Preferences are shown in every later session of their scope; recall finds the rest. `appliesTo` names the scope (recall lists them); default: a preference goes to the narrowest scope (the person), anything else to the broadest. `replaces` supersedes the memory it corrects.",
    input: {
      type: "object",
      required: ["fact"],
      properties: {
        fact: { type: "string", minLength: 1, maxLength: 4000 },
        category: { enum: [...MEMORY_CATEGORIES] },
        appliesTo: { type: "string", maxLength: 40 },
        replaces: { type: "string", maxLength: 200 },
        links: LINKS,
        alwaysOn: { type: "boolean" },
      },
    },
    output: { type: "object", properties: { success: { type: "boolean" }, memory: RECORD_OUTPUT }, additionalProperties: false },
  },
  recall: {
    title: "Recall memories",
    description:
      "Find memories of this session's scopes in the Brain graph by meaning (`query`), or list those saved since a time (`since`, ISO; e.g. today's for a review of the day), newest first.",
    input: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 2000 },
        since: { type: "string", maxLength: 40 },
        category: { enum: [...MEMORY_CATEGORIES] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
    output: { type: "object", properties: { success: { type: "boolean" }, scopes: { type: "array", items: { type: "string" } }, memories: { type: "array", items: RECORD_OUTPUT } }, additionalProperties: false },
  },
  linkMemory: {
    title: "Link a memory",
    description: "Add edges from a memory to what it is about (graph nodes, files, sessions, people); `replace: true` makes these its only links.",
    input: { type: "object", required: ["id", "links"], properties: { id: { type: "string", minLength: 1, maxLength: 200 }, links: LINKS, replace: { type: "boolean" } } },
    output: { type: "object", properties: { success: { type: "boolean" }, memory: RECORD_OUTPUT }, additionalProperties: false },
  },
  updateMemory: {
    title: "Update a memory",
    description: "Change a memory's text, category or always-on flag in place (its links stay).",
    input: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", minLength: 1, maxLength: 200 }, fact: { type: "string", maxLength: 4000 }, category: { enum: [...MEMORY_CATEGORIES] }, alwaysOn: { type: "boolean" } },
    },
    output: { type: "object", properties: { success: { type: "boolean" }, memory: RECORD_OUTPUT }, additionalProperties: false },
  },
  forget: {
    title: "Forget a memory",
    description: "Delete a memory node by id (from recall or the memory block).",
    input: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1, maxLength: 200 } } },
    output: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" } }, additionalProperties: false },
  },
} as const;

const shown = (record: BrainMemory) => ({
  id: record.id,
  fact: record.content,
  category: record.category,
  scope: record.scope,
  createdAt: record.createdAt,
  alwaysOn: record.alwaysOn,
  links: record.links ?? [],
});

/** marshal.tool.remember / recall / linkMemory / updateMemory / forget on the host's Brain memory. */
export function createMemoryToolsProvider(memory: HostMemory): CapabilityProvider {
  const descriptors = Object.entries(MEMORY_TOOLS).map(([operation, spec]) => ({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: `${TOOL_PREFIX}${operation}`,
    version: VERSION,
    title: spec.title,
    description: spec.description,
    tags: ["marshal", "memory"],
    inputSchema: spec.input,
    outputSchema: spec.output,
    permissions: [{ permission: `${TOOL_PREFIX}${operation}`, risk: "low" }],
  }));
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  return {
    id: "marshal.memory-tools",
    version: VERSION,
    list: () => descriptors,
    get: (name: string) => byName.get(name),
    invoke: async (name: string, value: unknown, context: InvocationContext) => {
      const input = (value ?? {}) as Record<string, any>;
      const session = memory.sessionOf(context);
      const links = Array.isArray(input.links) ? (input.links as BrainMemoryLink[]) : undefined;
      switch (name.slice(TOOL_PREFIX.length)) {
        case "remember": {
          const record = await memory.remember(session, {
            fact: String(input.fact ?? ""),
            ...(typeof input.category === "string" ? { category: input.category } : {}),
            ...(typeof input.appliesTo === "string" ? { appliesTo: input.appliesTo } : {}),
            ...(typeof input.replaces === "string" ? { replaces: input.replaces } : {}),
            ...(links ? { links } : {}),
            ...(typeof input.alwaysOn === "boolean" ? { alwaysOn: input.alwaysOn } : {}),
          });
          return { output: { success: true, memory: shown(record) } };
        }
        case "recall": {
          const memories = await memory.recall(session, {
            ...(typeof input.query === "string" ? { query: input.query } : {}),
            ...(typeof input.since === "string" ? { since: input.since } : {}),
            ...(typeof input.category === "string" ? { category: input.category } : {}),
            ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
          });
          return { output: { success: true, scopes: memory.scopesOf(session).map(({ scope }) => scope.id), memories: memories.map(shown) } };
        }
        case "linkMemory": {
          const record = await memory.link(session, { id: String(input.id ?? ""), links: links ?? [], replace: input.replace === true });
          return { output: { success: true, memory: shown(record) } };
        }
        case "updateMemory": {
          const record = await memory.update(session, {
            id: String(input.id ?? ""),
            ...(typeof input.fact === "string" ? { fact: input.fact } : {}),
            ...(typeof input.category === "string" ? { category: input.category } : {}),
            ...(typeof input.alwaysOn === "boolean" ? { alwaysOn: input.alwaysOn } : {}),
          });
          return { output: { success: true, memory: shown(record) } };
        }
        case "forget": {
          const removed = await memory.forget(session, String(input.id ?? ""));
          return { output: removed ? { success: true } : { success: false, error: "No memory with that id in this session's store." } };
        }
        default:
          throw Object.assign(new Error(`Unknown capability ${name}.`), { code: "not-found" });
      }
    },
  } as unknown as CapabilityProvider;
}
