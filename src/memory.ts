// Memory on every host (docs/memory.md): marshal.tool.remember / recall / forget under the desktop's names and shapes,
// stored by a pluggable backend, with preferences rendered into every session's prompt. A host never defines its own
// memory tools; it picks the backend and says which scopes a session reads and writes.
import { randomUUID } from "node:crypto";

import { RUNTIME_PROTOCOL_VERSION, type CapabilityProvider, type InvocationContext } from "@marshal/runtime";

import { callerSessionId } from "./agent-provider.js";
import type { ObjectStore } from "./object-store.js";
import type { PromptMemoryEntry, SessionPromptContext } from "./prompt.js";
import { searchWords, type SessionRecord, type SessionStore } from "./session-store.js";

export const MEMORY_CATEGORIES = ["preference", "decision", "fact", "context"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/**
 * A place memories are kept for: the host's org plus a host-supplied key. Marley: `{id: "brand", key: {brand}}` and
 * `{id: "person", key: {brand, member}}`; a single-workspace host: `{id: "workspace", key: {workspace}}`.
 */
export interface MemoryScope {
  /** The scope's name as sessions use it (`appliesTo`): lower-case letters, digits, `-`, `_`. */
  id: string;
  key: Record<string, string>;
}

export interface MemoryRecord {
  v: 1;
  id: string;
  fact: string;
  category: MemoryCategory;
  /** The scope id it was saved under and its storage key. */
  scope: string;
  scopeKey: string;
  createdAt: string;
  /** Rendered into every session of its scope (preferences are always on). */
  alwaysOn: boolean;
  source: "session" | "host";
  sessionId?: string;
  /** The memory this one corrects; it was removed when this one was saved. */
  replaces?: string;
  links?: { path: string; symbol?: string }[];
}

/** Where memories live. The default keeps one object per memory in an object store; a host may plug its own (Marley: the brand corpus). */
export interface MemoryBackend {
  save(record: MemoryRecord): Promise<void>;
  /** Every memory of one scope key. */
  list(scopeKey: string): Promise<MemoryRecord[]>;
  /** Removes a memory; false when no memory of that id is in the scope key. */
  remove(scopeKey: string, id: string): Promise<boolean>;
  /** The backend's own ranking (a corpus with hybrid search). Absent: the host ranks by words. */
  search?(scopeKeys: readonly string[], query: string, limit: number): Promise<MemoryRecord[]>;
}

export interface MemoryOptions {
  /** Default: one object per memory under `sdk-memory/v1/` of the org store's bucket, else of the host's state folder. */
  backend?: MemoryBackend;
  /** The org the scope keys start with. Default: the org store's workspace, else "local". */
  org?: string;
  /** The scopes a session reads, broadest first. Default: one `workspace` scope. Writes go to the scope `appliesTo` names. */
  scopes?: (session: SessionRecord | undefined) => readonly MemoryScope[];
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

/** `<org>/<k>=<v>/...`, the folder a scope's memories live under. */
export function memoryScopeKey(org: string, scope: MemoryScope): string {
  const parts = Object.entries(scope.key)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key.replace(KEY_PART, "-")}=${String(value).replace(KEY_PART, "-")}`);
  return [org.replace(KEY_PART, "-"), ...parts].join("/");
}

/** One object per memory at `sdk-memory/v1/<scope key>/<id>.json`: no shared object, so concurrent writers never collide. */
export function objectMemoryBackend(objects: ObjectStore, root = "sdk-memory/v1"): MemoryBackend {
  const objectOf = (scopeKey: string, id: string) => `${root}/${scopeKey}/${id.replace(KEY_PART, "-")}.json`;
  return {
    async save(record) {
      await objects.put(objectOf(record.scopeKey, record.id), JSON.stringify(record), { contentType: "application/json" });
    },
    async list(scopeKey) {
      const records: MemoryRecord[] = [];
      for (const name of await objects.list(`${root}/${scopeKey}/`)) {
        if (!name.endsWith(".json") || name.slice(`${root}/${scopeKey}/`.length).includes("/")) continue;
        const bytes = await objects.get(name);
        if (!bytes) continue;
        try {
          records.push(JSON.parse(Buffer.from(bytes).toString("utf8")) as MemoryRecord);
        } catch {
          // A torn write; the other memories still read.
        }
      }
      return records;
    },
    async remove(scopeKey, id) {
      const name = objectOf(scopeKey, id);
      if (!(await objects.get(name))) return false;
      await objects.delete(name);
      return true;
    },
  };
}

/** Word ranking of memories, the same counting session search uses: one point per query word the fact contains. */
function rankByWords(records: readonly MemoryRecord[], query: string, limit: number): MemoryRecord[] {
  const words = searchWords(query);
  if (words.length === 0) return [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  return records
    .map((record) => ({ record, score: words.filter((word) => record.fact.toLowerCase().includes(word) || record.category === word).length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.record.createdAt.localeCompare(a.record.createdAt))
    .slice(0, limit)
    .map(({ record }) => record);
}

/**
 * The host's memory: tools, the prompt block and its cache. `warm(session)` runs before each turn (the port awaits it)
 * but reads the backend only for a scope this host has never seen; every other scope is served from the cache, which
 * this host's own writes keep current, and is re-read in the background at most every `refreshMs` for other hosts'
 * writes. So no turn waits on cloud I/O after a scope's first read (R31).
 */
export class HostMemory {
  private readonly cache = new Map<string, MemoryRecord[]>();
  private readonly readAt = new Map<string, number>();
  private readonly refreshing = new Map<string, Promise<void>>();
  /** Ids this host forgot: a background list that started before the removal must not bring them back. */
  private readonly forgotten = new Set<string>();
  readonly backend: MemoryBackend;
  private readonly org: string;

  constructor(
    private readonly options: MemoryOptions & { backend: MemoryBackend; org: string; workspaceName: string },
    private readonly sessions: SessionStore,
  ) {
    this.backend = options.backend;
    this.org = options.org;
  }

  scopesOf(session: SessionRecord | undefined): { scope: MemoryScope; key: string }[] {
    const scopes = this.options.scopes?.(session) ?? [{ id: "workspace", key: { workspace: this.options.workspaceName } }];
    for (const scope of scopes) if (!SCOPE_ID.test(scope.id)) throw new Error(`Invalid memory scope id "${scope.id}".`);
    return scopes.map((scope) => ({ scope, key: memoryScopeKey(this.org, scope) }));
  }

  private async read(key: string): Promise<MemoryRecord[]> {
    const startedAt = Date.now();
    const records = await this.backend.list(key);
    // A write by this host while the list ran is newer than the list: keep it.
    const written = (this.cache.get(key) ?? []).filter((record) => Date.parse(record.createdAt) >= startedAt && !records.some((listed) => listed.id === record.id));
    const merged = [...records.filter((record) => !this.forgotten.has(record.id)), ...written];
    this.cache.set(key, merged);
    this.readAt.set(key, Date.now());
    return merged;
  }

  /** Re-reads a held scope off the turn path, at most once per `refreshMs`, one read per scope at a time. */
  private refresh(key: string, log?: (line: string) => void): void {
    if (this.refreshing.has(key) || Date.now() - (this.readAt.get(key) ?? 0) < (this.options.refreshMs ?? 60_000)) return;
    const job = this.read(key)
      .then(() => undefined)
      .catch((error) => log?.(`memory: background read of ${key} failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, job);
  }

  /**
   * Before a turn: awaits the backend only for a scope this host has never read; a held scope is served from the cache
   * and refreshed in the background. A failed first read leaves the scope empty for this turn and is retried next turn.
   */
  async warm(session: SessionRecord | undefined, log?: (line: string) => void): Promise<void> {
    for (const { key } of this.scopesOf(session)) {
      if (this.readAt.has(key)) {
        this.refresh(key, log);
        continue;
      }
      try {
        await this.read(key);
      } catch (error) {
        log?.(`memory: could not read ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Waits for background reads in flight (shutdown, scripts). */
  async settle(): Promise<void> {
    await Promise.all([...this.refreshing.values()]);
  }

  /** The memory block of a session's prompt: every always-on memory of its scopes, then the newest others. */
  promptContext(session: SessionRecord | undefined): SessionPromptContext["memories"] | undefined {
    const all = this.scopesOf(session).flatMap(({ key }) => this.cache.get(key) ?? []);
    if (all.length === 0) return undefined;
    const newest = (a: MemoryRecord, b: MemoryRecord) => b.createdAt.localeCompare(a.createdAt);
    const alwaysOn = all.filter((record) => record.alwaysOn).sort(newest).slice(0, this.options.alwaysOnLimit ?? 50);
    const others = all.filter((record) => !record.alwaysOn).sort(newest);
    const shown = others.slice(0, this.options.promptLimit ?? 20);
    const entry = (record: MemoryRecord): PromptMemoryEntry => ({ fact: record.fact, category: record.category, createdAt: record.createdAt, source: record.source === "session" ? "session" : "local" });
    return { entries: [...alwaysOn, ...shown].map(entry), omittedCount: all.length - alwaysOn.length - shown.length };
  }

  async remember(
    session: SessionRecord | undefined,
    input: { fact: string; category?: string; appliesTo?: string; replaces?: string; links?: { path: string; symbol?: string }[]; alwaysOn?: boolean },
  ): Promise<MemoryRecord> {
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
    if (input.replaces) await this.forget(session, input.replaces);
    const record: MemoryRecord = {
      v: 1,
      id: randomUUID(),
      fact,
      category,
      scope: target.scope.id,
      scopeKey: target.key,
      createdAt: new Date().toISOString(),
      alwaysOn: input.alwaysOn ?? category === "preference",
      source: session ? "session" : "host",
      ...(session ? { sessionId: session.id } : {}),
      ...(input.replaces ? { replaces: input.replaces } : {}),
      ...(input.links?.length ? { links: input.links } : {}),
    };
    await this.backend.save(record);
    this.cache.set(target.key, [...(this.cache.get(target.key) ?? []).filter((existing) => existing.id !== record.id), record]);
    return record;
  }

  async recall(session: SessionRecord | undefined, query: string, limit = 10): Promise<MemoryRecord[]> {
    const keys = this.scopesOf(session).map(({ key }) => key);
    if (this.backend.search) return this.backend.search(keys, query, limit);
    const all: MemoryRecord[] = [];
    for (const key of keys) all.push(...(await this.read(key)));
    return rankByWords(all, query, limit);
  }

  /** Forgets a memory of any scope the session reads; false when none of them holds it. */
  async forget(session: SessionRecord | undefined, id: string): Promise<boolean> {
    for (const { key } of this.scopesOf(session)) {
      if (await this.backend.remove(key, id)) {
        this.forgotten.add(id);
        this.cache.set(key, (this.cache.get(key) ?? []).filter((record) => record.id !== id));
        return true;
      }
    }
    return false;
  }

  sessionOf(context: InvocationContext): SessionRecord | undefined {
    const caller = callerSessionId(context);
    return caller ? this.sessions.get(caller) : undefined;
  }
}

const TOOL_PREFIX = "marshal.tool.";
const VERSION = "1.0.0";
const RECORD_OUTPUT = {
  type: "object",
  properties: {
    id: { type: "string" },
    fact: { type: "string" },
    category: { type: "string" },
    scope: { type: "string" },
    createdAt: { type: "string" },
    alwaysOn: { type: "boolean" },
  },
} as const;

const MEMORY_TOOLS = {
  remember: {
    title: "Remember a fact",
    description:
      "Save a memory: a preference, decision, fact or context worth knowing next time. Preferences are shown in every later session of their scope; recall finds the rest. `appliesTo` names the scope (the session's scopes: see recall's output); default: a preference goes to the narrowest scope (the person), anything else to the broadest. `replaces` removes the memory it corrects.",
    input: {
      type: "object",
      required: ["fact"],
      properties: {
        fact: { type: "string", minLength: 1, maxLength: 4000 },
        category: { enum: [...MEMORY_CATEGORIES] },
        appliesTo: { type: "string", maxLength: 40 },
        replaces: { type: "string", maxLength: 200 },
        links: { type: "array", maxItems: 20, items: { type: "object", required: ["path"], properties: { path: { type: "string", maxLength: 1000 }, symbol: { type: "string", maxLength: 300 } } } },
        alwaysOn: { type: "boolean" },
      },
    },
    output: { type: "object", properties: { success: { type: "boolean" }, memory: RECORD_OUTPUT } },
  },
  recall: {
    title: "Recall memories",
    description: "Find saved memories of this session's scopes by words, best first.",
    input: { type: "object", required: ["query"], properties: { query: { type: "string", maxLength: 2000 }, limit: { type: "integer", minimum: 1, maximum: 50 } } },
    output: { type: "object", properties: { success: { type: "boolean" }, scopes: { type: "array", items: { type: "string" } }, memories: { type: "array", items: RECORD_OUTPUT } } },
  },
  forget: {
    title: "Forget a memory",
    description: "Remove a saved memory by id (from recall or the memory block).",
    input: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1, maxLength: 200 } } },
    output: { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" } } },
  },
} as const;

const shown = (record: MemoryRecord) => ({ id: record.id, fact: record.fact, category: record.category, scope: record.scope, createdAt: record.createdAt, alwaysOn: record.alwaysOn });

/** marshal.tool.remember / recall / forget on the host's memory. */
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
      switch (name.slice(TOOL_PREFIX.length)) {
        case "remember": {
          const record = await memory.remember(session, {
            fact: String(input.fact ?? ""),
            ...(typeof input.category === "string" ? { category: input.category } : {}),
            ...(typeof input.appliesTo === "string" ? { appliesTo: input.appliesTo } : {}),
            ...(typeof input.replaces === "string" ? { replaces: input.replaces } : {}),
            ...(Array.isArray(input.links) ? { links: input.links } : {}),
            ...(typeof input.alwaysOn === "boolean" ? { alwaysOn: input.alwaysOn } : {}),
          });
          return { output: { success: true, memory: shown(record) } };
        }
        case "recall": {
          const limit = Math.max(1, Math.min(typeof input.limit === "number" ? input.limit : 10, 50));
          const memories = await memory.recall(session, String(input.query ?? ""), limit);
          return { output: { success: true, scopes: memory.scopesOf(session).map(({ scope }) => scope.id), memories: memories.map(shown) } };
        }
        case "forget": {
          const removed = await memory.forget(session, String(input.id ?? ""));
          return { output: removed ? { success: true } : { success: false, error: "No memory with that id in this session's scopes." } };
        }
        default:
          throw Object.assign(new Error(`Unknown capability ${name}.`), { code: "not-found" });
      }
    },
  } as unknown as CapabilityProvider;
}
