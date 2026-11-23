// Extract of zygstinct apps/agent-server/src/brand-stack.ts at 7110e58c8: only BrandStack:declare.
import { type ConnectorProvider } from "@zygstinct/shared";
import type { Logger } from "./logger.js";
import type { ConversationKey, Store } from "./store.js";
import { type ConfirmJudge } from "./stack-confirm.js";
import { canonical } from "./connector-requests.js";
import { signupOwnerAnswerOf, type BrandDirectory } from "./directory.js";

/**
 * The brand's stack (Omer R6-R11, 2026-11-21): which tool the brand uses for each eCommerce pillar, computed by the server from three records only:
 * the brand's connections (started, failed and connected), the newest storefront scan of its own website (pixel_audit_reports), and what a member
 * said in their own chat (`marley.stack.set`, stored here in agent.db). Nothing the model writes decides a connection's state or what a scan saw.
 * A turn gets one computed line (`stackLine`) and the full detail is read on demand (`marley.stack.get`, brand-host-capabilities.ts).
 */
export const PILLARS = ["store", "meta_ads", "google_ads", "other_paid_ads", "attribution", "email_sms", "reviews", "subscriptions", "loyalty", "support", "site_analytics", "shipping", "affiliate"] as const;

export type Pillar = (typeof PILLARS)[number];

/** The order the site confirm names unconfirmed tools in: the owner's own tools first, ad and analytics tags last. */
const CONFIRM_ORDER: readonly Pillar[] = ["email_sms", "reviews", "subscriptions", "support", "loyalty", "attribution", "shipping", "affiliate", "store", "meta_ads", "google_ads", "other_paid_ads", "site_analytics"];

export const PILLAR_LABELS: Record<Pillar, string> = {
  store: "store platform",
  meta_ads: "Meta ads",
  google_ads: "Google ads",
  other_paid_ads: "other paid ads",
  attribution: "attribution",
  email_sms: "email/SMS",
  reviews: "reviews",
  subscriptions: "subscriptions",
  loyalty: "loyalty",
  support: "support",
  site_analytics: "site analytics",
  shipping: "shipping",
  affiliate: "affiliate",
};

/** `data`: a connector whose data Marley models; `connector`: a connector exists, nothing from it is modelled yet; `none`: no connector. */
export type Support = "data" | "connector" | "none";

export interface StackTool {
  id: string;
  label: string;
  pillar: Pillar;
  support: Support;
  provider?: ConnectorProvider;
  /** Pixel-audit vendor ids (pixel-audit.mjs PIXEL_VENDORS / HOST_NAMES `vendor`). */
  vendors?: readonly string[];
  /** Other names, compared after `canonical` (an app pixel's name on the shop, what a person types). */
  names?: readonly string[];
}

