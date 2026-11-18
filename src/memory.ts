// Memory on every host (docs/memory.md): marshal.tool.remember / recall / forget / link under the desktop's names,
// kept as memory nodes in a Brain graph (Spanner) with links to code, sessions, people and entities. There is no other
// store: no JSON objects, no files, no proposal a person approves. A host never defines its own memory tools; it says
// which Brain store(s) and which scopes a session uses (`memory.store(session)`: one store, or a `personal` and a
// `workspace` home, R8), and preferences are rendered into every session's prompt from a cache that no turn waits on
// after a scope's first read (R31).
import { RUNTIME_PROTOCOL_VERSION, type CapabilityProvider, type InvocationContext } from "@marshal/runtime";

import { callerSessionId } from "./agent-provider.js";
import type { JevAskRequest, JevAskResult } from "./models/jev/api.js";
import type { PromptMemoryEntry, SessionPromptContext } from "./prompt.js";
import type { SessionRecord, SessionStore } from "./session-store.js";

export const MEMORY_CATEGORIES = ["preference", "decision", "fact", "context"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/**
 * Where a memory lives (Omer R8): `personal` is the person's own home in the default Brain (preferences, private facts
 * such as a birthday), shown in every workspace; `workspace` is the session workspace's own Brain, where a memory links
 * to that workspace's real code nodes.
 */
export const MEMORY_HOMES = ["personal", "workspace"] as const;
export type MemoryHome = (typeof MEMORY_HOMES)[number];

/**
 * A place memories are kept for, inside one Brain store. Marley: `{id: "brand", key: {brand}}` and
 * `{id: "person", key: {brand, member}}`; a single-workspace host: `{id: "workspace", key: {workspace}}`.
 */
export interface MemoryScope {
  /** The scope's name as sessions use it (`appliesTo`): lower-case letters, digits, `-`, `_`. */
  id: string;
  key: Record<string, string>;
  /**
   * A single bare value instead of `key`: the scope string is `<id>:<name>`, the name as given. The workspace home uses
   * it (`workspace:<workspace name>`), byte for byte the desktop's `workspaceScope` and the Brain extension's default.
   */
  name?: string;
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
  /** The home of the store it was read from or written to (set by the host when the session's store has one). */
  home?: MemoryHome;
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
    /** An import of an existing memory: the same id written again replaces that node (idempotent), and createdAt keeps its date. */
    id?: string;
    createdAt?: string;
  }): Promise<BrainMemory>;
  /** `links` replaces the memory's whole link set. `scopes`: the session's scopes, where the memory is looked for. */
  update(input: { id: string; scopes: string[]; content?: string; category?: MemoryCategory; alwaysOn?: boolean; links?: BrainMemoryLink[] }): Promise<BrainMemory>;
  /** Adds edges. */
  link(input: { id: string; scopes: string[]; links: BrainMemoryLink[] }): Promise<BrainMemory>;
  /** False when no memory of the session's scopes has that id. */
  delete(input: { id: string; scopes: string[] }): Promise<boolean>;
  /** The Brain's existing hybrid search restricted to memory nodes of these scopes (its ranking, unchanged). */
  search(input: { query: string; scopes: string[]; limit: number; category?: MemoryCategory }): Promise<BrainMemory[]>;
  /** Memories of one scope, newest first: the prompt block (`alwaysOn`) and a day's review (`since`). */
  list(input: { scope: string; alwaysOn?: boolean; since?: string; limit: number }): Promise<BrainMemory[]>;
}

/** What a session's memory uses: one Brain store and the scopes it reads, broadest first. */
export interface MemoryStore {
  route: BrainMemoryRoute;
  scopes: readonly MemoryScope[];
  /** Required when a session has several stores (one per home); a single store may leave it out. */
  home?: MemoryHome;
}

export interface MemoryOptions {
  /**
   * The Brain store(s) and scopes of a session: one store, or one per home (`personal` and `workspace`). Default: the
   * kit's company Brain when the host carries the kit's `memory` part, as a `workspace` home and, when the person is
   * known (`personEmail`), a `personal` home; otherwise the session has no memory and the tools say so.
   */
  store?: (session: SessionRecord | undefined) => MemoryStore | readonly MemoryStore[] | undefined;
  /**
   * The person this host works for (lower-case work email). With the kit's company Brain it gives every session a
   * `personal` home (scope `person:email=<email>`). Default: the kit's `brain.callerEmail`. Never taken from model input.
   */
  personEmail?: string;
  /**
   * How a session's memory block is filled (R153). `relevant`: on the session's first turn each home's Brain search runs
   * with the task, a judgement keeps the memories that shape it, and only those are rendered, with their ids. `newest`:
   * every always-on memory, then the newest others. Default: `relevant` for the kit's company Brain, `newest` for a
   * host's own `store` (Marley's brand graph).
   */
  promptMemories?: "relevant" | "newest";
  /** Relevant memories rendered at most. Default 8. */
  relevantLimit?: number;
  /** Search hits per home the judgement looks at. Default 12. */
  relevantCandidates?: number;
  /**
   * Which of the candidate memories shape this task (the ids kept). Default: the host's decide service
   * (`decideRelevance`). Without one, or when it fails, the top `RELEVANT_FALLBACK` hits by search rank are kept.
   */
  relevance?: RelevanceJudge;
  /**
   * What to search the Brain for, from a turn's message: no queries when the message gives no task yet (a warm-up such
   * as "reply ready"), so the choice waits for the turn that does. Default: the host's decide service (`decideQueries`).
   * Without one, or when it fails, the message's head is the query.
   */
  queries?: MemoryQueryPlanner;
  /** `newest` mode: memories that are not always-on rendered into the prompt, newest first. Default 20. */
  promptLimit?: number;
  /** `newest` mode: always-on memories rendered at most. Default 50. */
  alwaysOnLimit?: number;
  /**
   * How often, at most, a scope this host already holds is re-read in the background to pick up other hosts' writes.
   * Default 60 s. A turn never waits for it: only the first read of a scope this host has not seen is awaited.
   */
  refreshMs?: number;
}

