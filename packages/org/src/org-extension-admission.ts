import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { createLogger } from "../host-deps";
import { FIRST_PARTY_EXTENSION_CATALOG } from "../host-deps";
import { secureAtomicWriteFileSync } from "../host-deps";
import { loadOrCreateKey } from "../host-deps";

const log = createLogger("OrgExtensionAdmission");
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface OrgTrustedExtensions {
  /** Called by the org onboarding install after it verified the archive against the manifest sha256. */
  trust(identity: string, packageIntegrity: string): void;
  /** Developer escape: trusts a local build. Counts only while the escape is on. */
  trustLocalBuild(identity: string, packageIntegrity: string): void;
  /** One-time migration: trusts what is installed and enabled now. Returns what it trusted; no-op afterwards or when locked. */
  grandfather(installed: readonly { identity: string; integrity: string }[]): string[] | undefined;
  isTrusted(
    identity: string,
    packageIntegrity: string,
    options?: { includeLocal?: boolean },
  ): boolean;
  locallyTrustedIdentities(): string[];
  grandfatheredIdentities(): string[];
  /** True when the store exists but could not be verified: nothing beyond the bundled catalog is trusted. */
  isLocked(): boolean;
}

type IntegrityMap = Map<string, Set<string>>;

function readMap(value: unknown): IntegrityMap {
  const map: IntegrityMap = new Map();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return map;
  for (const [identity, values] of Object.entries(value)) {
    if (!Array.isArray(values)) continue;
    map.set(
      identity,
      new Set(values.filter((v): v is string => typeof v === "string" && SHA256_PATTERN.test(v))),
    );
  }
  return map;
}

function writeMap(map: IntegrityMap): Record<string, string[]> {
  return Object.fromEntries([...map].map(([identity, values]) => [identity, [...values]]));
}

function add(map: IntegrityMap, identity: string, integrity: string): void {
  if (!SHA256_PATTERN.test(integrity)) throw new TypeError("integrity must be sha256 hex");
  const values = map.get(identity) ?? new Set<string>();
  values.add(integrity);
  map.set(identity, values);
}

const MAC_CONTEXT = "marshal-org-trusted-extensions-v1\n";

function macOf(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(MAC_CONTEXT).update(data).digest("hex");
}

interface StoreState {
  trusted: IntegrityMap;
  localBuilds: IntegrityMap;
  grandfathered?: { at: number; identities: string[] };
}

/**
 * Package integrity values the org vouched for, grandfathered once, or the developer trusted locally.
 * The file carries an HMAC under the safeStorage key, so an extension that can write files cannot add
 * hashes; a file that exists but fails verification (or has no key to verify with) locks the store:
 * nothing beyond the bundled catalog is trusted and the one-time grandfathering is never re-run.
 */