/** Every tool the stack knows: Marley's connectors (support from connect-ladder.ts `unlocks`) and the vendors the pixel audit recognises. */
export const STACK_TOOLS: readonly StackTool[] = [
  { id: "shopify", label: "Shopify", pillar: "store", support: "data", provider: "shopify", vendors: ["shopify"] },
  { id: "amazon_seller", label: "Amazon Seller", pillar: "store", support: "data", provider: "amazon_seller", names: ["amazon"] },
  { id: "woocommerce", label: "WooCommerce", pillar: "store", support: "none", names: ["woo"] },
  { id: "meta_ads", label: "Meta Ads", pillar: "meta_ads", support: "data", provider: "meta_ads", vendors: ["meta"], names: ["facebook", "facebook ads", "instagram", "meta", "facebook & instagram"] },
  { id: "google_ads", label: "Google Ads", pillar: "google_ads", support: "data", provider: "google_ads", vendors: ["google_ads", "merchant_center"], names: ["adwords", "google & youtube"] },
  { id: "tiktok_ads", label: "TikTok Ads", pillar: "other_paid_ads", support: "connector", provider: "tiktok_ads", vendors: ["tiktok"], names: ["tiktok"] },
  { id: "applovin", label: "AppLovin", pillar: "other_paid_ads", support: "connector", provider: "applovin", vendors: ["applovin"] },
  { id: "amazon_ads", label: "Amazon Ads", pillar: "other_paid_ads", support: "data", provider: "amazon_ads" },
  { id: "pinterest_ads", label: "Pinterest Ads", pillar: "other_paid_ads", support: "none", vendors: ["pinterest"], names: ["pinterest"] },
  { id: "snapchat_ads", label: "Snapchat Ads", pillar: "other_paid_ads", support: "none", vendors: ["snap"], names: ["snap", "snapchat"] },
  { id: "reddit_ads", label: "Reddit Ads", pillar: "other_paid_ads", support: "none", vendors: ["reddit"], names: ["reddit"] },
  { id: "microsoft_ads", label: "Microsoft Ads", pillar: "other_paid_ads", support: "none", vendors: ["microsoft"], names: ["bing", "bing ads"] },
  { id: "triple_whale", label: "Triple Whale", pillar: "attribution", support: "data", provider: "triple_whale", vendors: ["triple_whale"] },
  { id: "marley_pixel", label: "Marley Pixel", pillar: "attribution", support: "data", provider: "shopify_reports" },
  { id: "northbeam", label: "Northbeam", pillar: "attribution", support: "none", vendors: ["northbeam"] },
  { id: "elevar", label: "Elevar", pillar: "attribution", support: "none", vendors: ["elevar"] },
  { id: "klaviyo", label: "Klaviyo", pillar: "email_sms", support: "data", provider: "klaviyo", vendors: ["klaviyo"] },
  { id: "flashy", label: "Flashy", pillar: "email_sms", support: "connector", provider: "flashy" },
  { id: "attentive", label: "Attentive", pillar: "email_sms", support: "none", vendors: ["attentive"] },
  { id: "postscript", label: "Postscript", pillar: "email_sms", support: "none", vendors: ["postscript"] },
  { id: "hubspot", label: "HubSpot", pillar: "email_sms", support: "none", vendors: ["hubspot"] },
  { id: "omnisend", label: "Omnisend", pillar: "email_sms", support: "none" },
  { id: "mailchimp", label: "Mailchimp", pillar: "email_sms", support: "none" },
  { id: "yotpo", label: "Yotpo", pillar: "reviews", support: "connector", provider: "yotpo" },
  { id: "judge_me", label: "Judge.me", pillar: "reviews", support: "none", names: ["judgeme", "judge me"] },
  { id: "okendo", label: "Okendo", pillar: "reviews", support: "none" },
  { id: "loox", label: "Loox", pillar: "reviews", support: "none" },
  { id: "stamped", label: "Stamped", pillar: "reviews", support: "none", names: ["stamped.io"] },
  { id: "recharge", label: "Recharge", pillar: "subscriptions", support: "data", provider: "recharge" },
  { id: "skio", label: "Skio", pillar: "subscriptions", support: "none" },
  { id: "loop_subscriptions", label: "Loop Subscriptions", pillar: "subscriptions", support: "none", names: ["loop"] },
  { id: "bold_subscriptions", label: "Bold Subscriptions", pillar: "subscriptions", support: "none", names: ["bold"] },
  { id: "smile", label: "Smile.io", pillar: "loyalty", support: "none", names: ["smile"] },
  { id: "loyaltylion", label: "LoyaltyLion", pillar: "loyalty", support: "none", names: ["loyalty lion"] },
  { id: "gorgias", label: "Gorgias", pillar: "support", support: "data", provider: "gorgias" },
  { id: "intercom", label: "Intercom", pillar: "support", support: "connector", provider: "intercom" },
  { id: "zendesk", label: "Zendesk", pillar: "support", support: "none" },
  { id: "tidio", label: "Tidio", pillar: "support", support: "none" },
  { id: "reamaze", label: "Re:amaze", pillar: "support", support: "none", names: ["reamaze", "re amaze"] },
  { id: "ga4", label: "Google Analytics", pillar: "site_analytics", support: "none", vendors: ["ga4"], names: ["google analytics", "ga"] },
  { id: "clarity", label: "Microsoft Clarity", pillar: "site_analytics", support: "none", vendors: ["clarity"], names: ["clarity"] },
  { id: "contentsquare", label: "Contentsquare", pillar: "site_analytics", support: "none", vendors: ["contentsquare"] },
  { id: "vwo", label: "VWO", pillar: "site_analytics", support: "none", vendors: ["vwo"] },
  { id: "aftership", label: "AfterShip", pillar: "shipping", support: "none", vendors: ["aftership"] },
  { id: "grin", label: "Grin", pillar: "affiliate", support: "none", vendors: ["grin"] },
];

