import type { FetchFn, TokenSource } from "../../gcp.js";
import { brandAccount } from "./credentials.js";

/** What a brand's registry object grants when the server first writes it: the provisioner's embeddings allowance for a VM. Speech: the `speech` block the brand's own VM object carries, copied exactly; when there is none (every brand that started on Daytona), the owner's default for all brands, enabled with 5000 characters a day (MLY-278, 2026-11-08). */
const EMBED_DAILY_TOKENS = 500_000;
const EMBED_BOOTSTRAP_TOKENS = 10_000_000;
const EMBED_BOOTSTRAP_MS = 14 * 24 * 3_600_000;
const SCAN_TTL_MS = 60_000;

export type IdAccessStep = "service_account" | "registry_read" | "registry";

/** A failed step with the HTTP status of the upstream answer; the message never carries a body or a token. */
/** `registryBrandMismatch`: the account's registry object already exists and names another brand (two brands sharing the first 8 hex digits share the account); it is left as it is. */
export interface IdAccessResult { registryBrandMismatch: boolean }

export class IdAccessError extends Error {
  constructor(readonly step: IdAccessStep, readonly status: number) {
    super(`id access ${step} failed: HTTP ${status}`);
  }
}

/** The IAM role the agent server's account needs for each step; named in the warning a denied step logs. */
export const ID_ACCESS_MISSING_ROLE: Record<IdAccessStep, string> = {
  service_account: "roles/iam.serviceAccountViewer on the brand account (iam.serviceAccounts.get)",
  registry_read: "roles/storage.objectViewer on <project>-embed-control, objects under registry/ (list and read the brand's VM object)",
  registry: "roles/storage.objectCreator on <project>-embed-control, objects under registry/",
};

/**
 * Lets the brand's own account use the two proxies from a Daytona sandbox by writing the registry object `registry/<project>/sa/<account unique id>.json`
 * that binds the account's ID token to the brand (the provisioner's `ensureEmbedAccess` writes the per-instance one for a VM and is not involved here).
 * The `roles/run.invoker` grants on `zs-embed` and `zs-speech` are not made here: the agent server holds no right to change a Cloud Run policy; the
 * provisioner's brain job binds them (`BrainAdmin.ensureProxyInvoker`). The object's `speech` block is copied exactly from the brand's newest per-instance
 * object (what its VM has today) and is {enabled: true, dailyCharacterLimit: 5000} when that has none (a brand with no VM object included). Idempotent: the object is created with
 * `ifGenerationMatch=0`, so an existing one keeps its limits and is never overwritten; when one exists for another brand the result says so. Additive
 * only: nothing a VM relies on is changed or removed, so switching a brand back to its VM breaks nothing.
 */
/** The owner's voice default for every brand (2026-11-08, MLY-278; the provisioner's VM value). */
const DEFAULT_SPEECH = { enabled: true, dailyCharacterLimit: 5000 } as const;

