import type { ServerConfig } from "../../config.js";

const BRAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The Brain environment of the sandboxes this server runs, from its DAYTONA_ENV label: `staging` is staging; `prod`, `production` and the
 * local stack's `local`/`local-<name>` are production. Any other label throws, so a mistyped staging label (`stg`, `staging-2`) can never fall
 * into production's memory namespace (MLY-412).
 */
export function brainEnvOf(daytonaEnv: string | null): "production" | "staging" {
  if (daytonaEnv === null) throw new Error("DAYTONA_ENV is not set, so it names no Brain environment");
  if (daytonaEnv === "staging") return "staging";
  if (daytonaEnv === "prod" || daytonaEnv === "production" || daytonaEnv === "local" || /^local-[a-z0-9][a-z0-9-]{0,25}$/.test(daytonaEnv)) return "production";
  throw new Error(`DAYTONA_ENV ${JSON.stringify(daytonaEnv)} names no Brain environment (staging, prod, production, local, local-<name>)`);
}

/** The local stack's sandbox labels (`local`, `local-<name>`): the only ones whose Brain is served read-only. Typed on the label itself, never on anything a request carries. */
export function isLocalDaytonaEnv(daytonaEnv: string | null): boolean {
  return daytonaEnv === "local" || (daytonaEnv !== null && /^local-[a-z0-9][a-z0-9-]{0,25}$/.test(daytonaEnv));
}

/**
 * A local stack's onboarding-from-scratch sandbox (`zs-local` ZS_LOCAL_FRESH=1, label `local-fresh-<name>`): its read-only Brain keeps brand and member memory
 * under staging's namespace (`zs-staging/<brand>/...`), empty for every brand staging's Brain does not serve (zs-local refuses those), while the shared data
 * store stays the brand's real one. Typed on the label, like isLocalDaytonaEnv.
 */
export function isFreshLocalDaytonaEnv(daytonaEnv: string | null): boolean {
  return isLocalDaytonaEnv(daytonaEnv) && /^local-fresh-[a-z0-9]/.test(daytonaEnv!);
}

export interface ZsConfigInput {
  brandId: string;
  project: string;
  daytona: ServerConfig["daytona"];
  pg: Pick<ServerConfig["pg"], "dataDatabase">;
  /** PEM of the brand Postgres CA, read from `daytona.pgCaSecret`; required when `daytona.pgServerName` is set. */
  caPem: string | null;
  /** The brand has a Brain (a succeeded brain job, or it is one of the configured brain-token brands). */
  brainServed: boolean;
  /** The brand footage bucket (`FOOTAGE_BUCKET`); null: footage is not configured and the sandbox gets no footage policy. */
  footageBucket?: string | null;
}

/**
 * The `zs-config` document of a brand's sandbox (image/install/zs-config-apply): the same derivations the provisioner's `buildZsConfig` makes for a
 * VM (VM account `zs-brand-<8 hex>`, dataset `brand_<hex>`, brain database `brain-<8 hex>`), with the Postgres block pointing at the
 * brand link's loopback port. Pure: tests compare it with the provisioner's output field by field.
 */
export function buildDaytonaZsConfig(input: ZsConfigInput): Record<string, unknown> {
  const { brandId, project, daytona } = input;
  if (!BRAND_ID.test(brandId) || brandId !== brandId.toLowerCase()) throw new Error("invalid brand id");
  if (daytona.sandboxSshKeys.length === 0) throw new Error("DAYTONA_SANDBOX_SSH_KEYS is not set");
  const short = brandId.slice(0, 8);
  const pg = daytona.pgServerName
    ? (() => {
        if (!input.caPem?.includes("BEGIN CERTIFICATE")) throw new Error("the brand Postgres CA is not readable");
        return { host: "127.0.0.1", port: 15432, serverName: daytona.pgServerName, database: input.pg.dataDatabase, caPem: input.caPem };
      })()
    : undefined;
  const config: Record<string, unknown> = {
    version: 1,
    dataPolicy: { brandId, serviceAccount: `zs-brand-${short}@${project}.iam.gserviceaccount.com`, project, datasets: [`brand_${brandId.replace(/-/g, "")}`], ...(pg ? { pg } : {}) },
  };
  if (input.brainServed) {
    if (!daytona.brainInstance) throw new Error("DAYTONA_BRAIN_INSTANCE is not set but the brand has a brain");
    // A local-stack sandbox holds the brand's real Brain credentials: its broker refuses every corpus write (`readOnly`, as brand mode's VM broker does), so a local chat can read but never change the real Brain.
    // A staging sandbox shares the brand's Brain database but keeps its memory under zs-staging/ and only reads the shared data store
    // (the broker's identity.ts); the label is root-owned once zs-brain-enroll writes it, never something a chat or request can set.
    // A fresh local sandbox (isFreshLocalDaytonaEnv) takes staging's memory namespace too: empty memory, the real shared data, still read-only.
    config.brainPolicy = { project, instance: daytona.brainInstance, ...(brainEnvOf(daytona.env) === "staging" || isFreshLocalDaytonaEnv(daytona.env) ? { env: "staging" } : {}), ...(isLocalDaytonaEnv(daytona.env) ? { readOnly: true } : {}), brands: { [brandId]: { database: `brain-${short}`, serve: true } } };
  }
  if (input.footageBucket) config.footagePolicy = { bucket: input.footageBucket };
  config.sandboxSshKeys = [...daytona.sandboxSshKeys];
  return config;
}
