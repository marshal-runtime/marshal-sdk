import { z } from "zod";
import { UA_CBO, UA_CBO_DEFINITION, UA_CBO_ENABLED } from "./catalog.js";

const MetaId = z.string().regex(/^[1-9][0-9]{0,29}$/);
const Day = z.iso.date();
const Instant = z.string().datetime({ offset: true });
const Money = z.string().max(40).regex(/^-?\d+(\.\d+)?$/);
const Conversions = z.string().max(40).regex(/^\d+(\.\d+)?$/);
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Window = z.object({ start: Day, end: Day }).strict(); // Half-open brand-local dates.
const Scope = z.object({ brandId: z.string().uuid(), accountId: MetaId,
  timezone: z.string().min(1).max(80), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
const Envelope = Scope.extend({ source: z.string(), window: Window }).strict();
const Coverage = z.object({ start: Day, end: Day, completedAt: Instant }).strict();
const Entity = z.object({ id: MetaId, level: z.enum(["campaign", "adset", "ad"]), parentId: MetaId.nullable(),
  name: z.string().min(1).max(500), effectiveStatus: z.string().min(1).max(80),
  createdAt: Instant.nullable().optional(), bidStrategy: z.string().min(1).max(80).nullable().optional(),
  bidAmountMinor: z.string().regex(/^\d+$/).nullable().optional(),
  dailyMinSpendTargetMinor: z.string().regex(/^\d+$/).nullable().optional(), dailySpendCapMinor: z.string().regex(/^\d+$/).nullable().optional(),
  budget: z.object({ period: z.enum(["daily", "lifetime"]), amountMinor: z.string().regex(/^\d+$/).max(30) }).strict().nullable() }).strict();
const Meta = Envelope.extend({ source: z.literal("meta"), observedAt: Instant, entities: z.array(Entity),
  accountCurrency: z.string().regex(/^[A-Z]{3}$/).optional(), accountTimezone: z.string().min(1).max(80).optional() }).strict();
const MetaHistory = Envelope.extend({ source: z.literal("metaHistory"), coverage: Coverage,
  attributionWindow: z.string().min(1).max(120), rows: z.array(z.object({ day: Day, entityId: MetaId,
    spend: Money, impressions: Count, clicks: Count, reach: Count.nullable().optional(), purchases: Conversions, purchaseValue: Money }).strict()) }).strict();
const Shopify = Envelope.extend({ source: z.literal("shopify"), coverage: Coverage,
  rows: z.array(z.object({ day: Day, orders: Count, newCustomerOrders: Count,
    grossSales: Money, refunds: Money, netSales: Money }).strict()) }).strict();
const TripleWhale = Envelope.extend({ source: z.literal("tripleWhale"), coverage: Coverage,
  attributionModel: z.string().min(1).max(120), attributionWindow: z.string().min(1).max(120),
  rows: z.array(z.object({ day: Day, adId: MetaId, orders: Conversions, revenue: Money }).strict()),
  levelRows: z.array(z.object({ day: Day, entityId: MetaId, orders: Conversions, revenue: Money }).strict()).default([]) }).strict();

const Pack = z.object({ schemaVersion: z.literal(1), routineId: z.literal(UA_CBO), scope: Scope, window: Window,
  startedAt: Instant, capturedAt: Instant, meta: Meta, metaHistory: MetaHistory, shopify: Shopify, tripleWhale: TripleWhale }).strict();
type Pack = z.infer<typeof Pack>;
export type UaScope = z.infer<typeof Scope>;
export type UaWindow = z.infer<typeof Window>;
type Source = typeof UA_CBO_DEFINITION.requiredSources[number];
export type UaSnapshotReaders = { readonly [Name in Source]: (scope: Readonly<UaScope>, window: Readonly<UaWindow>) => Promise<unknown | null> };

function requireFact(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function localDay(at: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
function checkWindow(window: UaWindow, scope: UaScope, at: number) {
  requireFact(window.start < window.end && window.end <= localDay(at, scope.timezone), "closed brand-local days required");
}
function validate(pack: Pack) {
  const { scope, window } = pack;
  const started = Date.parse(pack.startedAt), captured = Date.parse(pack.capturedAt);
  requireFact(started <= captured, "invalid capture interval");
  checkWindow(window, scope, started);
  const observed = Date.parse(pack.meta.observedAt);
  requireFact(observed >= started && observed <= captured, "live Meta state must be observed during capture");
  for (const source of UA_CBO_DEFINITION.requiredSources) {
    const evidence = pack[source];
    requireFact(Object.keys(scope).every((key) => evidence[key as keyof UaScope] === scope[key as keyof UaScope]), "source scope mismatch");
    requireFact(evidence.window.start === window.start && evidence.window.end === window.end, "source window mismatch");
    if ("coverage" in evidence) requireFact(evidence.coverage.start <= window.start && evidence.coverage.end >= window.end &&
      evidence.coverage.end <= localDay(Date.parse(evidence.coverage.completedAt), scope.timezone) &&
      Date.parse(evidence.coverage.completedAt) <= captured, "completed source coverage required");
  }
  const entities = new Map(pack.meta.entities.map((entity) => [entity.id, entity]));
  requireFact(entities.size === pack.meta.entities.length, "duplicate Meta entity");
  for (const entity of entities.values()) {
    requireFact(entity.level === "campaign" ? entity.parentId === null :
      entities.get(entity.parentId ?? "")?.level === (entity.level === "adset" ? "campaign" : "adset"), "invalid Meta ancestry");
    requireFact(entity.level !== "ad" || entity.budget === null, "ad cannot own a budget");
  }
  for (const source of ["metaHistory", "shopify", "tripleWhale"] as const) {
    const grains = new Set<string>();
    for (const row of pack[source].rows) {
      const id = "entityId" in row ? row.entityId : "adId" in row ? row.adId : "";
      const grain = `${row.day}:${id}`;
      requireFact(!grains.has(grain) && row.day >= window.start && row.day < window.end, "duplicate or out-of-window row");
      grains.add(grain);
      if (id) requireFact(entities.has(id) && (!("adId" in row) || entities.get(id)?.level === "ad"), "unknown attributed entity");
      if ("newCustomerOrders" in row) requireFact(row.newCustomerOrders <= row.orders, "invalid new-customer orders");
    }
  }
  const levelGrains = new Set<string>();
  for (const row of pack.tripleWhale.levelRows) {
    const grain = `${row.day}:${row.entityId}`;
    requireFact(!levelGrains.has(grain) && row.day >= window.start && row.day < window.end, "duplicate or out-of-window level row");
    levelGrains.add(grain);
    requireFact(entities.get(row.entityId)?.level === "adset" || entities.get(row.entityId)?.level === "campaign", "level row must name an ad set or campaign");
  }
}
export const UaSnapshotSchema = Pack.superRefine((pack, context) => {
  try { validate(pack); } catch (error) { context.addIssue({ code: "custom", message: String(error) }); }
});
export type UaSnapshot = z.infer<typeof UaSnapshotSchema>;

function freeze<Value>(value: Value): Value {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// Readers are trusted VM-local adapters, never model-selected transports or server tools.
export class UaSnapshotAdapter {
  private readonly scope: Readonly<UaScope>;
  constructor(scope: UaScope, private readonly readers: UaSnapshotReaders,
    private readonly enabled = UA_CBO_ENABLED, private readonly now: () => number = Date.now) {
    this.scope = freeze(Scope.parse(scope));
    localDay(now(), this.scope.timezone);
  }

  async capture(rawWindow: UaWindow) {
    if (!this.enabled) return { status: "disabled" as const };
    const startedAt = new Date(this.now()).toISOString();
    const window = freeze(Window.parse(rawWindow));
    checkWindow(window, this.scope, Date.parse(startedAt));
    const sources = UA_CBO_DEFINITION.requiredSources;
    const values = await Promise.all(sources.map((source) => this.readers[source](this.scope, window)));
    const missing = sources.filter((_, index) => values[index] === null);
    if (missing.length) return { status: "waiting_for_data" as const, missing };
    const snapshot = UaSnapshotSchema.parse({ schemaVersion: 1, routineId: UA_CBO, scope: this.scope, window,
      startedAt, capturedAt: new Date(this.now()).toISOString(), ...Object.fromEntries(sources.map((source, index) => [source, values[index]])) });
    return { status: "ready" as const, snapshot: freeze(snapshot) };
  }
}