/** Decides which candidate memories shape a task; returns the ids to keep. */
export type RelevanceJudge = (input: { task: string; memories: readonly BrainMemory[] }) => Promise<ReadonlySet<string>>;

/**
 * Search queries for a turn's message, empty when the message gives no task yet, and a one-sentence `task` naming its
 * subject (what the relevance judgement reads in place of a long message).
 */
export type MemoryQueryPlanner = (input: { message: string }) => Promise<{ queries: readonly string[]; task?: string }>;

/** Hits kept by search rank alone when no judgement is available. */
export const RELEVANT_FALLBACK = 3;
/** The Brain's memory.search takes at most 500 characters. */
const SEARCH_QUERY_MAX = 500;
const JUDGED_TASK_MAX = 6000;
const PLANNED_QUERIES_MAX = 3;

/** A long message's head and tail (a task's subject often sits in a brief after long instructions). */
export function taskExcerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 5) / 2);
  return `${text.slice(0, half)}\n...\n${text.slice(text.length - half)}`;
}

type DecideCall = (
  request: { question: string; context?: unknown; schema?: Readonly<Record<string, unknown>> },
  options?: { timeoutMs?: number },
) => Promise<{ choice: unknown }>;

/**
 * Query planning on the host's decide service: it reads the whole message (a Page Studio brief names its brand only in
 * the input data, ~44k characters in) and answers whether it gives a task, the task in one sentence, and 0 to 3 queries.
 * `gives_task` comes first: asked for queries alone, the model returned none for a task it called one.
 */
export function decideQueries(decide: DecideCall, options: { timeoutMs?: number; maxChars?: number } = {}): MemoryQueryPlanner {
  return async ({ message }) => {
    const result = await decide(
      {
        question:
          "context.message was just sent to an agent; read all of it, including any input data or brief inside it. Decide gives_task: true when the message asks the agent to do or produce work (plan, build, edit, review, answer); " +
          "false only when it asks for nothing but an acknowledgement such as replying 'ready'. When gives_task is true: task is one sentence naming what the work is and who or what it is for (the specific brand, product, page, codebase or people named in the message); " +
          "queries are 1 to 3 short search queries (each under 200 characters) for the long-term memory of the person and team the agent works for, each naming that specific subject, so remembered rules, preferences and decisions about it are found. " +
          "When gives_task is false, task is empty and queries is empty.",
        context: { message: taskExcerpt(message, options.maxChars ?? 200_000) },
        schema: {
          type: "object",
          properties: { gives_task: { type: "boolean" }, task: { type: "string" }, queries: { type: "array", items: { type: "string" } } },
          required: ["gives_task", "task", "queries"],
          additionalProperties: false,
        },
      },
      { timeoutMs: options.timeoutMs ?? 30_000 },
    );
    const answer = result.choice as { gives_task?: unknown; task?: unknown; queries?: unknown } | undefined;
    if (typeof answer?.gives_task !== "boolean" || !Array.isArray(answer.queries)) throw new Error("the query planner answered no task decision");
    if (!answer.gives_task) return { queries: [] };
    const queries = answer.queries
      .filter((query): query is string => typeof query === "string" && query.trim().length > 0)
      .map((query) => query.trim().slice(0, SEARCH_QUERY_MAX))
      .slice(0, PLANNED_QUERIES_MAX);
    const task = typeof answer.task === "string" && answer.task.trim() ? answer.task.trim() : undefined;
    return { queries: queries.length || !task ? queries : [task.slice(0, SEARCH_QUERY_MAX)], ...(task ? { task } : {}) };
  };
}

type JudgeCall = (request: JevAskRequest, options?: { timeoutMs?: number }) => Promise<JevAskResult>;

/**
 * A relevance judgement on the host's decide service: one yes/no question per candidate memory over one state (the task
 * and the memories' text), kept when the probability that it shapes the task reaches `threshold`.
 */
export function decideRelevance(judge: JudgeCall, options: { threshold?: number; timeoutMs?: number } = {}): RelevanceJudge {
  const threshold = options.threshold ?? 0.5;
  return async ({ task, memories }) => {
    if (memories.length === 0) return new Set();
    const key = (index: number) => `m${index}`;
    const result = await judge(
      {
        state: { task, memories: Object.fromEntries(memories.map((record, index) => [key(index), record.content])) },
        questions: Object.fromEntries(
          memories.map((_, index) => [
            key(index),
            {
              type: "noul" as const,
              instructions:
                `Should remembered memory ${key(index)} (in state.memories) change how the task in state.task is done? ` +
                "True when it is about the task's own subject (the same brand, product, page, codebase or kind of work) or states how the person wants this kind of work done. " +
                "False when it is about a different brand, product, codebase or topic, or would not change the result.",
            },
          ]),
        ),
      },
      { timeoutMs: options.timeoutMs ?? 20_000 },
    );
    const kept = new Set<string>();
    memories.forEach((record, index) => {
      const answer = result.answers[key(index)];
      if (answer && "noul" in answer && answer.noul >= threshold) kept.add(record.id);
    });
    return kept;
  };
}