const BY_ID = new Map(STACK_TOOLS.map((tool) => [tool.id, tool]));

const BY_NAME = new Map(STACK_TOOLS.flatMap((tool) => [tool.id, tool.label, ...(tool.provider ? [tool.provider] : []), ...(tool.names ?? [])].map((name) => [canonical(name), tool] as const)));

/** The known tool a name stands for (an id, label, provider, alias or app pixel name, any spelling), or undefined. */
export const knownTool = (name: string): StackTool | undefined => BY_NAME.get(canonical(name));

export type ToolSource = "connected" | "connecting" | "failed" | "seen_on_site" | "member_said";

export interface PillarTool {
  /** A known tool's id, or `custom:<canonical name>` for one a member named that the map does not know (support `none`). */
  id: string;
  label: string;
  support: Support;
  sources: ToolSource[];
  startedAt?: string;
}

export interface PillarState {
  pillar: Pillar;
  label: string;
  /** Known: a connection, a scan or a member's answer says what the brand uses (or a member said it uses nothing). */
  known: boolean;
  /** A member said the brand uses nothing for it. */
  none: boolean;
  tools: PillarTool[];
}

export interface BrandStackSnapshot {
  brandId: string;
  readAt: string;
  pillars: PillarState[];
  known: number;
  /** The single next pillar to ask about, or null when every one is known. */
  askNext: Pillar | null;
  /** Connections started and not finished for STUCK_AFTER_DAYS or more, and failed ones. */
  stuck: { tool: string; label: string; state: "connecting" | "failed"; startedAt: string | null }[];
  /** Tools only the site showed (no connection, no member's word), in pillars no member answered: the confirm ask. */
  unconfirmed: { tool: string; label: string; pillar: Pillar }[];
  /** Tools the brand uses (seen on its site or a member said so) that have a connector it never started. */
  connectable: { tool: string; label: string; pillar: Pillar }[];
  /** Tools the brand uses that Marley has no connector for, with no ticket on file for this brand yet. */
  unsupported: { tool: string; label: string; pillar: Pillar; ticketed: boolean | "unknown" }[];
  /** What could not be read (connections, scan): never taken as "nothing there". */
  unavailable: string[];
  /** The stack scan of the brand's website: `failed` when every try ended without a report (the site was not read, which is not "nothing seen"). */
  siteScan: "done" | "running" | "failed" | "not_started";
  scanAt: string | null;
  /** A source of the brand is connected (it has synced): a brand with no onboarding week on record then starts it (onboardingWeek). */
  synced: boolean;
}

export const STUCK_AFTER_DAYS = 2;

/** After the week, an ask is raised unprompted at most once in this many days; otherwise only when the talk turns to it. */
export const ASK_GAP_DAYS = 3;

/** A stuck connect raised with one member is not raised with another in this many days. */
export const STUCK_ELSEWHERE_DAYS = 7;

/** A failed scan run is fired again on a later turn at most this many times in all. */
const SCAN_TRIES = 3;

/** An ask raised this many times with a member is not raised with them again (an answered pillar is known brand-wide and leaves the line anyway). */
export const ASK_DROP_AFTER = 2;

/** A site confirm's answer is looked for in the member's next messages: this many, within this many days of the raise, each judged in this time. */
const CONFIRM_MESSAGES = 2;

const CONFIRM_WINDOW_DAYS = 2;

const MAX_LIST = 2;

