import { RETIRED_ROUTINES } from "@zygstinct/routines-public";
import type Database from "better-sqlite3";
import { z } from "zod";
import { instantOfNaive, naiveOf, wallOf } from "../agent-extensions/schedules/zone.js";
import { parseRoutineReport, type RoutineReport } from "./routine-report.js";

/**
 * The routine graph (docs/design/routine-graph.md): a node is a routine, lineage (`upstream`) is context, and a trigger expression is a recommendation for
 * when the node runs. This file is the pure part (schema, evaluation, validation, plain-words description) and the storage of nodes and completions.
 */
export const NODE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const STORE_WATCH_NODE = "store-watch";
export const MAX_UPSTREAMS = 8;
export const MAX_ATOMS = 8;
const EVENT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type Expr =
  | { schedule: true }
  | { manual: true }
  | { upstream: string }
  | { event: string }
  | { and: Expr[] }
  | { or: Expr[] };

export const ExprSchema: z.ZodType<Expr> = z.lazy(() => z.union([
  z.strictObject({ schedule: z.literal(true) }),
  z.strictObject({ manual: z.literal(true) }),
  z.strictObject({ upstream: z.string().regex(NODE_ID) }),
  z.strictObject({ event: z.string().regex(EVENT_NAME) }),
  z.strictObject({ and: z.array(ExprSchema).min(1).max(MAX_ATOMS) }),
  z.strictObject({ or: z.array(ExprSchema).min(1).max(MAX_ATOMS) }),
]));

/** What a node produces and what its delivery posts: editable by the owner's worker (a voice memo next to, or instead of, the video). At least one must be on. */
export const OutputsSchema = z.strictObject({ video: z.boolean(), voice: z.boolean(), text: z.boolean() })
  .refine((outputs) => outputs.video || outputs.voice || outputs.text, "at least one output");
export type Outputs = z.infer<typeof OutputsSchema>;

/** The parts of the brief the build may keep (what `zs.brief.gather {sections}` accepts); a part left out is not fetched, waited for or shown. */
export const BRIEF_SECTIONS = ["sales", "orderAlerts", "storeWatch", "attribution", "ads", "support"] as const;
/** The parts an owner can decline by name (`zs.brief.gather {omit}`); every other part is chosen by listing it in `sections`. Customer support is on by default. */
export const BRIEF_OMITTABLE = ["support"] as const;

