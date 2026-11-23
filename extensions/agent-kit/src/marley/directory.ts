import type { WakeReason } from "./sandbox/wake-reason.js";
import pg from "pg";

import { CONNECTOR_PROVIDERS, MAINTAINER_ENTRY_HOURS, parseMemberPreferences, type MemberPreferences } from "@zygstinct/shared";

import type { Logger } from "./logger.js";
import { errorClass } from "./logger.js";

export type MemberStatus = "pending" | "active";

export interface BrandMember {
  id: string;
  displayName: string;
  /** Null for a person invited by email who has not given a number yet (brand_members.phone_e164 is nullable). */
  phoneE164: string | null;
  /** `active` means the person has written to Marley from their number; `pending` has not yet. Both are members with the same access (`isMember`); the status is only the consent fact for messages Marley starts (`hasWritten`). There is no disabled state: a member is a row of the brand, and an operator deletes a row on request (D143). */
  status: MemberStatus;
  /** From users.email through brand_members.user_id; null when the member has no user or the read-only role cannot read it. */
  email?: string | null;
  /** brand_members.timezone, the person's IANA timezone; null when unset. */
  timezone?: string | null;
  /** member_preferences: the person's style preferences. Null or absent when none are stored, when the table does not exist yet, or when the stored value is damaged. */
  preferences?: MemberPreferences | null;
  /**
   * maintainer_phone_leases.epoch of the member's user, read in the same query as the member (so a DM turn's fresh read carries it, never a cached one):
   * 0 when the user has no lease row (everyone who is not a maintainer). Absent when the epoch could not be read (the table is not readable or the read
   * failed); absent never means 0, and a turn that finds no epoch changes nothing.
   */
  leaseEpoch?: number;
  /**
   * True for the row a platform maintainer's WhatsApp lease is using right now (maintainer_phone_leases.target_member_id with an active lease, D116).
   * That row is a member like any other for access, but it is not a person the brand added: every
   * place that lists recipients of its briefs and alerts skips it. Absent when the lease
   * table could not be read, like `leaseEpoch`.
   */
  maintainerLease?: true;
}

/** The member's IANA timezone as the agent sees it. A missing one is "unknown": never a guess and never the brand's timezone. */
export const memberTimezoneLabel = (member: { timezone?: string | null }): string => member.timezone || "unknown";

/**
 * MLY-363 (D126): a platform maintainer's own row in a brand (the phoneless row the gateway's lease engine and its brand-number entry use) is
 * a member of that brand for the agent server only while three server-owned facts hold at this read: the user is an active maintainer
 * with the brand in `maintainer_brands`, the row is the user's own phoneless one, and the gateway audited an entry through the brand's own
 * number within `MAINTAINER_ENTRY_HOURS` (`maintainer_events.action = 'brand_number_entry'`, written only after it verified the phone).
 * The row then reads as an active owner carrying the maintainer's phone (the lease row's) and `maintainerLease`, so no list of the brand's
 * owners or recipients includes it. Nothing in a published message grants this.
 */
/** A maintainer's parked entry row: the lease engine creates it 'disabled' and phoneless in every brand it leases into (maintainer-store.ts). It is the engine's own inert marker, never a person the brand added, so it is no member until a live lease or entry makes it the maintainer's row. */
export const PARKED_ENTRY_SQL = "(m.status = 'disabled' AND m.phone_e164 IS NULL AND m.user_id IS NOT NULL AND m.user_id IS DISTINCT FROM bo.owner_user_id AND EXISTS (SELECT 1 FROM platform_maintainers pm WHERE pm.user_id = m.user_id)) AS parked_entry";
const MAINTAINER_ENTRY_SQL = `(m.phone_e164 IS NULL AND m.user_id IS NOT NULL AND m.status IN ('disabled', 'pending') AND l.phone_e164 IS NOT NULL
    AND EXISTS (SELECT 1 FROM brand_members h WHERE h.user_id = m.user_id AND h.phone_e164 = l.phone_e164 AND h.status = 'active')
    AND EXISTS (SELECT 1 FROM maintainer_brands v WHERE v.user_id = m.user_id AND v.brand_id = m.brand_id)
    AND EXISTS (SELECT 1 FROM maintainer_events e WHERE e.user_id = m.user_id AND e.brand_id = m.brand_id AND e.action = 'brand_number_entry' AND e.created_at > now() - interval '${MAINTAINER_ENTRY_HOURS} hours')) AS maintainer_entry,
  (CASE WHEN m.phone_e164 IS NULL THEN l.phone_e164 END) AS entry_phone`;