export function idAccessEnsurer(tokens: TokenSource, project: string, fetchFn: FetchFn = fetch, now: () => number = Date.now): (brandId: string) => Promise<IdAccessResult> {
  const authed = async (extra: Record<string, string> = {}): Promise<Record<string, string>> => ({ Authorization: `Bearer ${await tokens.accessToken()}`, ...extra });
  const json = { "Content-Type": "application/json" };

  const uniqueId = async (email: string): Promise<string> => {
    const response = await fetchFn(`https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}`, { headers: await authed(), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new IdAccessError("service_account", response.status);
    const body = (await response.json()) as { uniqueId?: unknown; email?: unknown };
    if (typeof body.uniqueId !== "string" || !/^\d{10,30}$/.test(body.uniqueId) || body.email !== email) throw new IdAccessError("service_account", 502);
    return body.uniqueId;
  };

  /** Every per-instance registry object (name, update time, brand, speech block), listed and read once and shared by all brands for a minute: the speech lookup never costs a request per brand per object. */
  let scan: { at: number; objects: Promise<{ updated: number; brandId: unknown; speech: unknown }[]> } | null = null;
  const vmObjects = (): Promise<{ updated: number; brandId: unknown; speech: unknown }[]> => {
    if (scan && now() - scan.at < SCAN_TTL_MS) return scan.objects;
    const bucket = `https://storage.googleapis.com/storage/v1/b/${project}-embed-control/o`;
    const prefix = `registry/${project}/`;
    const objects = (async () => {
      const found: { name: string; updated: number }[] = [];
      let page = "";
      do {
        const response = await fetchFn(`${bucket}?prefix=${encodeURIComponent(prefix)}&fields=${encodeURIComponent("items(name,updated),nextPageToken")}${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`, { headers: await authed(), signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new IdAccessError("registry_read", response.status);
        const body = (await response.json()) as { items?: { name?: unknown; updated?: unknown }[]; nextPageToken?: unknown };
        for (const item of body.items ?? []) if (typeof item.name === "string" && !item.name.startsWith(`${prefix}sa/`) && item.name.endsWith(".json")) found.push({ name: item.name, updated: Date.parse(String(item.updated)) || 0 });
        page = typeof body.nextPageToken === "string" ? body.nextPageToken : "";
      } while (page);
      const records: { updated: number; brandId: unknown; speech: unknown }[] = [];
      for (const object of found) {
        const response = await fetchFn(`${bucket}/${encodeURIComponent(object.name)}?alt=media`, { headers: await authed(), signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new IdAccessError("registry_read", response.status);
        const record = (await response.json()) as { brandId?: unknown; speech?: unknown };
        records.push({ updated: object.updated, brandId: record.brandId, speech: record.speech });
      }
      return records;
    })();
    const entry = { at: now(), objects };
    scan = entry;
    objects.catch(() => { if (scan === entry) scan = null; });
    return objects;
  };

  /** The `speech` block of the brand's newest per-instance registry object (its VM today): undefined when that has none or the brand has no VM object. */
  const vmSpeech = async (brandId: string): Promise<unknown> => {
    let newest: { updated: number; speech: unknown } | null = null;
    for (const record of await vmObjects()) if (record.brandId === brandId && (!newest || record.updated > newest.updated)) newest = record;
    return newest?.speech ?? undefined;
  };

  const registry = async (brandId: string, email: string, subject: string): Promise<boolean> => {
    const object = `registry/${project}/sa/${subject}.json`;
    const objectUrl = `https://storage.googleapis.com/storage/v1/b/${project}-embed-control/o/${encodeURIComponent(object)}?alt=media`;
    const readExisting = async (): Promise<boolean | null> => {
      const existing = await fetchFn(objectUrl, { headers: await authed(), signal: AbortSignal.timeout(15_000) });
      if (existing.status === 404) return null;
      if (!existing.ok) throw new IdAccessError("registry_read", existing.status);
      return ((await existing.json()) as { brandId?: unknown }).brandId !== brandId;
    };
    const already = await readExisting();
    if (already !== null) return already;
    const speech = await vmSpeech(brandId);
    const body = {
      enabled: true, brandId, email, subject,
      dailyTokenLimit: EMBED_DAILY_TOKENS, bootstrapTokenLimit: EMBED_BOOTSTRAP_TOKENS, bootstrapUntil: new Date(now() + EMBED_BOOTSTRAP_MS).toISOString(),
      speech: speech ?? DEFAULT_SPEECH,
    };
    const response = await fetchFn(`https://storage.googleapis.com/upload/storage/v1/b/${project}-embed-control/o?uploadType=media&name=${encodeURIComponent(object)}&ifGenerationMatch=0`, {
      method: "POST", headers: await authed(json), body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return false;
    if (response.status !== 412) throw new IdAccessError("registry", response.status);
    const raced = await readExisting();
    if (raced === null) throw new IdAccessError("registry_read", 404);
    return raced;
  };

  return async (brandId) => {
    const email = brandAccount(brandId, project);
    const subject = await uniqueId(email);
    return { registryBrandMismatch: await registry(brandId, email, subject) };
  };
}
