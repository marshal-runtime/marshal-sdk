// A BrainMemoryRoute over a Quillstone typed-graph service (@quillstone/typed-graph's memory ops), so a host that holds a
// Brain store in-process (Marley's server for a brand, the company Brain's own host) passes its `execute` and how a scope
// maps to a store id, and writes no memory code of its own. The SDK takes no dependency on the package: `execute` is
// `service.execute` (or anything with its shape).
import { MEMORY_CATEGORIES, type BrainMemory, type BrainMemoryLink, type BrainMemoryRoute, type MemoryCategory } from "./memory.js";

/** `service.execute({op, storeId, tenant, call})` of a typed-graph service. */
export type TypedGraphExecute = (request: { op: string; storeId: string; tenant: string; call: Record<string, unknown> }) => Promise<unknown>;

export interface TypedGraphMemoryRouteOptions {
  /** Stable per Brain (cache key), e.g. `brand:<uuid>`. */
  id: string;
  execute: TypedGraphExecute;
  /** The tenant the service authorizes the store under. */
  tenant: string;
  /** The already-authorized store id a scope string lives in (Marley: `zs/<brand>/brand/brand-only`, `zs/<brand>/member/<sha256>`). */
  storeOf(scope: string): string;
  /** Access tags a memory written to a scope carries (Marley: `["staff"]` for the brand, `["person:<id>"]` for a member). Default: the store's own. */
  accessOf?(scope: string): readonly string[] | undefined;
  /**
   * Merges one search's hits from several stores into one order of ids. Each hit carries the store's raw keyword (`lex`)
   * and vector (`sim`) signals, so a host can fuse across stores with its own fusion (Marley: `fuseAcrossStores`), never
   * by comparing the stores' own fused scores. Default: the stores' lists interleaved by rank.
   */
  merge?(lists: readonly { scope: string; hits: readonly TypedGraphHit[] }[], limit: number): string[];
}

/** One memorySearch hit, with the raw signals the store ranked it by. */
export interface TypedGraphHit {
  id: string;
  score?: number;
  lex?: number;
  sim?: number;
}

/** The typed-graph's link shape: one target per link. */
type GraphLink = { target: string; rel?: string } | { path: string; symbol?: string; rel?: string } | { sessionId: string; rel?: string } | { personId: string; rel?: string };

interface GraphMemory {
  id: string;
  category: string | null;
  content: string;
  links?: readonly { rel?: string; to?: string; link?: GraphLink }[];
  author?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  supersededBy?: string | null;
  alwaysOn?: boolean;
  sessionId?: string | null;
  properties?: Record<string, unknown>;
}

const toGraph = (link: BrainMemoryLink): GraphLink => {
  const rel = link.rel ? { rel: link.rel } : {};
  if (link.nodeId) return { target: link.nodeId, ...rel };
  if (link.path) return { path: link.path, ...(link.symbol ? { symbol: link.symbol } : {}), ...rel };
  if (link.sessionId) return { sessionId: link.sessionId, ...rel };
  return { personId: String(link.personId), ...rel };
};

const fromGraph = (edge: { rel?: string; to?: string; link?: GraphLink }): BrainMemoryLink => {
  const rel = edge.rel ? { rel: edge.rel } : {};
  const link = edge.link as Record<string, string> | undefined;
  if (link?.target) return { nodeId: link.target, ...rel };
  if (link?.path) return { path: link.path, ...(link.symbol ? { symbol: link.symbol } : {}), ...rel };
  if (link?.sessionId) return { sessionId: link.sessionId, ...rel };
  if (link?.personId) return { personId: link.personId, ...rel };
  return { nodeId: String(edge.to ?? ""), ...rel };
};

const categoryOf = (value: string | null | undefined): MemoryCategory =>
  (MEMORY_CATEGORIES as readonly string[]).includes(value ?? "") ? (value as MemoryCategory) : "fact";

/** A Brain memory the host shows: preferences (and memories saved with `alwaysOn`) are always on. */
function record(memory: GraphMemory, scope: string): BrainMemory {
  const properties = memory.properties ?? {};
  const createdAt = memory.createdAt ?? new Date(0).toISOString();
  return {
    id: memory.id,
    content: memory.content,
    category: categoryOf(memory.category),
    scope: typeof properties.scope === "string" ? properties.scope : scope,
    alwaysOn: memory.alwaysOn ?? properties.alwaysOn === true,
    createdAt,
    ...(memory.updatedAt ? { updatedAt: memory.updatedAt } : {}),
    links: (memory.links ?? []).map(fromGraph),
    ...(memory.sessionId ? { sessionId: memory.sessionId } : typeof properties.sessionId === "string" ? { sessionId: properties.sessionId } : {}),
    ...(memory.author ? { author: memory.author } : {}),
  };
}

/**
 * The route: each scope is its own store (`storeOf`); a memory's own scope is kept in its properties. Writes by id find
 * the store that holds the id among the session's scopes. Search runs the store's own search (the typed-graph's corpus
 * algorithm, unchanged) per store and interleaves the stores' results by rank, never by comparing their scores.
 */