export interface BrandConnection {
  provider: string;
  status: string;
  mode: string;
  connectedAt: string | null;
  /** When the connector last synced (the Fivetran sync_end webhook). Not the time of the brand's warehouse tables. */
  lastSyncedAt?: string | null;
  lastSyncStatus?: string | null;
}

export interface BrandContext {
  brandId: string;
  name: string;
  websiteUrl: string | null;
  members: BrandMember[];
  connections: BrandConnection[];
  /**
   * True when the member list could not be read (members is then empty). That is no proof of who is or is not an active
   * member: authority checks that must tell "denied" from "unavailable" read this.
   */
  membersUnreadable?: true;
}

/** One change to the brand's member list (brand_member_events), without phone numbers or emails. */
export interface MemberEvent {
  at: string;
  action: string;
  memberId: string | null;
  memberName: string | null;
  by: string | null;
  statusBefore: string | null;
  statusAfter: string | null;
}

export type SignupOwnerAnswer = { kind: "owner"; memberId: string } | { kind: "none" } | { kind: "unreadable" };

/** The signup owner as a typed answer. A directory without `signupOwnerAnswer` (a static or test one) reads no database, so it cannot fail to read. */
export async function signupOwnerAnswerOf(directory: Pick<BrandDirectory, "signupOwner" | "signupOwnerAnswer">, brandId: string): Promise<SignupOwnerAnswer> {
  if (directory.signupOwnerAnswer) return directory.signupOwnerAnswer(brandId);
  const memberId = await directory.signupOwner?.(brandId) ?? null;
  return memberId ? { kind: "owner", memberId } : { kind: "none" };
}

export interface BrandDirectory {
  isSignupOwner?(brandId: string, memberId: string, phone: string): Promise<boolean>;
  /**
   * The member id of the brand's signup owner (brands.owner_user_id), read fresh: an active owner of a brand that finished
   * onboarding; null otherwise or when the database cannot be read. A co-owner is never this member.
   */
  signupOwner?(brandId: string): Promise<string | null>;
  /**
   * The same signup owner as a typed answer that keeps "could not read" apart from "no such owner" (MLY-577): `unreadable` when the database
   * cannot be read, `none` when the brand has no active signup owner (pending, disabled, no member row, onboarding not finished).
   */
  signupOwnerAnswer?(brandId: string): Promise<SignupOwnerAnswer>;
  /**
   * Every brand that finished onboarding (brands.onboarding_completed_at), read fresh, whoever its members are: the brands the Meta analysis and the
   * morning-brief build are enrolled for, chat or no chat (MLY-577). Null when the database cannot be read.
   */
  servedBrands?(): Promise<string[] | null>;
  /**
   * Whether the brand's owner agreed on the wizard to the automatic pixel audit (brands.pixel_audit_consent_at, MLY-357), read fresh; false when no
   * consent is on record, null when the database cannot be read (or the column does not exist yet). Never a reason to run an audit on its own.
   */
  pixelAuditConsent?(brandId: string): Promise<boolean | null>;
  /**
   * The brand's account owner (brands.owner_user_id) as member and user, read fresh, also while onboarding runs: an active owner member of
   * that user; null otherwise or when the database cannot be read. A co-owner is never this person. Used by the browser relay.
   */
  /**
   * Whether this user may pair their own Chrome for the brand (owner's 2026-11-12 order: every member, maintainers included): an active member row
   * of any role, or an active platform maintainer. Null when the database is unavailable.
   */
  browserUser?(brandId: string, userId: string): Promise<boolean | null>;
  /** The user behind an active member row of the brand (whose paired Chrome that member's turns use); null when none, undefined when unavailable. */
  memberUser?(brandId: string, memberId: string): Promise<string | null | undefined>;
  /**
   * The brand profile, members and connections; null when the database is unavailable or the brand is unknown. `fresh` skips the
   * cache. An unreadable member list gives `members: []` with `membersUnreadable`.
   */
  /** True/false from a successful read of `brands`; false only when the table has rows and none is this brand. Null when the database cannot be read. */
  brandExists?(brandId: string): Promise<boolean | null>;
  get(brandId: string, options?: { fresh?: boolean }): Promise<BrandContext | null>;
  /**
   * Assigned sandbox host, or null. On a Daytona server this starts the brand's sandbox when it is stopped, so `reason` names the work that needs it (logged
   * on `daytona.ready`). The router may supply its server-owned provider selection to avoid a duplicate read.
   */
  assignedHost?(brandId: string, reason: WakeReason, provider?: "gce" | "daytona"): Promise<string | null>;
  /** Fresh runtime selection. Unavailable selection is an error, never permission to fall back to a VM. */
  runtimeProvider?(brandId: string): Promise<"gce" | "daytona">;
  /** The brand's isolated runtime: fresh Daytona selection, else a dedicated GCE assignment. Shared GCE is refused. */
  dedicatedHost?(brandId: string, reason: WakeReason): Promise<string | null>;
  /** The latest changes to the member list, newest first; null when the database or the table is not readable. */
  memberEvents?(brandId: string, limit?: number): Promise<MemberEvent[] | null>;
  /** The saved version of the brand profile: 0 when the brand has none, null when the database is not readable. One cheap read per turn. */
  brandProfileVersion?(brandId: string): Promise<number | null>;
  /** The saved brand profile (the owner's intake answers); null when there is none or the database is not readable. */
  brandProfile?(brandId: string): Promise<StoredBrandProfile | null>;
}

