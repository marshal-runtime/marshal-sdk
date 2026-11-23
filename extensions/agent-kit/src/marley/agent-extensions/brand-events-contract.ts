import { z } from "zod";

/**
 * Brand events (Omer R152, 2026-11-18): an event a brand defines in code. An extension package declares it in `runtime-extension.json`
 * (`contributes.events`) with a detector `events/<slug>.ts`: a `when` (a schedule, or an event the server already emits) and `check(input, ctx)`, which returns
 * null (nothing happened) or a payload. A payload emits `brand.<slug>` on the one bus, where every extension routine of the brand that lists it in
 * `triggers.events` and every chat subscription (zs.events.subscribe) can register, with filters on payload fields.
 * The detector is brand code: it runs on the brand's sandbox VM as the brand user (brand-events.ts), never in the server process.
 */

/** A brand event's name. The `brand.` prefix keeps it apart from every server event (data.sync.completed, first-sync-complete, ...): no server event starts with it. */
export const BRAND_EVENT_NAME = /^brand\.[a-z0-9][a-z0-9-]{0,47}$/;
export const isBrandEventName = (value: string): boolean => BRAND_EVENT_NAME.test(value);

const FIELD = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const scalar = z.union([z.string().max(200), z.number().finite(), z.boolean()]);

/** What a detector may emit: a flat object of at most 20 named fields, each a short string, a number, a boolean or a list of up to 20 of those; at most 4 KB. */
export const BrandEventPayload = z
  .record(z.string().regex(FIELD), z.union([scalar, z.array(scalar).max(20)]))
  .refine((payload) => Object.keys(payload).length <= 20, "at most 20 fields")
  .refine((payload) => JSON.stringify(payload).length <= 4096, "at most 4 KB");
export type BrandEventPayloadT = z.infer<typeof BrandEventPayload>;

/** A brand event as its package declares it. */
export interface BrandEventDef {
  /** `brand.<slug>` */
  id: string;
  /** The extension that defines it (`@brand/<slug>`) and its active version. */
  extensionId: string;
  version: number;
  /** One line for zs.events.list and zs.extensions.list. */
  description: string;
  /** The payload fields a subscriber may filter on (from the declaration; informational, the payload is checked by BrandEventPayload). */
  fields: string[];
}

/** The brand's own events, read from its active extension versions. */
export interface BrandEventCatalog {
  list(brandId: string): Promise<BrandEventDef[]>;
}