const SCOPE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
// `@` stays so a person scope is `person:email=<email>`, the form the Brain checks the writer against.
const KEY_PART = /[^A-Za-z0-9._@-]+/g;

/** `<id>:<k>=<v>/...`: the scope as the Brain stores it, an opaque equality key. */
export function scopeString(scope: MemoryScope): string {
  if (scope.name !== undefined) return `${scope.id}:${scope.name}`;
  const parts = Object.entries(scope.key)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key.replace(KEY_PART, "-")}=${String(value).replace(KEY_PART, "-")}`);
  return `${scope.id}:${parts.join("/")}`;
}

/** Runs one Brain capability (the host's runtime, as the host). */
export type BrainCall = (capability: string, input: Record<string, unknown>) => Promise<unknown>;

/**
 * The company Brain's memory capabilities as a route: `memory.create`, `memory.update`, `memory.link`,
 * `memory.delete`, `memory.list` and `memory.search`, each taking and returning the route's shapes. With `home`, every
 * call carries it, so the Brain extension uses that home's Brain only (the host merges the homes itself).
 */
export function brainCapabilityRoute(id: string, rawCall: BrainCall, options: { home?: MemoryHome } = {}): BrainMemoryRoute {
  const call: BrainCall = options.home ? (capability, input) => rawCall(capability, capability.startsWith("memory.") ? { ...input, home: options.home } : input) : rawCall;
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
    search: async (input) => {
      try {
        return many(await call("memory.search", input));
      } catch (error) {
        if (!missing(error)) throw error;
        // A Brain extension without memory.search yet: its memory nodes through knowledge.search (read-only).
        const found = (await call("knowledge.search", { query: input.query, kinds: ["memory"], limit: input.limit })) as { hits?: { node?: Record<string, any>; snippet?: string }[] };
        return (found.hits ?? []).flatMap((hit) => {
          const node = hit.node;
          const content = String(node?.snippet ?? hit.snippet ?? node?.name ?? "").trim();
          if (!node?.id || !content) return [];
          return [{ id: String(node.id), content, category: "fact" as MemoryCategory, scope: input.scopes[0] ?? "", alwaysOn: false, createdAt: String(node.props?.createdAt ?? node.updatedAt ?? ""), links: [] }];
        });
      }
    },
    list: async (input) => {
      try {
        return many(await call("memory.list", input));
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
    },
  };
}

/**
 * The kit's default stores on the company Brain extension (R8): a `workspace` home (scope `workspace:<name>`,
 * the extension routes it to the workspace's own Brain) and, when the person is known, a `personal` home (scope
 * `person:email=<email>`, the extension's pinned `memoryRoute`). Every call carries its home.
 */
export function companyBrainStores(call: BrainCall, input: { workspace: string; personEmail?: string }): MemoryStore[] {
  const email = input.personEmail?.trim().toLowerCase();
  return [
    ...(email ? [{ home: "personal" as const, route: brainCapabilityRoute("brain:personal", call, { home: "personal" }), scopes: [{ id: "person", key: { email } }] }] : []),
    { home: "workspace" as const, route: brainCapabilityRoute("brain:workspace", call, { home: "workspace" }), scopes: [{ id: "workspace", key: {}, name: input.workspace }] },
  ];
}

/** The Brain extension does not have that capability (yet). */
const missing = (error: unknown): boolean => {
  const code = String((error as { code?: unknown })?.code ?? "");
  return code === "not_found" || code === "not-found" || /capability_not_found|not registered|unknown capability/i.test(String((error as Error)?.message ?? ""));
};

const unavailable = () => Object.assign(new Error("This session has no memory store: the host connects no Brain."), { code: "unavailable" });

interface Held {
  alwaysOn: BrainMemory[];
  recent: BrainMemory[];
}

/** Personal first: its always-on memories open the prompt block and it is tried first for an id. */
/** The company Brain's company-wide memories: every session's, whatever its homes. */
const ORG_SCOPE = "org";
/** The home a scope string belongs to by its id (`person:…` personal, `workspace:…` workspace); others have none. */
const scopeHome = (scope: string | undefined): MemoryHome | undefined =>
  scope?.startsWith("person:") ? "personal" : scope?.startsWith("workspace:") ? "workspace" : undefined;
const homeRank = (home: MemoryHome | undefined) => (home === "personal" ? 0 : home === "workspace" ? 1 : 2);

const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid-request" });

/**
 * The host's memory: tools, the prompt block and its cache. `warm(session)` runs before each turn (the port awaits it)
 * but reads the Brain only for a scope this host has never seen; every other scope is served from the cache, which this
 * host's own writes keep current, and is re-read in the background at most every `refreshMs` for other hosts' writes.
 * A session may have one store, or one per home (`personal`, `workspace`): writes go to one home, reads merge both.
 */
export class HostMemory {
  private readonly cache = new Map<string, Held>();
  private readonly readAt = new Map<string, number>();
  private readonly refreshing = new Map<string, Promise<void>>();
  /** Ids this host deleted: a background list that started before the delete must not bring them back. */
  private readonly forgotten = new Set<string>();
  /** `relevant` mode: the memories chosen for each session on its first turn. */
  private readonly relevant = new Map<string, BrainMemory[]>();
  private judge: RelevanceJudge | undefined;
  private planner: MemoryQueryPlanner | undefined;

  constructor(
    private readonly options: MemoryOptions & { fallback?: (session: SessionRecord | undefined) => MemoryStore | readonly MemoryStore[] | undefined },
    private readonly sessions: SessionStore,
  ) {
    this.judge = options.relevance;
    this.planner = options.queries;
  }

  /** The host's default query planning (its decide service), used unless the options name one. */
  useQueryPlanner(planner: MemoryQueryPlanner): void {
    this.planner ??= planner;
  }

  /** The host's default judgement (its decide service), used unless the options name one. */
  useRelevance(judge: RelevanceJudge): void {
    this.judge ??= judge;
  }

  private mode(): "relevant" | "newest" {
    return this.options.promptMemories ?? (this.options.store ? "newest" : "relevant");
  }

  /** The session's stores, personal first; empty when the session has no memory. */
  storesOf(session: SessionRecord | undefined): MemoryStore[] {
    const given = this.options.store?.(session) ?? this.options.fallback?.(session);
    if (!given) return [];
    const stores = Array.isArray(given) ? [...(given as readonly MemoryStore[])] : [given as MemoryStore];
    const homes = new Set<string>();
    for (const store of stores) {
      for (const scope of store.scopes) if (!SCOPE_ID.test(scope.id)) throw new Error(`Invalid memory scope id "${scope.id}".`);
      if (store.scopes.length === 0) throw new Error("A memory store needs at least one scope.");
      if (stores.length > 1) {
        if (!store.home) throw new Error("Each of a session's memory stores needs a home (personal or workspace).");
        if (homes.has(store.home)) throw new Error(`Two memory stores have the home "${store.home}".`);
        homes.add(store.home);
      }
    }
    return stores.sort((a, b) => homeRank(a.home) - homeRank(b.home));
  }

  /** The session's first store (personal when it has one). */
  storeOf(session: SessionRecord | undefined): MemoryStore | undefined {
    return this.storesOf(session)[0];
  }

  scopesOf(session: SessionRecord | undefined): { scope: MemoryScope; key: string; store: MemoryStore }[] {
    return this.storesOf(session).flatMap((store) => store.scopes.map((scope) => ({ scope, key: scopeString(scope), store })));
  }

  private cacheKey(store: MemoryStore, scope: string): string {
    return `${store.route.id}|${store.home ?? ""}|${scope}`;
  }

  // A Brain whose search ignores the scopes it is given (the company Brain on a cloud host, R153) returns the caller's
  // own personal memories to a session that has only the workspace home: only the session's own scopes are kept, plus
  // the company's `org` memories, which belong to every session (as in memory-typed-graph.ts).
  private ofSession(stores: readonly MemoryStore[], records: BrainMemory[]): BrainMemory[] {
    const scopes = new Set(stores.flatMap((store) => store.scopes.map(scopeString)));
    return records.filter((record) => record.scope === ORG_SCOPE || scopes.has(record.scope));
  }

  // A record's own scope names its home. The route's tag does not: a Brain whose search ignores `home` (the company
  // Brain on a cloud host, R153) returns a workspace memory through the personal home too, tagged `personal`.
  private tagged(store: MemoryStore, records: BrainMemory[]): BrainMemory[] {
    return store.home ? records.map((record) => ({ ...record, home: scopeHome(record.scope) ?? record.home ?? store.home })) : records;
  }

  private async read(store: MemoryStore, scope: string): Promise<Held> {
    const key = this.cacheKey(store, scope);
    const startedAt = Date.now();
    const [alwaysOn, recent] = await Promise.all([
      store.route.list({ scope, alwaysOn: true, limit: this.options.alwaysOnLimit ?? 50 }),
      store.route.list({ scope, alwaysOn: false, limit: this.options.promptLimit ?? 20 }),
    ]);
    // A write by this host while the lists ran is newer than them: keep it.
    const held = this.cache.get(key);
    const newer = (records: BrainMemory[] | undefined, listed: BrainMemory[]) =>
      (records ?? []).filter((record) => Date.parse(record.updatedAt ?? record.createdAt) >= startedAt && !listed.some((other) => other.id === record.id));
    const kept = (listed: BrainMemory[]) => this.tagged(store, listed.filter((record) => !this.forgotten.has(record.id)));
    const merged: Held = {
      alwaysOn: [...newer(held?.alwaysOn, alwaysOn), ...kept(alwaysOn)],
      recent: [...newer(held?.recent, recent), ...kept(recent)],
    };
    this.cache.set(key, merged);
    this.readAt.set(key, Date.now());
    return merged;
  }

  private refresh(store: MemoryStore, scope: string, log?: (line: string) => void): void {
    const key = this.cacheKey(store, scope);
    if (this.refreshing.has(key) || Date.now() - (this.readAt.get(key) ?? 0) < (this.options.refreshMs ?? 60_000)) return;
    const job = this.read(store, scope)
      .then(() => undefined)
      .catch((error) => log?.(`memory: background read of ${key} failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, job);
  }

  /**
   * Before a turn: awaits the Brain only for a scope this host has never read; a held scope is served from the cache
   * and refreshed in the background. A failed first read leaves the scope empty for this turn and is retried next turn.
   */
  async warm(session: SessionRecord | undefined, log?: (line: string) => void, task?: string): Promise<void> {
    let scopes: ReturnType<HostMemory["scopesOf"]>;
    try {
      scopes = this.scopesOf(session);
    } catch (error) {
      log?.(`memory: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (this.mode() === "relevant") {
      if (session && scopes.length > 0) await this.chooseRelevant(session, task, log);
      return;
    }
    // Homes are read side by side: a slow Brain of one home does not hold up the other.
    await Promise.all(
      this.storesOf(session).map(async (store) => {
        for (const { key: scope } of scopes.filter((entry) => entry.store === store)) {
          if (this.readAt.has(this.cacheKey(store, scope))) {
            this.refresh(store, scope, log);
            continue;
          }
          try {
            await this.read(store, scope);
          } catch (error) {
            log?.(`memory: could not read ${store.route.id}${store.home ? ` (${store.home})` : ""} ${scope}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }),
    );
  }

  /**
   * `relevant` mode, a session's first turn with a task: each home's Brain search with the task, homes interleaved by
   * rank, then the judgement keeps the memories that shape it. Later turns reuse the choice (`recall` serves mid-task
   * lookups). When every home fails, nothing is held and the next turn tries again.
   */
  private async chooseRelevant(session: SessionRecord, task: string | undefined, log?: (line: string) => void): Promise<void> {
    if (this.relevant.has(session.id)) return;
    const text = task?.trim();
    if (!text) return;
    const head = text.replace(/\s+/g, " ").slice(0, SEARCH_QUERY_MAX);
    let queries: readonly string[] = [head];
    let summary: string | undefined;
    if (this.planner) {
      try {
        const plan = await this.planner({ message: text });
        queries = plan.queries;
        summary = plan.task;
      } catch (error) {
        log?.(`memory: query planning failed, searching with the message head: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (queries.length === 0) {
        log?.(`memory: no task in this turn yet for session ${session.id}; memories are chosen on a later turn`);
        return;
      }
    }
    const stores = this.storesOf(session);
    const perQuery = this.options.relevantCandidates ?? 12;
    // One store's hits: its queries' lists interleaved by rank.
    const results = await Promise.allSettled(
      stores.map(async (store) => {
        const scopes = store.scopes.map(scopeString);
        const lists = await Promise.all(queries.map((query) => store.route.search({ query, scopes, limit: perQuery })));
        const merged: BrainMemory[] = [];
        for (let rank = 0; rank < Math.max(0, ...lists.map((list) => list.length)); rank++) {
          for (const list of lists) if (list[rank]) merged.push(list[rank]!);
        }
        return this.tagged(store, this.ofSession(stores, merged));
      }),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") log?.(`memory: relevance search of ${stores[index]!.home ?? stores[index]!.route.id} failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    });
    if (results.every((result) => result.status === "rejected")) return;
    const lists = results.map((result) => (result.status === "fulfilled" ? result.value.filter((record) => !this.forgotten.has(record.id)) : []));
    const seen = new Set<string>();
    const candidates: BrainMemory[] = [];
    for (let rank = 0; rank < Math.max(0, ...lists.map((list) => list.length)); rank++) {
      for (const list of lists) {
        const record = list[rank];
        if (!record || seen.has(record.id)) continue;
        seen.add(record.id);
        candidates.push(record);
      }
    }
    const limit = this.options.relevantLimit ?? 8;
    let chosen: BrainMemory[];
    let how: string;
    try {
      if (!this.judge) throw new Error("no relevance judgement on this host");
      const kept = candidates.length ? await this.judge({ task: summary ? `${summary}\n\n${taskExcerpt(text, JUDGED_TASK_MAX)}` : taskExcerpt(text, JUDGED_TASK_MAX), memories: candidates }) : new Set<string>();
      chosen = candidates.filter((record) => kept.has(record.id)).slice(0, limit);
      how = "judged";
    } catch (error) {
      chosen = candidates.slice(0, Math.min(limit, RELEVANT_FALLBACK));
      how = `search rank only (${error instanceof Error ? error.message : String(error)})`;
    }
    this.relevant.set(session.id, chosen);
    log?.(`memory: ${chosen.length} of ${candidates.length} memories loaded by relevance (${how}; ${summary ? `task ${JSON.stringify(summary)}; ` : ""}queries ${JSON.stringify(queries)}) for session ${session.id}${chosen.length ? `: ${chosen.map((record) => `${record.id} [${record.home ?? record.scope}]`).join(", ")}` : ""}`);
  }

  /** Waits for background reads in flight (shutdown, scripts). */
  async settle(): Promise<void> {
    await Promise.all([...this.refreshing.values()]);
  }

  /**
   * The memory block of a session's prompt: the always-on memories of each home in turn (personal first, newest first
   * within a home), then the newest others of every home.
   */
  promptContext(session: SessionRecord | undefined): SessionPromptContext["memories"] | undefined {
    let scopes: ReturnType<HostMemory["scopesOf"]>;
    try {
      scopes = this.scopesOf(session);
    } catch {
      return undefined;
    }
    if (scopes.length === 0) return undefined;
    if (this.mode() === "relevant") {
      const chosen = (session ? this.relevant.get(session.id) ?? [] : []).filter((record) => !this.forgotten.has(record.id));
      if (chosen.length === 0) return undefined;
      return {
        entries: chosen.map((record): PromptMemoryEntry => ({ fact: `${record.content} (memory ${record.id})`, category: record.category, createdAt: record.createdAt, source: "brain" })),
        framing: "chosen",
      };
    }
    const newest = (a: BrainMemory, b: BrainMemory) => b.createdAt.localeCompare(a.createdAt);
    const heldOf = (store: MemoryStore) =>
      scopes.filter((entry) => entry.store === store).map(({ key }) => this.cache.get(this.cacheKey(store, key)) ?? { alwaysOn: [], recent: [] });
    const stores = this.storesOf(session);
    const alwaysOn = stores.flatMap((store) => heldOf(store).flatMap((entry) => entry.alwaysOn).sort(newest)).slice(0, this.options.alwaysOnLimit ?? 50);
    const recent = stores
      .flatMap((store) => heldOf(store).flatMap((entry) => entry.recent))
      .filter((record) => !record.alwaysOn)
      .sort(newest)
      .slice(0, this.options.promptLimit ?? 20);
    if (alwaysOn.length + recent.length === 0) return undefined;
    const entry = (record: BrainMemory): PromptMemoryEntry => ({ fact: record.content, category: record.category, createdAt: record.createdAt, source: record.sessionId ? "session" : "local" });
    return { entries: [...alwaysOn, ...recent].map(entry) };
  }

  private requireStores(session: SessionRecord | undefined): MemoryStore[] {
    const stores = this.storesOf(session);
    if (stores.length === 0) throw unavailable();
    return stores;
  }

  /** Puts a memory this host just wrote or changed into the cache of its scope. */
  private hold(store: MemoryStore, record: BrainMemory): BrainMemory {
    const [tagged] = this.tagged(store, [record]);
    const key = this.cacheKey(store, tagged!.scope);
    const held = this.cache.get(key) ?? { alwaysOn: [], recent: [] };
    const without = (list: BrainMemory[]) => list.filter((existing) => existing.id !== tagged!.id);
    this.cache.set(key, tagged!.alwaysOn ? { alwaysOn: [tagged!, ...without(held.alwaysOn)], recent: without(held.recent) } : { alwaysOn: without(held.alwaysOn), recent: [tagged!, ...without(held.recent)] });
    for (const [sessionId, chosen] of this.relevant) {
      if (chosen.some((record) => record.id === tagged!.id)) this.relevant.set(sessionId, chosen.map((record) => (record.id === tagged!.id ? tagged! : record)));
    }
    return tagged!;
  }

  private drop(route: BrainMemoryRoute, id: string): void {
    this.forgotten.add(id);
    for (const [key, held] of this.cache) {
      if (!key.startsWith(`${route.id}|`)) continue;
      this.cache.set(key, { alwaysOn: held.alwaysOn.filter((record) => record.id !== id), recent: held.recent.filter((record) => record.id !== id) });
    }
  }

  /** The stores to try for a memory by id: the one whose cache holds it first, then the rest in home order. */
  private storesFor(session: SessionRecord | undefined, id: string): MemoryStore[] {
    const stores = this.requireStores(session);
    const holds = (store: MemoryStore) =>
      store.scopes.some((scope) => {
        const held = this.cache.get(this.cacheKey(store, scopeString(scope)));
        return !!held && [...held.alwaysOn, ...held.recent].some((record) => record.id === id);
      });
    return [...stores.filter(holds), ...stores.filter((store) => !holds(store))];
  }

  /** Runs a write by id on each candidate store until one has the memory; the first error is thrown when none does. */
  private async byId<T>(session: SessionRecord | undefined, id: string, run: (store: MemoryStore, scopes: string[]) => Promise<T>): Promise<{ store: MemoryStore; value: T }> {
    let first: unknown;
    for (const store of this.storesFor(session, id)) {
      try {
        return { store, value: await run(store, store.scopes.map(scopeString)) };
      } catch (error) {
        first ??= error;
      }
    }
    throw first;
  }

  async remember(
    session: SessionRecord | undefined,
    input: { fact: string; category?: string; appliesTo?: string; replaces?: string; links?: BrainMemoryLink[]; alwaysOn?: boolean; home?: string },
  ): Promise<BrainMemory> {
    const stores = this.requireStores(session);
    const fact = input.fact.trim();
    if (!fact) throw invalid("fact is empty.");
    const category: MemoryCategory = (MEMORY_CATEGORIES as readonly string[]).includes(input.category ?? "") ? (input.category as MemoryCategory) : "fact";
    if (input.home !== undefined && !(MEMORY_HOMES as readonly string[]).includes(input.home)) throw invalid(`home must be one of: ${MEMORY_HOMES.join(", ")}.`);
    const homed = stores.length > 1 || stores[0]!.home !== undefined;
    // An explicit home must exist when the session has homes; a single store without a home takes every write.
    let candidates = stores;
    if (input.home && homed) {
      candidates = stores.filter((store) => store.home === input.home);
      if (candidates.length === 0) throw invalid(`This session has no ${input.home} memory home; its homes: ${stores.map((store) => store.home).join(", ")}.`);
    }
    let store: MemoryStore;
    let scope: MemoryScope | undefined;
    if (input.appliesTo) {
      const found = candidates.flatMap((each) => each.scopes.map((entry) => ({ store: each, scope: entry }))).find((entry) => entry.scope.id === input.appliesTo);
      if (!found) throw invalid(`appliesTo must be one of: ${candidates.flatMap((each) => each.scopes.map((entry) => entry.id)).join(", ")}.`);
      ({ store, scope } = found);
    } else {
      // Default home (R8): a preference is the person's; anything else belongs to the workspace. Missing homes fall back.
      const wanted: MemoryHome = category === "preference" ? "personal" : "workspace";
      store = input.home || !homed ? candidates[0]! : (candidates.find((each) => each.home === wanted) ?? candidates[0]!);
      // Within a store: a preference goes to the narrowest scope (the person), anything else to the broadest.
      scope = category === "preference" ? store.scopes.at(-1) : store.scopes[0];
    }
    const record = await store.route.create({
      content: fact,
      category,
      scope: scopeString(scope!),
      alwaysOn: input.alwaysOn ?? category === "preference",
      links: checkedLinks(input.links),
      ...(input.replaces ? { supersedes: input.replaces } : {}),
      ...(session ? { sessionId: session.id } : {}),
    });
    if (input.replaces) this.drop(store.route, input.replaces);
    return this.hold(store, record);
  }

  /**
   * Finds memories by meaning (each home's Brain search, merged by rank), or the scopes' memories since a time when no
   * query is given. `degraded` names a home whose Brain could not be read; the other home's memories still come back.
   */
  async recallWithStatus(
    session: SessionRecord | undefined,
    input: { query?: string; since?: string; category?: string; limit?: number },
  ): Promise<{ memories: BrainMemory[]; degraded: string[] }> {
    const stores = this.requireStores(session);
    const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
    const category = (MEMORY_CATEGORIES as readonly string[]).includes(input.category ?? "") ? (input.category as MemoryCategory) : undefined;
    const query = input.query?.trim();
    if (!query && !input.since) throw invalid("recall needs a query or since.");
    const results = await Promise.allSettled(
      stores.map(async (store) => {
        const scopes = store.scopes.map(scopeString);
        if (query) return this.tagged(store, this.ofSession(stores, await store.route.search({ query, scopes, limit, ...(category ? { category } : {}) })));
        const lists = await Promise.all(scopes.map((scope) => store.route.list({ scope, since: input.since, limit })));
        return this.tagged(store, this.ofSession(stores, lists.flat()));
      }),
    );
    const failed = results.flatMap((result, index) => (result.status === "rejected" ? [{ store: stores[index]!, reason: result.reason }] : []));
    if (failed.length === results.length) throw failed[0]!.reason;
    const degraded = failed.map(({ store }) => store.home ?? store.route.id);
    const lists = results.map((result) => (result.status === "fulfilled" ? result.value : []));
    const seen = new Set<string>();
    const unique = (record: BrainMemory) => (seen.has(record.id) ? false : (seen.add(record.id), true));
    if (query) {
      // Each home's own ranking is kept; the homes are interleaved by rank (1st of each, then 2nd of each, ...).
      const merged: BrainMemory[] = [];
      for (let rank = 0; rank < Math.max(0, ...lists.map((list) => list.length)); rank++) for (const list of lists) if (list[rank]) merged.push(list[rank]!);
      return { memories: merged.filter(unique).slice(0, limit), degraded };
    }
    return {
      memories: lists
        .flat()
        .filter((record) => !category || record.category === category)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .filter(unique)
        .slice(0, limit),
      degraded,
    };
  }

  async recall(session: SessionRecord | undefined, input: { query?: string; since?: string; category?: string; limit?: number }): Promise<BrainMemory[]> {
    return (await this.recallWithStatus(session, input)).memories;
  }

  async link(session: SessionRecord | undefined, input: { id: string; links: BrainMemoryLink[]; replace?: boolean }): Promise<BrainMemory> {
    const links = checkedLinks(input.links);
    const { store, value } = await this.byId(session, input.id, (each, scopes) =>
      input.replace ? each.route.update({ id: input.id, scopes, links }) : each.route.link({ id: input.id, scopes, links }),
    );
    return this.hold(store, value);
  }

  async update(
    session: SessionRecord | undefined,
    input: { id: string; fact?: string; category?: string; alwaysOn?: boolean },
  ): Promise<BrainMemory> {
    const category = (MEMORY_CATEGORIES as readonly string[]).includes(input.category ?? "") ? (input.category as MemoryCategory) : undefined;
    const { store, value } = await this.byId(session, input.id, (each, scopes) =>
      each.route.update({
        id: input.id,
        scopes,
        ...(input.fact?.trim() ? { content: input.fact.trim() } : {}),
        ...(category ? { category } : {}),
        ...(typeof input.alwaysOn === "boolean" ? { alwaysOn: input.alwaysOn } : {}),
      }),
    );
    return this.hold(store, value);
  }

  /** Deletes a memory node; false when no store of the session holds a memory of that id. */
  async forget(session: SessionRecord | undefined, id: string): Promise<boolean> {
    let first: unknown;
    for (const store of this.storesFor(session, id)) {
      try {
        const removed = await store.route.delete({ id, scopes: store.scopes.map(scopeString) });
        if (removed) {
          this.drop(store.route, id);
          return true;
        }
      } catch (error) {
        first ??= error;
      }
    }
    // A store that failed may be the one holding it: say so rather than "no such memory".
    if (first !== undefined) throw first;
    return false;
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
    home: { enum: [...MEMORY_HOMES] },
  },
  additionalProperties: false,
} as const;