export function createOrgTrustedExtensions(
  filePath: string,
  options: { now?: () => number; onChanged?: () => void; getKey?: () => Buffer | null } = {},
): OrgTrustedExtensions {
  const getKey = options.getKey ?? loadOrCreateKey;
  let state: StoreState | "locked" | undefined;

  const load = (): StoreState | "locked" => {
    if (state) return state;
    const fresh = (): StoreState => ({ trusted: new Map(), localBuilds: new Map() });
    if (!existsSync(filePath)) {
      state = getKey() ? fresh() : "locked";
      return state;
    }
    try {
      const key = getKey();
      if (!key) throw new Error("no key");
      const envelope: unknown = JSON.parse(readFileSync(filePath, "utf8")); // SF-4: shape and MAC checked below
      if (
        typeof envelope !== "object" ||
        envelope === null ||
        !("data" in envelope) ||
        !("mac" in envelope) ||
        typeof envelope.data !== "string" ||
        typeof envelope.mac !== "string"
      ) {
        throw new Error("bad envelope");
      }
      const expected = Buffer.from(macOf(key, envelope.data), "hex");
      const actual = Buffer.from(envelope.mac, "hex");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new Error("bad mac");
      }
      const raw: unknown = JSON.parse(envelope.data); // SF-4: authenticated by the MAC above
      if (typeof raw !== "object" || raw === null) throw new Error("bad data");
      const loaded = fresh();
      loaded.trusted = readMap("trusted" in raw ? raw.trusted : undefined);
      loaded.localBuilds = readMap("localBuilds" in raw ? raw.localBuilds : undefined);
      const g = "grandfathered" in raw ? raw.grandfathered : undefined;
      if (typeof g === "object" && g !== null && "at" in g && typeof g.at === "number") {
        loaded.grandfathered = {
          at: g.at,
          identities:
            "identities" in g && Array.isArray(g.identities)
              ? g.identities.filter((v): v is string => typeof v === "string")
              : [],
        };
      }
      state = loaded;
    } catch {
      log.warn("Trusted extension store failed verification; only bundled extensions are trusted");
      state = "locked";
    }
    return state;
  };

  const writable = (): StoreState | undefined => {
    const current = load();
    return current === "locked" ? undefined : current;
  };

  const save = (current: StoreState) => {
    const key = getKey();
    if (!key) throw new Error("trusted extension store key unavailable");
    const data = JSON.stringify({
      trusted: writeMap(current.trusted),
      localBuilds: writeMap(current.localBuilds),
      ...(current.grandfathered ? { grandfathered: current.grandfathered } : {}),
    });
    secureAtomicWriteFileSync(filePath, JSON.stringify({ data, mac: macOf(key, data) }));
    options.onChanged?.();
  };

  return {
    trust(identity, packageIntegrity) {
      const current = writable();
      if (!current) {
        log.warn("Trusted extension store is locked; not recording trust");
        return;
      }
      add(current.trusted, identity, packageIntegrity);
      save(current);
    },
    trustLocalBuild(identity, packageIntegrity) {
      const current = writable();
      if (!current || current.localBuilds.get(identity)?.has(packageIntegrity)) return;
      add(current.localBuilds, identity, packageIntegrity);
      save(current);
    },
    grandfather(installed) {
      const current = writable();
      if (!current || current.grandfathered) return undefined;
      const added: [string, string][] = [];
      for (const entry of installed) {
        add(current.trusted, entry.identity, entry.integrity);
        added.push([entry.identity, entry.integrity]);
      }
      const identities = [...new Set(installed.map((entry) => entry.identity))];
      current.grandfathered = { at: (options.now ?? Date.now)(), identities };
      try {
        save(current);
      } catch (error) {
        state = undefined;
        throw error;
      }
      log.info(
        `Grandfathered ${identities.length} installed org-service extension(s): ${identities.join(", ") || "none"}`,
      );
      return identities;
    },
    isTrusted(identity, packageIntegrity, opts = {}) {
      const current = writable();
      if (!current) return false;
      return (
        current.trusted.get(identity)?.has(packageIntegrity) === true ||
        (opts.includeLocal === true &&
          current.localBuilds.get(identity)?.has(packageIntegrity) === true)
      );
    },
    locallyTrustedIdentities: () => {
      const current = writable();
      return current
        ? [...current.localBuilds].filter(([, v]) => v.size > 0).map(([id]) => id)
        : [];
    },
    grandfatheredIdentities: () => writable()?.grandfathered?.identities ?? [],
    isLocked: () => load() === "locked",
  };
}

/**
 * Admission check for the runtime extension manager. An extension whose identity may use the org
 * services is admitted only when its verified package hash is the bundled first-party one, one the org
 * onboarding manifest vouched for, one grandfathered at first launch, or (developer builds / tenant
 * policy) a local build; a local package that merely claims the identity is refused.
 */
export function createOrgExtensionAdmission(deps: {
  isGuarded: (identity: string) => boolean;
  trusted: OrgTrustedExtensions;
  allowLocalBuilds?: () => boolean;
  bundled?: readonly { identity: string; integrity: { value: string } }[];
}): (candidate: { identity: string; integrity: { value: string } }) => string | undefined {
  const bundled = deps.bundled ?? FIRST_PARTY_EXTENSION_CATALOG;
  return ({ identity, integrity }) => {
    if (!deps.isGuarded(identity)) return undefined;
    if (
      bundled.some(
        (entry) => entry.identity === identity && entry.integrity.value === integrity.value,
      )
    )
      return undefined;
    const allowLocal = deps.allowLocalBuilds?.() === true;
    if (deps.trusted.isTrusted(identity, integrity.value, { includeLocal: allowLocal })) {
      return undefined;
    }
    if (allowLocal && !deps.trusted.isLocked()) {
      deps.trusted.trustLocalBuild(identity, integrity.value);
      return undefined;
    }
    return `${identity} may use the organization services, but this package is neither bundled with Marshal nor listed by the organization's onboarding manifest`;
  };
}

/** Records to grandfather: allowlisted identities that are installed and enabled. */
export function grandfatherCandidates(
  records: readonly {
    identity: string;
    status: string;
    request: { integrity: { value: string } };
  }[],
  isGuarded: (identity: string) => boolean,
): { identity: string; integrity: string }[] {
  return records
    .filter((record) => record.status === "enabled" && isGuarded(record.identity))
    .map((record) => ({ identity: record.identity, integrity: record.request.integrity.value }));
}
