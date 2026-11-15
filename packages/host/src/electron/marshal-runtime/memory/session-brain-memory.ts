import { randomUUID } from "node:crypto";

import type { BrainMemoryHit, SessionBrainMemory } from "../../backend/ports";
import type { MarshalRuntimeApi, MarshalRuntimeScope } from "../contracts";
import { wrapUntrustedMemoryFact } from "./prompt-provenance";

const REMEMBER = "memory.remember";
const RECALL = "memory.recall";
const FORGET = "memory.forget";
const CALL_TIMEOUT_MS = 30_000;
const LOOKUP_TIMEOUT_MS = 1_500;

export interface SessionBrainMemoryOptions {
  readonly api: Pick<MarshalRuntimeApi, "search" | "invoke">;
  readonly resolveScope: (sessionId: string) => Promise<MarshalRuntimeScope | null>;
}

/**
 * Per-session Brain memory: present only when the session's own runtime scope
 * offers `memory.remember` (the Brain lists it only in workspaces it serves
 * with memory), so every other workspace keeps memories local.
 */
export function createSessionBrainMemoryResolver(
  options: SessionBrainMemoryOptions,
): (sessionId: string) => Promise<SessionBrainMemory | undefined> {
  return async (sessionId) => {
    const scope = await options.resolveScope(sessionId).catch(() => null);
    if (!scope) return undefined;
    const found = await options.api
      .search({
        ...scope,
        name: REMEMBER,
        limit: 1,
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      })
      .catch(() => undefined);
    const offered =
      found?.ok === true &&
      found.value.matches.some((match) => match.capability?.name === REMEMBER);
    return offered ? sessionBrainMemory(options.api, scope) : undefined;
  };
}

function sessionBrainMemory(
  api: Pick<MarshalRuntimeApi, "invoke">,
  scope: MarshalRuntimeScope,
): SessionBrainMemory {
  const call = async (capability: string, input: Record<string, unknown>) => {
    const response = await api.invoke({
      ...scope,
      capability,
      input,
      idempotencyKey: `marshal-memory:${capability}:${randomUUID()}`,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${capability} failed: ${response.error.message}`);
    return capabilityOutput(response.value.output);
  };
  return {
    async remember(input) {
      const output = await call(REMEMBER, {
        content: input.content,
        ...(input.links?.length ? { links: input.links } : {}),
        ...(input.entities?.length ? { entities: input.entities } : {}),
        ...(input.key ? { key: input.key } : {}),
      });
      if (typeof output.key !== "string" || !output.key) {
        throw new Error(`${REMEMBER} returned no key`);
      }
      return { key: output.key };
    },
    async recall(query, limit) {
      const output = await call(RECALL, { query, limit });
      return Array.isArray(output.results) ? output.results.flatMap(toBrainMemoryHit) : [];
    },
    async forget(key) {
      const output = await call(FORGET, { key });
      return typeof output.forgotten === "string";
    },
  };
}

export type BrainCopyResult = { stored: true; key: string } | { stored: false; error: string };

/** The local memory is kept either way; a Brain failure is reported, never fatal. */
export async function rememberInBrain(
  brain: SessionBrainMemory,
  input: Parameters<SessionBrainMemory["remember"]>[0],
): Promise<BrainCopyResult> {
  try {
    return { stored: true, key: (await brain.remember(input)).key };
  } catch (error) {
    return { stored: false, error: `Kept locally only: ${errorText(error)}` };
  }
}

/** Brain hits not already shown as a local memory, shaped like `recall` entries. */
export async function recallFromBrain(
  brain: SessionBrainMemory,
  query: string,
  localBrainKeys: ReadonlySet<string>,
  limit = 10,
): Promise<{ entries: Record<string, unknown>[]; error?: string }> {
  try {
    const hits = await brain.recall(query, limit);
    return {
      entries: hits
        .filter((hit) => !hit.key || !localBrainKeys.has(hit.key))
        .map((hit) => ({
          id: hit.id,
          fact: wrapUntrustedMemoryFact(hit.text),
          source: "brain",
          ...(hit.key ? { key: hit.key } : {}),
        })),
    };
  } catch (error) {
    return { entries: [], error: errorText(error) };
  }
}

export async function forgetInBrain(
  brain: SessionBrainMemory,
  key: string,
): Promise<{ forgotten: boolean; error?: string }> {
  try {
    return { forgotten: await brain.forget(key) };
  } catch (error) {
    return { forgotten: false, error: errorText(error) };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Capability outputs may arrive bare or in an `{ok, value}` envelope. */
function capabilityOutput(output: unknown): Record<string, unknown> {
  const record = asRecord(output);
  if (record.ok === false) {
    throw new Error(typeof record.error === "string" ? record.error : "Brain memory call failed");
  }
  return record.ok === true && "value" in record ? asRecord(record.value) : record;
}

function toBrainMemoryHit(value: unknown): BrainMemoryHit[] {
  const hit = asRecord(value);
  const text = [hit.content, hit.text, hit.name, hit.summary].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  if (typeof hit.id !== "string" || !text) return [];
  return [{ id: hit.id, text, ...(typeof hit.key === "string" ? { key: hit.key } : {}) }];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