const MEMORY_TOOLS = {
  remember: {
    title: "Remember a fact",
    description:
      "Save a memory as a node in the Brain graph, at once (no approval): a preference, decision, fact or context worth knowing next time. `home`: `personal` is yours in every workspace (preferences, private facts such as a birthday); `workspace` is this workspace's own Brain, where links reach its real code (conventions, gotchas, why code is the way it is). Always name it (without it a preference is personal, anything else workspace). Link it to what it is about (`links`: a graph node id, a file path and symbol, a session id, a person). Preferences are shown in every later session; recall finds the rest. `appliesTo` names a scope (recall lists them). `replaces` supersedes the memory it corrects.",
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
        home: { enum: [...MEMORY_HOMES] },
      },
    },
    output: { type: "object", properties: { success: { type: "boolean" }, memory: RECORD_OUTPUT }, additionalProperties: false },
  },
  recall: {
    title: "Recall memories",
    description:
      "Find memories of this session's scopes in the Brain graph by meaning (`query`; both homes, personal and workspace, merged by rank), or list those saved since a time (`since`, ISO; e.g. today's for a review of the day), newest first. `degraded` names a home that could not be read.",
    input: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 2000 },
        since: { type: "string", maxLength: 40 },
        category: { enum: [...MEMORY_CATEGORIES] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
    output: {
      type: "object",
      properties: { success: { type: "boolean" }, scopes: { type: "array", items: { type: "string" } }, memories: { type: "array", items: RECORD_OUTPUT }, degraded: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    },
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
  ...(record.home ? { home: record.home } : {}),
});