export function typedGraphMemoryRoute(options: TypedGraphMemoryRouteOptions): BrainMemoryRoute {
  const run = (scope: string, op: string, call: Record<string, unknown>) =>
    options.execute({ op, storeId: options.storeOf(scope), tenant: options.tenant, call });
  const get = async (scope: string, ids: string[]): Promise<GraphMemory[]> =>
    ((await run(scope, "memoryGet", { ids })) as { memories?: GraphMemory[] }).memories ?? [];
  /** The scope among `scopes` whose store holds `id`. */
  const holder = async (id: string, scopes: readonly string[]): Promise<{ scope: string; memory: GraphMemory } | undefined> => {
    for (const scope of scopes) {
      const [memory] = await get(scope, [id]);
      if (memory) return { scope, memory };
    }
    return undefined;
  };
  const notFound = (id: string) => Object.assign(new Error(`No memory ${id} in this session's stores.`), { code: "not-found" });

  return {
    id: options.id,
    async create(input) {
      const category = input.category;
      const access = options.accessOf?.(input.scope);
      const created = (await run(input.scope, "memoryCreate", {
        content: input.content,
        category,
        links: input.links.map(toGraph),
        ...(input.supersedes ? { supersedes: [input.supersedes] } : {}),
        ...(input.author ? { author: input.author } : {}),
        alwaysOn: input.alwaysOn,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(access?.length ? { access } : {}),
        properties: { scope: input.scope },
      })) as { id: string };
      const [stored] = await get(input.scope, [created.id]);
      if (stored) return record(stored, input.scope);
      const now = new Date().toISOString();
      return { id: created.id, content: input.content, category, scope: input.scope, alwaysOn: input.alwaysOn, createdAt: now, links: input.links, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
    },
    async update(input) {
      const found = await holder(input.id, input.scopes);
      if (!found) throw notFound(input.id);
      await run(found.scope, "memoryUpdate", {
        id: input.id,
        ...(input.content ? { content: input.content } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(typeof input.alwaysOn === "boolean" ? { alwaysOn: input.alwaysOn } : {}),
        ...(input.links ? { links: input.links.map(toGraph) } : {}),
      });
      const [stored] = await get(found.scope, [input.id]);
      return record(stored ?? found.memory, found.scope);
    },
    async link(input) {
      const found = await holder(input.id, input.scopes);
      if (!found) throw notFound(input.id);
      await run(found.scope, "memoryLink", { id: input.id, links: input.links.map(toGraph) });
      const [stored] = await get(found.scope, [input.id]);
      return record(stored ?? found.memory, found.scope);
    },
    async delete(input) {
      const found = await holder(input.id, input.scopes);
      if (!found) return false;
      const answer = (await run(found.scope, "memoryDelete", { id: input.id })) as { deleted?: boolean };
      return answer.deleted === true;
    },
    async search(input) {
      const lists = await Promise.all(
        input.scopes.map(async (scope) => {
          const found = (await run(scope, "memorySearch", { query: input.query, limit: input.limit, ...(input.category ? { category: input.category } : {}) })) as {
            hits?: TypedGraphHit[];
          };
          return { scope, hits: found.hits ?? [] };
        }),
      );
      const order = options.merge ? options.merge(lists, input.limit) : interleave(lists, input.limit);
      const scopeOf = new Map<string, string>();
      for (const { scope, hits } of lists) for (const hit of hits) if (!scopeOf.has(hit.id)) scopeOf.set(hit.id, scope);
      const byScope = new Map<string, string[]>();
      for (const id of order) {
        const scope = scopeOf.get(id);
        if (scope) byScope.set(scope, [...(byScope.get(scope) ?? []), id]);
      }
      const records = new Map<string, BrainMemory>();
      await Promise.all(
        [...byScope].map(async ([scope, ids]) => {
          for (const memory of await get(scope, ids)) if (!memory.supersededBy) records.set(memory.id, record(memory, scope));
        }),
      );
      return order.flatMap((id) => (records.has(id) ? [records.get(id)!] : [])).slice(0, input.limit);
    },
    async list(input) {
      const found = (await run(input.scope, "memoryList", {
        ...(typeof input.alwaysOn === "boolean" ? { alwaysOn: input.alwaysOn } : {}),
        ...(input.since ? { since: input.since } : {}),
        limit: Math.min(input.limit, 200),
      })) as { memories?: GraphMemory[] };
      const memories = (found.memories ?? []).filter((memory) => !memory.supersededBy).map((memory) => record(memory, input.scope));
      return memories;
    },
  };
}

/** The stores' hit lists interleaved by rank (first of each store, then second...), each id once. */
function interleave(lists: readonly { hits: readonly TypedGraphHit[] }[], limit: number): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (let rank = 0; order.length < limit && lists.some((list) => rank < list.hits.length); rank += 1) {
    for (const list of lists) {
      const hit = list.hits[rank];
      if (hit && !seen.has(hit.id) && order.length < limit) {
        seen.add(hit.id);
        order.push(hit.id);
      }
    }
  }
  return order;
}