export interface StoredBrandProfile {
  version: number;
  status: "draft" | "completed" | "skipped";
  answers: Record<string, unknown>;
}

const KNOWN_PROVIDERS: ReadonlySet<string> = new Set(CONNECTOR_PROVIDERS);

/** Tables the agent may read, with the columns it may see and the column that scopes them to a brand. */
export const READABLE_TABLES = {
  brand_members: { columns: ["id", "display_name", "phone_e164", "created_at"], scope: "brand_id" },
  /** In the shared source store (database zs_sources, schema sources), read through `ReadOnlyPg.sources`. */
  connections: { columns: ["id", "provider", "status", "mode", "external_id", "metadata", "error", "connected_at", "last_checked_at", "last_synced_at", "last_sync_status"], scope: "brand_id", store: "sources" },
  channel_conversations: { columns: ["channel", "conversation_id", "kind", "title", "created_at"], scope: "brand_id" },
  brand_assignments: { columns: ["agent_host_id", "phone_number_id", "mode", "assigned_at"], scope: "brand_id" },
  brands: { columns: ["id", "name", "website_url", "onboarding_completed_at", "created_at"], scope: "id" },
} as const;
export type ReadableTable = keyof typeof READABLE_TABLES;

export interface PgConnection {
  host: string | null;
  port: number;
  database: string;
  user: string;
  password: string | null;
}

/** A read-only Postgres client. Every statement runs in a READ ONLY transaction as the zs_agent_ro role. */
/** SQLSTATE of a permission refusal: the only failure that turns the members' email read off for good. */
const INSUFFICIENT_PRIVILEGE = "42501";
/** SQLSTATE of a missing relation: a database where pgroll a07 (maintainer_phone_leases) has not been applied yet. */
const UNDEFINED_TABLE = "42P01";

export class ReadOnlyPg {
  private pool: pg.Pool | null = null;

  constructor(
    private readonly connection: () => Promise<PgConnection>,
    private readonly logger: Logger,
    private readonly sourcesStore?: ReadOnlyPg,
  ) {}

  /**
   * The read-only client of the shared source store (connector rows of both environments, MLY-412); its statements name
   * `sources.<table>`. Without one (tests: one throwaway database holds both schemas) this same client answers; a deployed
   * environment database has no `sources` schema, so such a read fails (null) rather than reading anything else.
   */
  get sources(): ReadOnlyPg {
    return this.sourcesStore ?? this;
  }