const FAILED_WRITE = {
  save: { prefix: "MEMORY NOT SAVED", tail: "Tell the user it was not saved." },
  forget: { prefix: "MEMORY NOT FORGOTTEN", tail: "Tell the user it was not forgotten." },
} as const;
const RUNTIME_ERROR_CODES = new Set(["invalid-request", "not-found", "permission-denied", "operation-failed"]);

/**
 * A memory write that did not happen, as a thrown error so the tool call fails (ok: false) instead of answering a
 * success-shaped payload an agent can skim past. The message leads with MEMORY NOT SAVED / MEMORY NOT FORGOTTEN and tells
 * the agent to report it; the reason is cut so the message fits the runtime's 512-character error limit.
 */
export function memoryWriteFailure(kind: keyof typeof FAILED_WRITE, error: unknown, code?: string): Error & { code: string } {
  const { prefix, tail } = FAILED_WRITE[kind];
  const budget = 512 - prefix.length - tail.length - 4;
  const reason = (error instanceof Error ? error.message : String(error)).trim().replace(/[.\s]+$/, "") || "unknown error";
  const why = reason.length > budget ? `${reason.slice(0, budget - 1)}…` : reason;
  const upstream = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const resolved = code ?? (typeof upstream === "string" && RUNTIME_ERROR_CODES.has(upstream) ? upstream : "operation-failed");
  return Object.assign(new Error(`${prefix}: ${why}. ${tail}`), { code: resolved });
}