/** A member's own message authorizes `marley.stack.set` for at most this long after their turn started (a long turn still ends well inside it). */
const SPEAKING_MS = 30 * 60_000;

/**
 * What a member's direct chat may carry now, from the server's own record of the asks raised (marley.stack.asked). Only a turn answering their own
 * message carries an ask: their own turn when it cannot just hand off (askGate handsOff), or the turn relaying the result of their own task on a UTC day
 * they wrote (the answer a "looking into it" message promised; a wakeup never does), and never on a UTC day one was already raised with them (a connect
 * link the server sent them counts, noteConnectLink). `mode`: `ask` gives one
 * ask (in the onboarding week any such turn; after it, only ASK_GAP_DAYS or more after the last raise), `if_raised` lists the open items to raise
 * only when the talk turns to one of them (after the week, between unprompted asks), `none` gives none. `blocked`: asks never given to them: one
 * raised ASK_DROP_AFTER times with them, and a stuck connect raised with another member in the last STUCK_ELSEWHERE_DAYS days. `raised`: how often
 * each ask was raised with them (the least raised goes first). A pillar any member answered (marley.stack.set) is known brand-wide.
 */
export interface AskGate {
  mode: "ask" | "if_raised" | "none";
  week: boolean;
  blocked: ReadonlySet<string>;
  raised: ReadonlyMap<string, number>;
}

type Query = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[] | null>;

export interface BrandStackDeps {
  store: Store;
  /** The operational database (pixel_audit_reports); `ReadOnlyPg.query`. */
  query: Query;
  /** The shared source store (sources.connections); `ReadOnlyPg.sources.query`. */
  sourcesQuery: Query;
  /** The brand's website on file (the scan must be of that host, SB21). */
  websiteOf: (brandId: string) => Promise<string | null>;
  /** Whether this brand is already on the board's missing-connector issue for a tool (tickets.ts), so a ticketed tool leaves the line. */
  ticketed?: (brandId: string, toolKey: string) => Promise<boolean | "unknown">;
  /** Starts the stack-scan routine of the brand's own website (service.ts; the engine run is fire-and-forget). */
  startScan?: (brandId: string, website: string) => Promise<unknown>;
  /**
   * Files the team's missing-connector ticket for a tool the brand uses that has none (tickets.ts, idempotent on the board). The server files it, not a
   * member's turn, so no ticket text is ever in what a member's chat reads (parent T8, 2026-11-22: "the request to get that connected isn't filed yet").
   */
  fileMissing?: (brandId: string, tool: { tool: string; label: string; pillar: Pillar }) => Promise<unknown>;
  /** The structured judgement of a member's answer to the site confirm (stack-confirm.ts); absent: the answer is only what the turn records itself. */
  judgeConfirm?: ConfirmJudge;
  /**
   * The brand's time zone from the server's directory (directoryZone: the signup owner's own zone, else a member's): "one ask a day" counts the
   * brand's days (delivery review D3, re-review: every brand, not only those in BRAND_TIMEZONES). Read on each `read` of the stack and kept for the day
   * counts between reads; null is "none", undefined "could not read" (the known zone stays); UTC until one is known.
   */
  timezone?: (brandId: string) => Promise<string | null | undefined> | string | null | undefined;
  logger: Logger;
  now?: () => number;
}