  /** Null on any failure (logged by class). `onError` gets the failure's SQLSTATE, or null when it has none (connect, reset). */
  async query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = [], onError?: (sqlstate: string | null) => void): Promise<T[] | null> {
    try {
      const pool = await this.getPool();
      if (!pool) return null;
      const client = await pool.connect();
      let finished = false;
      try {
        await client.query("BEGIN READ ONLY");
        await client.query("SET LOCAL statement_timeout = '10s'");
        const result = await client.query<T>(sql, params);
        await client.query("ROLLBACK");
        finished = true;
        return result.rows;
      } finally {
        // A failed statement leaves its transaction aborted: such a connection is dropped, never lent out again (the next query on it would fail with 25P02).
        client.release(!finished);
      }
    } catch (error) {
      this.logger.warn("pg.query_failed", { errorClass: errorClass(error) });
      const code = (error as { code?: unknown } | null)?.code;
      onError?.(typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null);
      return null;
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  private async getPool(): Promise<pg.Pool | null> {
    if (this.pool) return this.pool;
    const connection = await this.connection();
    if (!connection.host || !connection.password) return null;
    this.pool = new pg.Pool({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
      password: connection.password,
      max: 4,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
      options: "-c default_transaction_read_only=on",
    });
    this.pool.on("error", (error) => this.logger.warn("pg.pool_error", { errorClass: errorClass(error) }));
    return this.pool;
  }
}

/** Reads rows of one allowlisted table for one brand. The statement is built from the allowlist, never from model text. */
export async function readBrandTable(
  db: ReadOnlyPg,
  brandId: string,
  table: ReadableTable,
  limit = 50,
): Promise<Record<string, unknown>[] | null> {
  const spec: { columns: readonly string[]; scope: string; store?: "sources" } = READABLE_TABLES[table];
  // A test double typed as ReadOnlyPg may lack the getter; it then answers both.
  const rows = await (spec.store === "sources" ? db.sources ?? db : db).query<Record<string, unknown>>(
    `SELECT ${spec.columns.join(", ")} FROM ${spec.store === "sources" ? `sources.${table}` : table} WHERE ${spec.scope} = $1 LIMIT ${Math.min(Math.max(limit, 1), 200)}`,
    [brandId],
  );
  return rows;
}

const CACHE_MS = 5 * 60_000;
const HOST_CACHE_MS = 60_000;

export class RuntimeProviderReadError extends Error {}

/** The brand directory backed by Postgres, cached for five minutes. */
export class PgBrandDirectory implements BrandDirectory {
  private cache = new Map<string, { at: number; value: BrandContext | null }>();
  private emailReadable = true;
  private leaseReadable = true;

  constructor(
    private readonly db: ReadOnlyPg,
    private readonly now: () => number = Date.now,
    private readonly logger?: Logger,
    private readonly runtime?: { env: string; ensure(brandId: string, reason: WakeReason): Promise<{ hostId: `dt:${string}` }> },
  ) {}

  private hosts = new Map<string, { at: number; host: string }>();

  async isSignupOwner(brandId: string, memberId: string, phone: string): Promise<boolean> {
    const rows = await this.db.query(`SELECT m.id FROM brands b JOIN brand_members m ON m.brand_id=b.id AND m.user_id=b.owner_user_id
      WHERE b.id=$1::uuid AND m.id=$2::uuid AND m.status='active'
      AND regexp_replace(m.phone_e164,'^\\+','')=regexp_replace($3,'^\\+','') AND b.onboarding_completed_at IS NOT NULL`, [brandId, memberId, phone]);
    return rows?.length === 1;
  }

  async brandExists(brandId: string): Promise<boolean | null> {
    const rows = await this.db.query<{ present: boolean; total: string }>("SELECT EXISTS (SELECT 1 FROM brands WHERE id = $1::uuid) AS present, (SELECT count(*) FROM brands)::text AS total", [brandId]);
    const row = rows?.[0];
    if (!row) return null;
    if (row.present) return true;
    return Number(row.total) > 0 ? false : null;
  }

  async signupOwner(brandId: string): Promise<string | null> {
    const answer = await this.signupOwnerAnswer(brandId);
    return answer.kind === "owner" ? answer.memberId : null;
  }

  async signupOwnerAnswer(brandId: string): Promise<SignupOwnerAnswer> {
    const rows = await this.db.query<{ id: string }>(`SELECT m.id::text AS id FROM brands b JOIN brand_members m ON m.brand_id=b.id AND m.user_id=b.owner_user_id
      WHERE b.id=$1::uuid AND m.status='active' AND b.onboarding_completed_at IS NOT NULL`, [brandId]);
    if (rows === null) return { kind: "unreadable" };
    return rows.length === 1 ? { kind: "owner", memberId: rows[0]!.id } : { kind: "none" };
  }

  async servedBrands(): Promise<string[] | null> {
    const rows = await this.db.query<{ id: string }>("SELECT id::text AS id FROM brands WHERE onboarding_completed_at IS NOT NULL ORDER BY id", []);
    return rows ? rows.map((row) => row.id) : null;
  }

  async pixelAuditConsent(brandId: string): Promise<boolean | null> {
    const rows = await this.db.query<{ consented: boolean }>("SELECT (pixel_audit_consent_at IS NOT NULL) AS consented FROM brands WHERE id=$1::uuid", [brandId]);
    return rows?.length === 1 ? rows[0]!.consented === true : null;
  }

  async browserUser(brandId: string, userId: string): Promise<boolean | null> {
    // Anyone of the brand's team pairs their own Chrome: any row of the brand whatever its role or status, or a platform maintainer
    // (no role, status or maintainer gate inside a brand, owner's 2026-11-12 order). Only the brand fence stays.
    const rows = await this.db.query<{ ok: boolean }>(`SELECT (EXISTS (SELECT 1 FROM brand_members m WHERE m.brand_id=$1::uuid AND m.user_id=$2::uuid)
      OR EXISTS (SELECT 1 FROM platform_maintainers p WHERE p.user_id=$2::uuid AND p.revoked_at IS NULL)) AS ok`, [brandId, userId]);
    return rows ? Boolean(rows[0]?.ok) : null;
  }

  async memberUser(brandId: string, memberId: string): Promise<string | null | undefined> {
    // The user behind the turn's own member row of this brand, whatever its role or status: the server already decided this person is speaking.
    const rows = await this.db.query<{ user_id: string }>(`SELECT user_id::text AS user_id FROM brand_members WHERE id=$2::uuid AND brand_id=$1::uuid AND user_id IS NOT NULL`, [brandId, memberId]);
    if (!rows) return undefined;
    return rows[0]?.user_id ?? null;
  }

  /** The brand's assigned host, cached for a minute once found (an empty answer is never cached). */
  async memberEvents(brandId: string, limit = 30): Promise<MemberEvent[] | null> {
    const rows = await this.db.query<{
      created_at: Date | string;
      action: string;
      member_id: string | null;
      display_name: string | null;
      actor_label: string | null;
      status_before: string | null;
      status_after: string | null;
    }>(
      `SELECT e.created_at, e.action, e.member_id, m.display_name, e.actor_label,
              e.before->>'status' AS status_before, e.after->>'status' AS status_after
         FROM brand_member_events e LEFT JOIN brand_members m ON m.id = e.member_id
        WHERE e.brand_id = $1 ORDER BY e.created_at DESC LIMIT ${Math.min(Math.max(Math.floor(limit), 1), 100)}`,
      [brandId],
    );
    if (!rows) return null;
    return rows.map((row) => ({
      at: new Date(row.created_at).toISOString(),
      action: row.action,
      memberId: row.member_id,
      memberName: row.display_name,
      by: row.actor_label,
      statusBefore: row.status_before,
      statusAfter: row.status_after,
    }));
  }

  async brandProfileVersion(brandId: string): Promise<number | null> {
    const rows = await this.db.query<{ version: number }>("SELECT version FROM brand_profiles WHERE brand_id = $1", [brandId]);
    return rows ? (rows[0]?.version ?? 0) : null;
  }

  async brandProfile(brandId: string): Promise<StoredBrandProfile | null> {
    const rows = await this.db.query<{ version: number; status: StoredBrandProfile["status"]; answers: Record<string, unknown> }>(
      "SELECT version, status, answers FROM brand_profiles WHERE brand_id = $1",
      [brandId],
    );
    const row = rows?.[0];
    return row ? { version: row.version, status: row.status, answers: row.answers ?? {} } : null;
  }

  async assignedHost(brandId: string, reason: WakeReason, provider?: "gce" | "daytona"): Promise<string | null> {
    if (this.runtime && (provider ?? await this.runtimeProvider(brandId)) === "daytona") return (await this.runtime.ensure(brandId, reason)).hostId;
    const hit = this.hosts.get(brandId);
    if (hit && this.now() - hit.at < HOST_CACHE_MS) return hit.host;
    const rows = await readBrandTable(this.db, brandId, "brand_assignments", 1);
    const host = rows?.[0]?.agent_host_id;
    if (typeof host !== "string" || !host) return null;
    this.hosts.set(brandId, { at: this.now(), host });
    return host;
  }

  /** Every brand runs on Daytona wherever this server has a Daytona runtime; without one (a local stack, the simulator) the assigned host is used. */
  async runtimeProvider(_brandId: string): Promise<"gce" | "daytona"> {
    return this.runtime ? "daytona" : "gce";
  }

  async dedicatedHost(brandId: string, reason: WakeReason): Promise<string | null> {
    if (this.runtime && await this.runtimeProvider(brandId) === "daytona") return (await this.runtime.ensure(brandId, reason)).hostId;
    const row = (await readBrandTable(this.db, brandId, "brand_assignments", 1))?.[0];
    const host = row?.agent_host_id;
    return row?.mode === "dedicated" && typeof host === "string" && host ? host : null;
  }

  /**
   * Members with their status, email (users.email), timezone (brand_members.timezone) and the maintainer lease epoch of their user
   * (maintainer_phone_leases, a left join in the same statement: no extra query per turn). If the read-only role is refused
   * users (SQLSTATE 42501), members come without the email from then on; if the lease table is refused or missing (42501, 42P01: a
   * database before pgroll a07), members come without `leaseEpoch` from then on (logged once). Any other failure (a timeout, a
   * reset connection) falls back to members without the email and the epoch for that read only. A failed read gives null, which the
   * directory flags as an unreadable list (never a list of active members). Every schema has `brand_members.status` and
   * `brand_members.timezone` (`packages/db/migrations-pgroll/a01_init.json`), so there is no read without them.
   */
  private async readMembers(brandId: string): Promise<Record<string, unknown>[] | null> {
    const base = "m.id, m.display_name, m.phone_e164, m.status, m.timezone";
    const attempt = async (withEmail: boolean, withLease: boolean) => {
      const failure = { sqlstate: null as string | null };
      const columns = [base, withEmail ? "u.email" : "", withLease ? `COALESCE(l.epoch, 0) AS lease_epoch, (l.target_member_id = m.id AND l.expires_at IS NOT NULL) AS maintainer_lease, ${MAINTAINER_ENTRY_SQL}, ${PARKED_ENTRY_SQL}` : ""].filter(Boolean).join(", ");
      const from = `${withEmail ? " LEFT JOIN users u ON u.id = m.user_id" : ""}${withLease ? " LEFT JOIN maintainer_phone_leases l ON l.user_id = m.user_id LEFT JOIN brands bo ON bo.id = m.brand_id" : ""}`;
      const rows = await this.db.query<Record<string, unknown>>(`SELECT ${columns} FROM brand_members m${from} WHERE m.brand_id = $1 LIMIT 100`, [brandId], (sqlstate) => { failure.sqlstate = sqlstate; });
      return { rows, sqlstate: failure.sqlstate };
    };
    const refused = (sqlstate: string | null): boolean => sqlstate === INSUFFICIENT_PRIVILEGE || sqlstate === UNDEFINED_TABLE;
    if (this.leaseReadable) {
      const full = await attempt(this.emailReadable, true);
      if (full.rows) return full.rows;
      if (!refused(full.sqlstate)) return (await attempt(false, false)).rows;
      // Refused: the email join or the lease join. Without the email first, so a refused users table costs the one failed email statement it always did.
      if (this.emailReadable) {
        const withoutEmail = await attempt(false, true);
        if (withoutEmail.rows) {
          if (full.sqlstate === INSUFFICIENT_PRIVILEGE) this.emailReadable = false;
          return withoutEmail.rows;
        }
        if (!refused(withoutEmail.sqlstate)) return (await attempt(false, false)).rows;
      }
      this.leaseReadable = false;
      this.logger?.warn("directory.lease_unreadable", { sqlstate: full.sqlstate });
    }
    if (this.emailReadable) {
      const withEmail = await attempt(true, false);
      if (withEmail.rows) return withEmail.rows;
      if (withEmail.sqlstate === INSUFFICIENT_PRIVILEGE) this.emailReadable = false;
    }
    return (await attempt(false, false)).rows;
  }

  /**
   * Stored preferences by member id. Joined through brand_members, so a row is only ever seen through its member's brand.
   * A database without the table (migration 0012 not applied yet) or a failed read gives no preferences, never an error.
   * A stored value that does not parse is ignored and logged.
   */
  private async readPreferences(brandId: string): Promise<Map<string, MemberPreferences>> {
    const rows = await this.db.query<{ member_id: string; preferences: unknown }>(
      "SELECT p.member_id, p.preferences FROM member_preferences p JOIN brand_members m ON m.id = p.member_id WHERE m.brand_id = $1 LIMIT 100",
      [brandId],
    );
    const out = new Map<string, MemberPreferences>();
    for (const row of rows ?? []) {
      const parsed = parseMemberPreferences(row.preferences);
      if (parsed.ok) out.set(String(row.member_id), parsed.value);
      else this.logger?.warn("directory.preferences_ignored", { brandId, memberId: String(row.member_id), errors: parsed.errors });
    }
    return out;
  }

  async get(brandId: string, options: { fresh?: boolean } = {}): Promise<BrandContext | null> {
    const hit = this.cache.get(brandId);
    if (hit && !options.fresh && this.now() - hit.at < CACHE_MS) return hit.value;
    const brand = await readBrandTable(this.db, brandId, "brands", 1);
    if (!brand?.[0]) {
      this.cache.set(brandId, { at: this.now() - CACHE_MS + 30_000, value: null });
      return null;
    }
    const [members, connections, preferences] = await Promise.all([
      this.readMembers(brandId),
      readBrandTable(this.db, brandId, "connections", 100),
      this.readPreferences(brandId),
    ]);
    const value: BrandContext = {
      brandId,
      name: String(brand[0].name ?? "the brand"),
      websiteUrl: brand[0].website_url ? String(brand[0].website_url) : null,
      members: (members ?? [])
        // Parked maintainer rows are not members. Without the lease read they cannot be told apart, so every row stays (no status gate).
        .filter((row) => row.parked_entry !== true || row.maintainer_entry === true || row.maintainer_lease === true)
        .map((row) => ({
          id: String(row.id),
          displayName: String(row.display_name),
          phoneE164: typeof row.phone_e164 === "string" && row.phone_e164 ? row.phone_e164 : row.maintainer_entry === true && typeof row.entry_phone === "string" && row.entry_phone ? row.entry_phone : null,
          status: row.status === "active" || row.maintainer_entry === true ? ("active" as const) : ("pending" as const),
          email: typeof row.email === "string" && row.email ? row.email : null,
          timezone: typeof row.timezone === "string" && row.timezone ? row.timezone : null,
          preferences: preferences.get(String(row.id)) ?? null,
          ...(row.lease_epoch === undefined || row.lease_epoch === null || !Number.isSafeInteger(Number(row.lease_epoch)) ? {} : { leaseEpoch: Number(row.lease_epoch) }),
          ...(row.maintainer_lease === true || row.maintainer_entry === true ? { maintainerLease: true as const } : {}),
        })),
      // The shared store can hold a source a later release added (staging adds them first): skipped, never shown.
      connections: (connections ?? []).filter((row) => KNOWN_PROVIDERS.has(String(row.provider))).map((row) => ({
        provider: String(row.provider),
        status: String(row.status),
        mode: String(row.mode),
        connectedAt: row.connected_at ? new Date(String(row.connected_at)).toISOString() : null,
        lastSyncedAt: isoOrNull(row.last_synced_at),
        lastSyncStatus: typeof row.last_sync_status === "string" && row.last_sync_status ? row.last_sync_status : null,
      })),
      ...(members ? {} : { membersUnreadable: true as const }),
    };
    this.cache.set(brandId, { at: this.now(), value });
    return value;
  }
}

function isoOrNull(value: unknown): string | null {
  if (!value) return null;
  const time = new Date(String(value));
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

/** A directory with a fixed answer, for tests and the local harness. */
export class StaticBrandDirectory implements BrandDirectory {
  constructor(
    private readonly brands: Record<string, BrandContext>,
    private readonly hosts: Record<string, string> = {},
  ) {}
  async get(brandId: string): Promise<BrandContext | null> {
    return this.brands[brandId] ?? null;
  }
  async assignedHost(brandId: string, _reason?: WakeReason): Promise<string | null> {
    return this.hosts[brandId] ?? null;
  }
}