/** Runs one memory write; any failure is rethrown as memoryWriteFailure. */
async function writing<T>(kind: keyof typeof FAILED_WRITE, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw memoryWriteFailure(kind, error);
  }
}

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
          const record = await writing("save", () => memory.remember(session, {
            fact: String(input.fact ?? ""),
            ...(typeof input.category === "string" ? { category: input.category } : {}),
            ...(typeof input.appliesTo === "string" ? { appliesTo: input.appliesTo } : {}),
            ...(typeof input.replaces === "string" ? { replaces: input.replaces } : {}),
            ...(links ? { links } : {}),
            ...(typeof input.alwaysOn === "boolean" ? { alwaysOn: input.alwaysOn } : {}),
            ...(typeof input.home === "string" ? { home: input.home } : {}),
          }));
          return { output: { success: true, memory: shown(record) } };
        }
        case "recall": {
          const { memories, degraded } = await memory.recallWithStatus(session, {
            ...(typeof input.query === "string" ? { query: input.query } : {}),
            ...(typeof input.since === "string" ? { since: input.since } : {}),
            ...(typeof input.category === "string" ? { category: input.category } : {}),
            ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
          });
          const scopes = [...new Set(memory.scopesOf(session).map(({ scope }) => scope.id))];
          return { output: { success: true, scopes, memories: memories.map(shown), ...(degraded.length ? { degraded } : {}) } };
        }
        case "linkMemory": {
          const record = await writing("save", () => memory.link(session, { id: String(input.id ?? ""), links: links ?? [], replace: input.replace === true }));
          return { output: { success: true, memory: shown(record) } };
        }
        case "updateMemory": {
          const record = await writing("save", () => memory.update(session, {
            id: String(input.id ?? ""),
            ...(typeof input.fact === "string" ? { fact: input.fact } : {}),
            ...(typeof input.category === "string" ? { category: input.category } : {}),
            ...(typeof input.alwaysOn === "boolean" ? { alwaysOn: input.alwaysOn } : {}),
          }));
          return { output: { success: true, memory: shown(record) } };
        }
        case "forget": {
          const removed = await writing("forget", () => memory.forget(session, String(input.id ?? "")));
          if (!removed) throw memoryWriteFailure("forget", "No memory with that id in this session's store", "not-found");
          return { output: { success: true } };
        }
        default:
          throw Object.assign(new Error(`Unknown capability ${name}.`), { code: "not-found" });
      }
    },
  } as unknown as CapabilityProvider;
}