const validZone = (zone: string | null | undefined): zone is string => {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/**
 * A brand's IANA zone from its directory row (brand_members.timezone, which registration sets for every member): the signup owner's own zone, else the
 * first member's that is a valid zone; null when the directory has none (delivery re-review D3: the brands table holds no zone of its own).
 */
export function brandZoneOf(context: { members: readonly { id: string; timezone?: string | null }[] } | null, ownerId: string | null): string | null {
  const owner = ownerId ? context?.members.find((member) => member.id === ownerId)?.timezone : null;
  if (validZone(owner)) return owner;
  return context?.members.map((member) => member.timezone).find(validZone) ?? null;
}

/**
 * The brand's zone as the server's directory gives it now (BrandStackDeps.timezone): brandZoneOf, else `fallback` (BRAND_TIMEZONES), else null.
 * `undefined` when the directory could not answer (no brand row, member list unreadable, signup owner unreadable), so the zone already known is kept
 * (zyg-agents on 7e4df8bc5: a database blip set a New York brand back to UTC days).
 */
export async function directoryZone(directory: Pick<BrandDirectory, "get" | "signupOwner" | "signupOwnerAnswer">, brandId: string, fallback?: (brandId: string) => string | null | undefined): Promise<string | null | undefined> {
  const [context, owner] = await Promise.all([directory.get(brandId), signupOwnerAnswerOf(directory, brandId)]);
  if (!context || context.membersUnreadable || owner.kind === "unreadable") return undefined;
  return brandZoneOf(context, owner.kind === "owner" ? owner.memberId : null) ?? fallback?.(brandId) ?? null;
}

export declare class BrandStack {
  private readonly now;
  private readonly cache;
  /** When the server last tried to file a tool's ticket, per brand and tool (in memory: a restart tries again, and the board dedupes). */
private readonly filedAt;
  /** How many of a member's messages were judged against their latest site confirm (by its raise time; in memory, a restart judges again, idempotently). */
private readonly confirmJudged;
  /** Per brand and member, whether the turn running in their direct chat carries their own message (noteTurn): what `marley.stack.set` may record. */
private readonly speaking;
  /** The brand's zone as the directory last gave it (refreshZone, on each read): what dayOf counts in. */
private readonly zones;
  private readonly deps;
  constructor(deps: BrandStackDeps);
  private dayOf;
  private refreshZone;
  /**
   * A turn of a member's direct chat starts (claude.ts stackLineFor, before anything else): `human` when every message of it is their own inbound
   * message. A wakeup, a task's result, a control or routine turn is not (AU01).
   */
noteTurn(brandId: string, memberId: string, human: boolean): void;
  /**
   * Whether the turn running in the member's direct chat carries their own message, so what it records is what they said (privacy review P2): the
   * latest turn noted for them was theirs, within SPEAKING_MS. Anything else (a wakeup, a task's result, a worker) records nothing as theirs.
   */
speaks(brandId: string, memberId: string): boolean;
  /**
   * The member's Stack line for this turn (stackLine), recording which asks it offered today (agent.db `brand_stack_offers`, one row per member and
   * ask): a mark counts as a raise only for one of those.
   */
line(brandId: string, memberId: string, snapshot: BrandStackSnapshot, gate: AskGate): string | null;
  /**
   * Records that an ask was raised with a member (key as the Stack line gives it): no other ask that UTC day. Only a mark of an ask the member's line
   * offered that day is a raise, and a raise on a later UTC day than the last counts toward ASK_DROP_AFTER (two marks of one raise are one). A topic the
   * member brought up, or a connect link they asked for, holds the day but never counts (zyg-agents finding on 7d5e6a3f3). Brand and member come
   * from the server, never the input.
   */
markAsked(input: { brandId: string; memberId: string; ask: unknown; at?: number }): { ok: true; ask: string } | { ok: false; reason: string };
  /**
   * A connect link the server queued for a member's own chat (router.ts, a typed `send_connect_link` piece) is an ask raised with them: the 3-day gate after
   * the week counts it whether or not the turn marked it (the onboarding-week sim, 2026-11-22: a Klaviyo link sent unmarked on day 8 let a Gorgias ask through
   * on day 9). A source the map does not know is ignored.
   */
noteConnectLink(input: { brandId: string; memberId: string; source: string; at?: number }): void;
  /**
   * The member's answer to the site confirm, recorded by the server (stack-confirm.ts): on each of their next CONFIRM_MESSAGES messages within
   * CONFIRM_WINDOW_DAYS of the confirm being raised with them, while a tool it named is still unconfirmed, one structured judgement of what the message
   * settles, each answer recorded with `answer` (so a pillar or tool that does not fit is refused there). A judgement that failed or came back invalid
   * does not count toward CONFIRM_MESSAGES (LN06 row G-T-stack-confirm-window). Returns what was recorded; never throws.
   */
settleConfirm(input: { key: ConversationKey; memberId: string; words: string }): Promise<string[]>;
  /** The member wrote in their own chat today (a turn the front answers, or one decide-first holds for a check, router.ts): their task's result may carry the ask. */
noteWrote(brandId: string, memberId: string): void;
  /**
   * The ask gate of a member's turn now (see AskGate); `week` is the brand's onboarding week (onboardingWeek). `handsOff`: a front turn that may hand the
   * work to a worker and say only that it is on it (claude.ts stackLineFor); it carries no ask, so a holding message has none to slip in (parent T8).
   */
askGate(brandId: string, memberId: string, turn: { reply: boolean; relay?: boolean; week: boolean; handsOff?: boolean }): AskGate;
  /**
   * Whether the brand is in its onboarding week now. The week starts at the brand's first finished sync (syncFinished) or, for a brand that synced before
   * this shipped and has no week on record, at its first member turn after (`synced` from the snapshot). A brand that has not synced yet is in its
   * onboarding and gets the week's cadence without starting the clock. Starting the week, and a brand's first turn, fire the site scan once.
   */
onboardingWeek(brandId: string, state: { synced: boolean }): boolean;
  /** The brand's first finished sync (`existing`: the brand had synced before, so its week starts at its first member turn instead). */
syncFinished(brandId: string, state: { existing: boolean }): void;
  /**
   * The stack-scan run ended. It counts as done only when its report reached recordDetected after this claim, however the run ended (a run whose
   * browser would not start ends idle having reported nothing; a run that reported and was then settled failed by a restart is done); otherwise it
   * is fired again on a later turn, at most SCAN_TRIES times in all. The run that spends the last try is logged at ERROR
   * (`brand_stack.scan_exhausted`) and the snapshot says `siteScan: "failed"` from then on (sandbox review S2, LN03: a cap never stops in silence).
   */
scanFinished(brandId: string, ended: boolean): void;
  /**
   * The scan run's report (marley.stack.detected): the stack tools it saw on the brand's own website and the tag vendors. Refused unless the scanned
   * host is the brand's website on file (SB21); ids no tool owns are dropped. Replaces the brand's earlier detection of that host.
   */
recordDetected(input: { brandId: string; storeUrl: unknown; tools: unknown; tags?: unknown; stackUnread?: unknown }): Promise<{ ok: true; tools: string[] } | { ok: false; reason: string }>;
  private weekRow;
  private startWeek;
  private scanOnce;
  /**
   * Records a member's answer for one pillar: a known tool, a tool the map does not know (kept by its safe name, support `none`), or "none". The
   * caller supplies the brand and member from the server's own records (session labels and a fresh directory read), never from the input.
   */
answer(input: { brandId: string; memberId: string; sessionId?: string; pillar: unknown; tool: unknown }): { ok: true; pillar: Pillar; tool: { id: string; label: string; support: Support } } | { ok: false; reason: string };
  /** Forget the cached snapshot (a ticket was filed, a connection changed). */
invalidate(brandId: string): void;
  /** The brand's stack now; cached for a minute per brand. Never throws: what could not be read is listed in `unavailable`. */
read(brandId: string): Promise<BrandStackSnapshot>;
  private compute;
  private fileMissing;
  private ticketedOf;
  private readScan;
}

/** The key a ticket about a tool is deduped on, across brands: the known tool's id, else the canonical name. */
export const toolKey = (name: string): string => {
  const plain = name.startsWith("custom:") ? name.slice("custom:".length) : name;
  return knownTool(plain)?.id ?? (BY_ID.has(plain) ? plain : canonical(plain));
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const shortDay = (at: string): string => {
  const date = new Date(at);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
};

/** The tools the site confirm names, in the order it names them (at most three): the same list the server later judges the answer against. */
export function confirmNamed(snapshot: Pick<BrandStackSnapshot, "unconfirmed">): { tool: string; label: string; pillar: Pillar }[] {
  return [...snapshot.unconfirmed].sort((a, b) => CONFIRM_ORDER.indexOf(a.pillar) - CONFIRM_ORDER.indexOf(b.pillar)).slice(0, 3);
}

/**
 * The one line a member's direct chat gets, or null when there is no ask for this turn or a record could not be read. Only server text and the map's own
 * labels: no shop or member text is in it. Tickets are never in it: the server files them (BrandStack fileMissing), so nothing about one reaches a member.
 */
export function stackLine(snapshot: BrandStackSnapshot, gate?: AskGate): string | null {
  return stackLineAsks(snapshot, gate).line;
}

/** The line and the ask keys it offers (one in `ask` mode, up to three in `if_raised`): markAsked counts a raise only of a key the line offered that day. */
export function stackLineAsks(snapshot: BrandStackSnapshot, gate?: AskGate): { line: string | null; offered: string[] } {
  if (snapshot.unavailable.length) return { line: null, offered: [] };
  // The asks in Omer's order (R21): confirm what the site showed, then a connect (stuck or never started), then a pillar nothing showed.
  const open: { key: string; text: string; rank: number }[] = [];
  if (snapshot.unconfirmed.length) {
    // The confirm names the tools that say most about how they work first; ad and analytics tags last (the Coder run of okoaskin.com, 2026-11-22,
    // named Meta Ads, AppLovin and Microsoft Ads ahead of Klaviyo, Okendo, Recharge and Gorgias).
    open.push({ key: "confirm:site", rank: 0, text: `their site shows ${confirmNamed(snapshot).map((item) => item.label).join(", ")} (not confirmed): ask whether that is right; record each answer with marley.stack.set` });
  }
  for (const item of snapshot.stuck.slice(0, MAX_LIST)) {
    open.push({ key: `stuck:${item.tool}`, rank: 1, text: item.state === "failed"
      ? `their ${item.label} connect failed: ask whether they want to try it again with you`
      : `their ${item.label} connect was started ${item.startedAt ? shortDay(item.startedAt) : "earlier"} and not finished: ask whether they got stuck and offer to finish it with them` });
  }
  for (const item of snapshot.connectable.slice(0, MAX_LIST)) open.push({ key: `connect:${item.tool}`, rank: 1, text: `they use ${item.label}, not connected: ask them to connect it and offer the link` });
  if (snapshot.askNext) open.push({ key: `pillar:${snapshot.askNext}`, rank: 2, text: `ask which tool they use for ${PILLAR_LABELS[snapshot.askNext]}; record the answer with marley.stack.set` });
  // The server's ask gate (AskGate): never a blocked ask; the least raised first, then the order above.
  const asks = gate?.mode === "none" ? [] : open.filter((ask) => !gate?.blocked.has(ask.key))
    .map((ask, index) => ({ ...ask, index, count: gate?.raised.get(ask.key) ?? 0 }))
    .sort((a, b) => a.count - b.count || a.rank - b.rank || a.index - b.index);
  if (!asks.length) return { line: null, offered: [] };
  const parts = [`Stack: ${snapshot.known} of ${PILLARS.length} pillars known (detail: marley.stack.get).`];
  const mark = (ask: { key: string }) => `marley.stack.asked {ask: "${ask.key}"}`;
  if (gate?.mode === "if_raised") {
    // After the week, between unprompted asks: only the person's own message opens one (parent T8: "the conversation touched it" was too loose).
    const shown = asks.slice(0, 3);
    parts.push(`Only if their own message is about one of these tools or what it does, raise that one at the end of your answer and mark it with ${shown.map((ask) => `${ask.text} (${mark(ask)})`).join("; ")}.`);
    return { line: parts.join(" "), offered: shown.map((ask) => ask.key) };
  }
  // A turn that may only say it is on it gets no ask at all (askGate handsOff), so the line needs no words against a holding message.
  parts.push(`Today's ask (at the end of your answer, never on a day they reported a problem): ${asks[0].text}; in the turn you raise it, mark it with ${mark(asks[0])}.`);
  return { line: parts.join(" "), offered: [asks[0].key] };
}