export const GraphNodeSchema = z.strictObject({
  /**
   * Every run is a background run (strong model, may edit). A node that `delivers` ends by posting its outputs (video, text, voice memo) into the owner's DM through
   * the router, where the front answers from it; `none` sends nothing. There is no front-facing node (Omer, 2026-11-09).
   */
  delivers: z.enum(["none", "owner-dm"]),
  /** What the node builds (and, when it delivers, posts). Absent: the routine's own default. */
  outputs: OutputsSchema.optional(),
  /** The brief parts the build keeps, for the brief build only (the owner said, for example, no Meta or only anomalies and fraud). Absent: the whole brief. */
  sections: z.array(z.enum(BRIEF_SECTIONS)).min(1).max(BRIEF_SECTIONS.length).refine((list) => new Set(list).size === list.length, "duplicate section").optional(),
  /** The brief parts the owner declined by name, for the brief build only: sent as `omit`. A `sections` list that does not name support never declines it. */
  omit: z.array(z.enum(BRIEF_OMITTABLE)).min(1).max(BRIEF_OMITTABLE.length).refine((list) => new Set(list).size === list.length, "duplicate part").optional(),
  /** Local minute of day of the node's `schedule` atom, for a node with no cron of its own (the brief send). Absent: the routine's own cadence. */
  at: z.number().int().min(0).max(1439).optional(),
  /** Brief send only: the owner chose a time before the shop day can be complete and was told the brief then shows an incomplete day (MLY-688). The build runs on its own schedule and may say "so far". */
  partial: z.boolean().optional(),
  /** Lineage: the nodes this one depends on. Context for the run, not necessarily a trigger. */
  upstream: z.array(z.string().regex(NODE_ID)).max(MAX_UPSTREAMS),
  /** null: manual only. */
  trigger: ExprSchema.nullable(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export type Atom = { kind: "schedule" } | { kind: "manual" } | { kind: "upstream"; id: string } | { kind: "event"; name: string };

export function atomsOf(expr: Expr): Atom[] {
  if ("and" in expr) return expr.and.flatMap(atomsOf);
  if ("or" in expr) return expr.or.flatMap(atomsOf);
  if ("schedule" in expr) return [{ kind: "schedule" }];
  if ("manual" in expr) return [{ kind: "manual" }];
  if ("upstream" in expr) return [{ kind: "upstream", id: expr.upstream }];
  return [{ kind: "event", name: expr.event }];
}

export function evaluate(expr: Expr, truth: (atom: Atom) => boolean): boolean {
  if ("and" in expr) return expr.and.every((part) => evaluate(part, truth));
  if ("or" in expr) return expr.or.some((part) => evaluate(part, truth));
  return truth(atomsOf(expr)[0]!);
}

/** True when the expression can be true with `schedule` alone: a scheduled tick then always runs the node whatever its upstreams did. */
export const satisfiedBySchedule = (expr: Expr): boolean => evaluate(expr, (atom) => atom.kind === "schedule");

/** The events the server emits for a graph: the sync webhook, and `shop-day.ready` (Shopify holds the whole shop day; routines/shop-day-ready.ts). The retired `day-complete` stays unknown. */
export const SHOP_DAY_READY_EVENT = "shop-day.ready";
export const GRAPH_EVENTS: ReadonlySet<string> = new Set(["data.sync.completed", SHOP_DAY_READY_EVENT]);

/** The nodes of a brand's graph after an edit: every id known, every upstream atom listed as lineage, no cycle. Null when valid, else a fixed reason. */
export function validateGraph(nodes: Record<string, GraphNode>, known: ReadonlySet<string>): string | null {
  for (const [id, node] of Object.entries(nodes)) {
    if (!known.has(id)) return "unknown-node";
    if ((node.sections || node.omit) && id !== BRIEF_BUILD) return "bad-sections";
    if (node.omit && node.sections?.some((part) => (node.omit as readonly string[]).includes(part))) return "bad-sections";
    if (new Set(node.upstream).size !== node.upstream.length || node.upstream.includes(id)) return "bad-lineage";
    if (node.upstream.some((upstream) => !known.has(upstream))) return "unknown-upstream";
    if (node.trigger) {
      const atoms = atomsOf(node.trigger);
      if (atoms.length > MAX_ATOMS) return "too-many-atoms";
      if (atoms.some((atom) => atom.kind === "event" && !GRAPH_EVENTS.has(atom.name))) return "unknown-event";
      if (atoms.some((atom) => atom.kind === "upstream" && !node.upstream.includes(atom.id))) return "trigger-upstream-not-in-lineage";
    }
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cyclic = (id: string): boolean => {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    const hit = (nodes[id]?.upstream ?? []).some(cyclic);
    visiting.delete(id);
    done.add(id);
    return hit;
  };
  return Object.keys(nodes).some(cyclic) ? "cycle" : null;
}

/** A trigger in plain words for zs.routines.list and the run context. */
export function describeTrigger(expr: Expr | null, names: (id: string) => string = (id) => id): string {
  if (!expr) return "only when started by hand";
  const text = (part: Expr, nested: boolean): string => {
    if ("and" in part) { const joined = part.and.map((item) => text(item, true)).join(" and "); return nested ? `(${joined})` : joined; }
    if ("or" in part) { const joined = part.or.map((item) => text(item, true)).join(" or "); return nested ? `(${joined})` : joined; }
    if ("schedule" in part) return "its schedule";
    if ("manual" in part) return "a manual run";
    if ("upstream" in part) return `${names(part.upstream)} finishing`;
    return `the ${part.event} event`;
  };
  return `when ${text(expr, false)}`;
}

/**
 * Release defaults, used while a brand has stored nothing: the daily brief graph for a brand with the Meta analysis (UA scheduled at 05:00, the build on UA completing, the send at 11:00),
 * and every other routine on its own schedule. `brief-send` is the proactive engine's send of the built brief.
 */
export const BRIEF_BUILD = "owner-report-daily";
export const BRIEF_SEND = "brief-send";
export const DEFAULT_BRIEF_OUTPUTS: Outputs = { video: true, voice: false, text: true };
/** Guy, 2026-11-18: every owner gets the brief at 11:00 on their own clock, whatever the zone. It is still gated by the data being ready (a late shop day waits, with the late-data note). */
export const DEFAULT_SEND_MINUTE = 11 * 60;
export const ISRAEL_ZONE = "Asia/Jerusalem";
/** The local send minute of the brief: the stored `at`, else the one default. */
export const effectiveSendMinute = (node: Pick<GraphNode, "at"> | null | undefined): number => node?.at ?? DEFAULT_SEND_MINUTE;
/**
 * True when a brief sent at `minute` on the owner's local day of `nowMs` comes before the shop day the owner means by "yesterday" is complete: that day ends at the first shop midnight at or
 * after the owner's midnight, and is complete one hour later. Compared as instants, so an owner ahead of or behind the shop's zone is judged right.
 */
export function briefSendsEarly(minute: number, ownerZone: string, shopZone: string, nowMs: number): boolean {
  const owner = wallOf(nowMs, ownerZone);
  const ownerMidnight = instantOfNaive(naiveOf({ year: owner.year, month: owner.month, day: owner.day, hour: 0, minute: 0, second: 0 }), ownerZone);
  const send = instantOfNaive(naiveOf({ year: owner.year, month: owner.month, day: owner.day, hour: Math.floor(minute / 60), minute: minute % 60, second: 0 }), ownerZone);
  const shop = wallOf(ownerMidnight, shopZone);
  const atMidnight = shop.hour === 0 && shop.minute === 0 && shop.second === 0;
  const dayEnds = atMidnight ? ownerMidnight : instantOfNaive(naiveOf({ year: shop.year, month: shop.month, day: shop.day + 1, hour: 0, minute: 0, second: 0 }), shopZone);
  return send < dayEnds + 3_600_000;
}
export const DEFAULT_GRAPH: Readonly<Record<string, GraphNode>> = {
  // Guy, 2026-11-16 (Omer's approval): the Meta analysis, and so the build behind it, starts when Shopify holds the whole shop day (`shop-day.ready`), never on a clock.
  "ua-cbo": { delivers: "none", upstream: [], trigger: { event: SHOP_DAY_READY_EVENT } },
  [STORE_WATCH_NODE]: { delivers: "none", upstream: [], trigger: null },
  // Omer, 2026-11-09: the build depends only on the Meta analysis and starts when it completes; the send is the only scheduled step. Its time is not stored here: `effectiveSendMinute` takes the one default (11:00), because a hardcoded `at` hid it (Archie & Dennis got 09:00 Israel on 2026-11-18, MLY-741). A brand with no Meta analysis keeps every routine on its own schedule.
  [BRIEF_BUILD]: { delivers: "none", outputs: DEFAULT_BRIEF_OUTPUTS, upstream: ["ua-cbo"], trigger: { upstream: "ua-cbo" } },
  [BRIEF_SEND]: { delivers: "owner-dm", outputs: DEFAULT_BRIEF_OUTPUTS, upstream: [BRIEF_BUILD], trigger: { and: [{ upstream: BRIEF_BUILD }, { schedule: true }] } },
};
export const GRAPH_NODE_IDS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_GRAPH));

/**
 * The daily brief graph Omer specified (2026-11-09): UA runs on its 05:00 schedule; the brief is built in the background from UA alone (the owner's worker may add
 * upstreams); a separate send node posts it into the owner's DM at 11:00, or the moment the build finishes after 11:00.
 */
export const BRIEF_PRESET: Readonly<Record<string, GraphNode>> = {
  "ua-cbo": { delivers: "none", upstream: [], trigger: { event: SHOP_DAY_READY_EVENT } },
  [BRIEF_BUILD]: { delivers: "none", outputs: DEFAULT_BRIEF_OUTPUTS, upstream: ["ua-cbo"], trigger: { upstream: "ua-cbo" } },
  [BRIEF_SEND]: { delivers: "owner-dm", outputs: DEFAULT_BRIEF_OUTPUTS, at: 9 * 60, upstream: [BRIEF_BUILD], trigger: { and: [{ upstream: BRIEF_BUILD }, { schedule: true }] } },
};

/** What the owner's own words call each node: the run's block and the worker's lists never show the internal id of a hidden routine. */
export const NODE_LABELS: Readonly<Record<string, string>> = {
  "ua-cbo": "Meta analysis",
  "store-watch": "Store check",
  [BRIEF_BUILD]: "Daily morning brief (build)",
  [BRIEF_SEND]: "Daily morning brief (send)",
};
export const nodeLabel = (id: string): string => NODE_LABELS[id] ?? id;

/** The ids the owner's worker sees and writes: hidden or virtual nodes get a public name, mapped on the server so a model never stores an id it was not shown. */
const PUBLIC_IDS: Readonly<Record<string, string>> = { "ua-cbo": "meta-analysis", "store-watch": "store-check" };
const INTERNAL_IDS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(PUBLIC_IDS).map(([internal, pub]) => [pub, internal]));
export const publicId = (id: string): string => PUBLIC_IDS[id] ?? id;
export const internalId = (id: string): string => INTERNAL_IDS[id] ?? id;
export const PUBLIC_NODE_IDS: readonly string[] = [...GRAPH_NODE_IDS].map(publicId);

const mapExpr = (expr: Expr, map: (id: string) => string): Expr => {
  if ("and" in expr) return { and: expr.and.map((part) => mapExpr(part, map)) };
  if ("or" in expr) return { or: expr.or.map((part) => mapExpr(part, map)) };
  if ("upstream" in expr) return { upstream: map(expr.upstream) };
  return expr;
};
export const nodeToPublic = (node: GraphNode): GraphNode => ({ ...node, upstream: node.upstream.map(publicId), trigger: node.trigger ? mapExpr(node.trigger, publicId) : null });
export const nodeToInternal = (node: GraphNode): GraphNode => ({ ...node, upstream: node.upstream.map(internalId), trigger: node.trigger ? mapExpr(node.trigger, internalId) : null });

export type Completion = "success" | "failed";
export interface LedgerEntry { at: number; covers: string | null; reason: string | null }
export interface NodeState {
  lastStart: number | null;
  lastSuccess: LedgerEntry | null;
  lastFailure: LedgerEntry | null;
}

/** Reasons are the run log's short fixed words, never model text; one line, bounded. */
const reasonOf = (value: string | null | undefined): string | null => {
  const text = (value ?? "").replace(/[\u0000-\u001f\u202a-\u202e<>]+/g, " ").replace(/ {2,}/g, " ").trim();
  return text ? text.slice(0, 120) : null;
};

/** A stored node of the first release said `facing`; it reads as the delivery it meant (`front` ended with a message to the owner). */
const migrate = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null || !("facing" in raw)) return raw;
  const { facing, ...rest } = raw as Record<string, unknown>;
  return { delivers: facing === "front" ? "owner-dm" : "none", ...rest };
};

/** A ledger slot: `""` is the real one; a test chain keeps its own (`test-<id>`), so a test run never counts as the real day for any node. */
export type Slot = string;

export class RoutineGraph {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now, private readonly log: { info(event: string, fields?: Record<string, unknown>): void } = { info() {} }) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS routine_graph_nodes (
        brand_id TEXT NOT NULL, node_id TEXT NOT NULL, node_json TEXT NOT NULL, revision INTEGER NOT NULL, author TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (brand_id, node_id)
      );
      CREATE TABLE IF NOT EXISTS routine_graph_ledger (
        brand_id TEXT NOT NULL, node_id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, covers TEXT, reason TEXT
      );
      CREATE INDEX IF NOT EXISTS routine_graph_ledger_node ON routine_graph_ledger (brand_id, node_id, kind, at DESC);
      CREATE TABLE IF NOT EXISTS routine_graph_events (
        brand_id TEXT NOT NULL, name TEXT NOT NULL, day TEXT NOT NULL, slot TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, PRIMARY KEY (brand_id, name, day, slot)
      );
      CREATE TABLE IF NOT EXISTS routine_graph_reports (
        brand_id TEXT NOT NULL, node_id TEXT NOT NULL, slot TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, run TEXT, report_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS routine_graph_reports_node ON routine_graph_reports (brand_id, node_id, slot, at DESC);
      CREATE TABLE IF NOT EXISTS routine_graph_created (
        brand_id TEXT NOT NULL, node_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (brand_id, node_id)
      );
    `);
    this.retireDayCompleteTriggers();
    this.moveUaToShopDayReady();
    // A retired routine (the monthly owner report, Omer R149) leaves no stored node, upstream or created row behind.
    for (const id of RETIRED_ROUTINES) {
      db.prepare("DELETE FROM routine_graph_nodes WHERE node_id=?").run(id);
      db.prepare("DELETE FROM routine_graph_created WHERE node_id=?").run(id);
    }
    this.moveSystemSendTimesToDefault();
    if (!(db.prepare("PRAGMA table_info(routine_graph_ledger)").all() as { name: string }[]).some((column) => column.name === "slot")) {
      db.exec("ALTER TABLE routine_graph_ledger ADD COLUMN slot TEXT NOT NULL DEFAULT ''");
    }
  }

  /** The day-complete event has no emitter any more: a stored trigger that waits on it becomes the node's own schedule, so the node still runs. */
  private retireDayCompleteTriggers(): void {
    const swap = (expr: unknown): unknown => {
      if (!expr || typeof expr !== "object") return expr;
      const part = expr as Record<string, unknown>;
      if (part.event === "day-complete") return { schedule: true };
      for (const key of ["and", "or"]) if (Array.isArray(part[key])) return { ...part, [key]: (part[key] as unknown[]).map(swap) };
      return expr;
    };
    for (const row of this.db.prepare("SELECT brand_id AS brandId, node_id AS nodeId, node_json AS json FROM routine_graph_nodes WHERE node_json LIKE '%day-complete%'").all() as { brandId: string; nodeId: string; json: string }[]) {
      try {
        const node = JSON.parse(row.json) as { trigger?: unknown };
        this.db.prepare("UPDATE routine_graph_nodes SET node_json=? WHERE brand_id=? AND node_id=?").run(JSON.stringify({ ...node, trigger: swap(node.trigger) }), row.brandId, row.nodeId);
      } catch { /* an unreadable row is left for the owner to re-save */ }
    }
  }

  /**
   * Once: a stored Meta analysis that still waits on its 05:00 schedule (the old default) waits on `shop-day.ready` instead, so it starts when the shop day is complete.
   * A trigger the owner's worker changed to anything else is kept. The marker makes it one time: a later edit back to the schedule stays.
   */
  private moveUaToShopDayReady(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS routine_graph_migrations (id TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    if (this.db.prepare("INSERT OR IGNORE INTO routine_graph_migrations (id,at) VALUES ('ua-cbo-shop-day-ready',?)").run(this.now()).changes === 0) return;
    for (const row of this.db.prepare("SELECT brand_id AS brandId, node_json AS json FROM routine_graph_nodes WHERE node_id='ua-cbo'").all() as { brandId: string; json: string }[]) {
      try {
        const node = JSON.parse(row.json) as { trigger?: unknown };
        if (JSON.stringify(node.trigger) !== JSON.stringify({ schedule: true })) continue;
        this.db.prepare("UPDATE routine_graph_nodes SET node_json=? WHERE brand_id=? AND node_id='ua-cbo'").run(JSON.stringify({ ...node, trigger: { event: SHOP_DAY_READY_EVENT } }), row.brandId);
      } catch { /* an unreadable row is left for the owner to re-save */ }
    }
  }

  /**
   * Once (Guy, 2026-11-18): every owner's brief goes at 11:00, so a stored send time the system set follows the default: one written by `system` or `release` (MLY-688's move to 13:00 was
   * a `system` write), or the old 09:00 default frozen into a node an owner's worker saved from a copy of it. A time an owner chose (any other author and time) and a confirmed partial brief
   * are kept. The node loses its `at`, so it follows the default from now on; the counts go to the log. The marker makes it one time: a later change back stays.
   */
  private moveSystemSendTimesToDefault(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS routine_graph_migrations (id TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    if (this.db.prepare("INSERT OR IGNORE INTO routine_graph_migrations (id,at) VALUES ('brief-send-default-11',?)").run(this.now()).changes === 0) return;
    let moved = 0;
    let kept = 0;
    for (const row of this.db.prepare("SELECT brand_id AS brandId, node_json AS json, author FROM routine_graph_nodes WHERE node_id=?").all(BRIEF_SEND) as { brandId: string; json: string; author: string }[]) {
      try {
        const node = JSON.parse(row.json) as { at?: number; partial?: boolean };
        const systemSet = row.author === "system" || row.author === "release" || node.at === 9 * 60;
        if (node.at === undefined || node.partial === true || !systemSet || node.at === DEFAULT_SEND_MINUTE) { kept += 1; continue; }
        const { at: _dropped, ...rest } = node;
        this.db.prepare("UPDATE routine_graph_nodes SET node_json=?, revision=revision+1, author='system', updated_at=? WHERE brand_id=? AND node_id=?").run(JSON.stringify(rest), this.now(), row.brandId, BRIEF_SEND);
        moved += 1;
      } catch { kept += 1; /* an unreadable row is left for the owner to re-save */ }
    }
    this.log.info("routine.graph.send_time_migrated", { moved, kept, to: DEFAULT_SEND_MINUTE });
  }

  /** The routines an owner's worker created for this brand (plain names): graph nodes beside the release's own. */
  created(brandId: string): { id: string; name: string }[] {
    return (this.db.prepare("SELECT node_id AS id, name FROM routine_graph_created WHERE brand_id=? ORDER BY created_at, node_id").all(brandId) as { id: string; name: string }[]);
  }
  /** Forgets the created-routine rows of a brand (the routines themselves are removed by the caller). */
  forgetCreated(brandId: string): void { this.db.prepare("DELETE FROM routine_graph_created WHERE brand_id=?").run(brandId); }
  markCreated(brandId: string, nodeId: string, name: string): void {
    this.db.prepare("INSERT OR IGNORE INTO routine_graph_created (brand_id,node_id,name,created_at) VALUES (?,?,?,?)").run(brandId, nodeId, name, this.now());
  }
  /** Every node id this brand's graph knows: the release's and the ones its worker created. */
  knownIds(brandId: string): Set<string> { return new Set([...GRAPH_NODE_IDS, ...this.created(brandId).map((row) => row.id)]); }
  label(brandId: string, nodeId: string): string { return NODE_LABELS[nodeId] ?? this.created(brandId).find((row) => row.id === nodeId)?.name ?? nodeId; }

  /** The stored node of a brand, else the release default; null for an id that is not a graph node. */
  node(brandId: string, nodeId: string): GraphNode | null {
    const row = this.db.prepare("SELECT node_json FROM routine_graph_nodes WHERE brand_id=? AND node_id=?").get(brandId, nodeId) as { node_json: string } | undefined;
    if (row) { try { return GraphNodeSchema.parse(migrate(JSON.parse(row.node_json))); } catch { /* a corrupt row falls back to the default */ } }
    return DEFAULT_GRAPH[nodeId] ?? null;
  }

  /** Throws a fixed reason when `node` could not replace `nodeId` in the brand's graph (same check as setNode, nothing written). */
  validateEdit(brandId: string, nodeId: string, node: GraphNode): void { this.validateEdits(brandId, { [nodeId]: node }); }

  /** The same for several nodes at once (a change set), with `extraKnown` ids of routines created in the same set. */
  validateEdits(brandId: string, nodes: Record<string, GraphNode>, extraKnown: readonly string[] = []): void {
    const known = new Set([...this.knownIds(brandId), ...extraKnown]);
    for (const id of Object.keys(nodes)) if (!known.has(id)) throw new Error("unknown-node");
    const bad = validateGraph({ ...this.nodes(brandId, extraKnown), ...nodes }, known);
    if (bad) throw new Error(bad);
  }

  isStored(brandId: string, nodeId: string): boolean {
    return this.db.prepare("SELECT 1 FROM routine_graph_nodes WHERE brand_id=? AND node_id=?").get(brandId, nodeId) !== undefined;
  }

  /** The engine acts for a stored node, and for a release-default node that has no schedule of its own to fall back on (its trigger is an event): such a node must never run on a clock tick. */
  isActive(brandId: string, nodeId: string): boolean {
    if (this.isStored(brandId, nodeId)) return true;
    const trigger = DEFAULT_GRAPH[nodeId]?.trigger;
    return !!trigger && !satisfiedBySchedule(trigger) && !atomsOf(trigger).some((atom) => atom.kind === "schedule");
  }

  /** The day the latest `name` event covered, or null. */
  lastEventCovers(brandId: string, name: string): string | null {
    return this.lastEventDay(brandId, name);
  }

  /** Nodes of the brand whose trigger names the event. */
  triggeredByEvent(brandId: string, name: string): string[] { return this.triggeredBy(brandId, name); }

  /** Every node of the brand (stored or default), in declaration order, created ones after. */
  nodes(brandId: string, extraKnown: readonly string[] = []): Record<string, GraphNode> {
    const ids = [...GRAPH_NODE_IDS, ...this.created(brandId).map((row) => row.id), ...extraKnown];
    return Object.fromEntries(ids.map((id) => [id, this.node(brandId, id)]).filter((entry): entry is [string, GraphNode] => entry[1] !== null));
  }

  /** Replaces one node. The whole resulting graph must validate; throws a fixed reason otherwise. */
  setNode(brandId: string, nodeId: string, raw: unknown, author: string): GraphNode {
    return this.setNodes(brandId, { [nodeId]: raw }, author)[nodeId]!;
  }

  /** Replaces several nodes as one change: the whole resulting graph validates and every row is written, or nothing is (throws a fixed reason). */
  setNodes(brandId: string, raw: Record<string, unknown>, author: string, extraKnown: readonly string[] = []): Record<string, GraphNode> {
    const parsed = Object.fromEntries(Object.entries(raw).map(([id, value]) => [id, GraphNodeSchema.parse(value)]));
    this.validateEdits(brandId, parsed, extraKnown);
    this.db.transaction(() => {
      for (const [nodeId, node] of Object.entries(parsed)) {
        this.db.prepare(`INSERT INTO routine_graph_nodes (brand_id,node_id,node_json,revision,author,updated_at) VALUES (?,?,?,1,?,?)
          ON CONFLICT(brand_id,node_id) DO UPDATE SET node_json=excluded.node_json, revision=revision+1, author=excluded.author, updated_at=excluded.updated_at`)
          .run(brandId, nodeId, JSON.stringify(node), author, this.now());
      }
    })();
    return parsed;
  }

  /** Forgets every stored node of the brand: its routines are back on the release defaults (their own schedules). The ledger stays. */
  clear(brandId: string): void { this.db.prepare("DELETE FROM routine_graph_nodes WHERE brand_id=?").run(brandId); }

  /** Changes whenever any stored node of the brand changes: what a worker's read token is bound to. */
  version(brandId: string): number {
    return (this.db.prepare("SELECT COALESCE(SUM(revision),0) AS v FROM routine_graph_nodes WHERE brand_id=?").get(brandId) as { v: number }).v;
  }

  /** Brands that have stored at least one node: the only ones the engine acts for. */
  storedBrands(): string[] {
    return (this.db.prepare("SELECT DISTINCT brand_id FROM routine_graph_nodes").all() as { brand_id: string }[]).map((row) => row.brand_id);
  }

  recordStart(brandId: string, nodeId: string, at = this.now(), slot: Slot = ""): void {
    this.db.prepare("INSERT INTO routine_graph_ledger (brand_id,node_id,kind,at,covers,reason,slot) VALUES (?,?,'start',?,NULL,NULL,?)").run(brandId, nodeId, at, slot);
  }

  /** Takes back the start recorded at `at` for a fire the scheduler then refused: the node did not run, so its upstreams still count as new. */
  dropStart(brandId: string, nodeId: string, at: number, slot: Slot = ""): void {
    this.db.prepare("DELETE FROM routine_graph_ledger WHERE rowid=(SELECT rowid FROM routine_graph_ledger WHERE brand_id=? AND node_id=? AND kind='start' AND at=? AND slot=? ORDER BY rowid DESC LIMIT 1)").run(brandId, nodeId, at, slot);
  }

  recordCompletion(brandId: string, nodeId: string, kind: Completion, detail: { covers?: string | null; reason?: string | null; at?: number } = {}, slot: Slot = ""): void {
    this.db.prepare("INSERT INTO routine_graph_ledger (brand_id,node_id,kind,at,covers,reason,slot) VALUES (?,?,?,?,?,?,?)")
      .run(brandId, nodeId, kind, detail.at ?? this.now(), detail.covers ?? null, reasonOf(detail.reason), slot);
  }

  /** Keeps a run's report (the agent's own, typed): what a dependent routine reads about that run. */
  saveReport(brandId: string, nodeId: string, report: RoutineReport, run: string | null, slot: Slot = "", at = this.now()): void {
    this.db.prepare("INSERT INTO routine_graph_reports (brand_id,node_id,slot,at,run,report_json) VALUES (?,?,?,?,?,?)").run(brandId, nodeId, slot, at, run, JSON.stringify(report));
  }

  /** The latest report of a node's runs, with when it was kept; null when no run left one. */
  latestReport(brandId: string, nodeId: string, slot: Slot = ""): { at: number; run: string | null; report: RoutineReport } | null {
    const row = this.db.prepare("SELECT at, run, report_json AS json FROM routine_graph_reports WHERE brand_id=? AND node_id=? AND slot=? ORDER BY at DESC, rowid DESC LIMIT 1").get(brandId, nodeId, slot) as { at: number; run: string | null; json: string } | undefined;
    const report = row ? parseRoutineReport(row.json) : null;
    return row && report ? { at: row.at, run: row.run, report } : null;
  }

  /** The reports of a node's recent runs, newest first. */
  reports(brandId: string, nodeId: string, limit = 10, slot: Slot = ""): { at: number; run: string | null; report: RoutineReport }[] {
    const rows = this.db.prepare("SELECT at, run, report_json AS json FROM routine_graph_reports WHERE brand_id=? AND node_id=? AND slot=? ORDER BY at DESC, rowid DESC LIMIT ?").all(brandId, nodeId, slot, Math.min(Math.max(limit, 1), 50)) as { at: number; run: string | null; json: string }[];
    return rows.flatMap((row) => { const report = parseRoutineReport(row.json); return report ? [{ at: row.at, run: row.run, report }] : []; });
  }

  /** An event of the brand (`day-complete` for shop day `day`): true when it was new, false for a repeat of the same day (an event fires its nodes once per day). */
  recordEvent(brandId: string, name: string, day: string, slot: Slot = "", at = this.now()): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO routine_graph_events (brand_id,name,day,slot,at) VALUES (?,?,?,?,?)").run(brandId, name, day, slot, at).changes === 1;
  }

  /** `event(name)` for node N: the event arrived after N's latest start (never run: any arrival counts). */
  eventFresh(brandId: string, nodeId: string, name: string, slot: Slot = ""): boolean {
    const since = this.state(brandId, nodeId, slot).lastStart ?? 0;
    const row = this.db.prepare("SELECT MAX(at) AS at FROM routine_graph_events WHERE brand_id=? AND name=? AND slot=?").get(brandId, name, slot) as { at: number | null };
    return row.at !== null && row.at > since;
  }

  /** The shop day of the latest event of this name, or null. */
  lastEventDay(brandId: string, name: string, slot: Slot = ""): string | null {
    return (this.db.prepare("SELECT day FROM routine_graph_events WHERE brand_id=? AND name=? AND slot=? ORDER BY at DESC, rowid DESC LIMIT 1").get(brandId, name, slot) as { day: string } | undefined)?.day ?? null;
  }

  state(brandId: string, nodeId: string, slot: Slot = ""): NodeState {
    const latest = (kind: string): { at: number; covers: string | null; reason: string | null } | undefined =>
      this.db.prepare("SELECT at,covers,reason FROM routine_graph_ledger WHERE brand_id=? AND node_id=? AND kind=? AND slot=? ORDER BY at DESC, rowid DESC LIMIT 1").get(brandId, nodeId, kind, slot) as never;
    const start = latest("start");
    const success = latest("success");
    const failure = latest("failed");
    return {
      lastStart: start?.at ?? null,
      lastSuccess: success ? { at: success.at, covers: success.covers, reason: success.reason } : null,
      lastFailure: failure ? { at: failure.at, covers: failure.covers, reason: failure.reason } : null,
    };
  }

  /** When X last finished, done or failed: a failed run is finished too, and its report tells its dependents what is missing. */
  private finishedAt(brandId: string, upstreamId: string, slot: Slot): number | null {
    const state = this.state(brandId, upstreamId, slot);
    const ends = [state.lastSuccess?.at, state.lastFailure?.at].filter((at): at is number => typeof at === "number");
    return ends.length ? Math.max(...ends) : null;
  }

  /** `upstream(X)` for node N: X finished (done or failed) after N's latest start (never run: any finish counts). */
  upstreamFresh(brandId: string, nodeId: string, upstreamId: string, slot: Slot = ""): boolean {
    return this.upstreamFreshSince(brandId, upstreamId, this.state(brandId, nodeId, slot).lastStart ?? 0, slot);
  }

  /** `since`-relative freshness: X finished after `since`. The block of a retry asks it against the start before the fire it belongs to. */
  upstreamFreshSince(brandId: string, upstreamId: string, since: number, slot: Slot = ""): boolean {
    const finished = this.finishedAt(brandId, upstreamId, slot);
    return finished !== null && finished > since;
  }

  /** The instant of the node's `nth` most recent fire (0 = latest), or null. */
  startAt(brandId: string, nodeId: string, nth: number, slot: Slot = ""): number | null {
    const row = this.db.prepare("SELECT at FROM routine_graph_ledger WHERE brand_id=? AND node_id=? AND kind='start' AND slot=? ORDER BY at DESC, rowid DESC LIMIT 1 OFFSET ?").get(brandId, nodeId, slot, nth) as { at: number } | undefined;
    return row?.at ?? null;
  }

  /** Nodes of the brand whose trigger names `upstreamId`. */
  downstreamOf(brandId: string, upstreamId: string): string[] {
    return Object.entries(this.nodes(brandId))
      .filter(([, node]) => node.trigger !== null && atomsOf(node.trigger).some((atom) => atom.kind === "upstream" && atom.id === upstreamId))
      .map(([id]) => id);
  }

  /** Nodes of the brand whose trigger names the event. */
  triggeredBy(brandId: string, eventName: string): string[] {
    return Object.entries(this.nodes(brandId))
      .filter(([, node]) => node.trigger !== null && atomsOf(node.trigger).some((atom) => atom.kind === "event" && atom.name === eventName))
      .map(([id]) => id);
  }

  /** Every node that depends on `nodeId` through lineage (not only triggers), for the worker's impact view; direct dependents only. */
  dependents(brandId: string, nodeId: string): string[] {
    return Object.entries(this.nodes(brandId)).filter(([, node]) => node.upstream.includes(nodeId)).map(([id]) => id);
  }
}
