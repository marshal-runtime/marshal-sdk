import type { OrgTranscriptStore } from "@zygstinct/marshal-sdk-port";
import type { OrgStoreConfig } from "./config.js";
import { redactingTranscripts } from "./redact.js";

export { parseOrgStoreConfig, type OrgStoreConfig, type OrgStoreEnv, type OrgStoreSinkConfig } from "./config.js";

/** Marley's declaration in the Zyg org store: sessions land under `sdk/v1/zygstinct/marley/env=<env>/brand=<brand>/<day>/<session>/`. */
export const MARLEY_IMPL = {
  v: 1 as const,
  workspace: "zygstinct",
  impl: "marley",
  partition: ["env", "brand"],
  fields: {
    procedure: { from: "label" as const, filter: true },
    role: { from: "label" as const, filter: true },
    kind: { from: "label" as const, filter: true },
    channel: { from: "label" as const, filter: true },
    conversation: { from: "label" as const, filter: true },
  },
};

interface OrgStoreLike {
  schedule(sessionId: string): void;
  close(): Promise<void>;
  readonly transcripts: OrgTranscriptStore;
}

/** What this module needs from the vendored SDK port; the engine passes the real one, a test a fake. */
export interface OrgStoreSdk<Store> {
  OrgStore: new (options: { objects: unknown; impl: typeof MARLEY_IMPL; fixedLabels: Record<string, string>; log?: (message: string, fields?: Record<string, unknown>) => void }, sessions: Store, isCurrent?: (nativeSessionId: string) => boolean | Promise<boolean>) => OrgStoreLike;
  fsObjectStore(root: string): unknown;
  gcsObjectStore(options: { bucket: string; accessToken: () => Promise<string> }): unknown;
}

export interface OrgStoreLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

export interface MarleyOrgStore {
  /** The backend transcript store the session store hands to the port (assign to `store.transcripts`). */
  readonly transcripts: OrgTranscriptStore;
  /** Call on every session idle/failed: publishes the root a moment later, off the turn. */
  onSessionEvent(type: string, payload: Record<string, unknown>): void;
  close(): Promise<void>;
}

/**
 * Search-only access to Marley's org store for a host (marshal-sdk #123 `orgSearch`): searchSessions and getSessionTranscript of every Marley host (the chat
 * engine, whose sessions the store holds, and the routine engine, which publishes nothing there) also read the published sessions of the workspace,
 * bounded to the caller's brand by the session scope label (the row's `brand` partition). Undefined when the sink is off.
 */
export interface MarleyOrgSearch {
  objects: unknown;
  workspace: string;
  /** The env partition Marley publishes under (ORG_STORE_ENV); the routine host reads the brand's day there (`marley.runs.today`). */
  env: string;
}

export function marleyOrgSearch(input: {
  config: OrgStoreConfig | undefined;
  sdk: { fsObjectStore(root: string): unknown; gcsObjectStore(options: { bucket: string; accessToken: () => Promise<string> }): unknown };
  accessToken: () => Promise<string>;
}): MarleyOrgSearch | undefined {
  const { config } = input;
  if (!config) return undefined;
  const objects = config.sink.kind === "dir" ? input.sdk.fsObjectStore(config.sink.path) : input.sdk.gcsObjectStore({ bucket: config.sink.bucket, accessToken: input.accessToken });
  return { objects, workspace: MARLEY_IMPL.workspace, env: config.env };
}

/** Builds Marley's org store on the SDK's. Returns undefined when the sink is off. */
export function createMarleyOrgStore<Store>(input: {
  config: OrgStoreConfig | undefined;
  sdk: OrgStoreSdk<Store>;
  sessions: Store;
  accessToken: () => Promise<string>;
  /** True while the VM that will run the next turn already holds the native session's transcript (no cloud read on that resume). */
  isCurrent?: (nativeSessionId: string) => boolean | Promise<boolean>;
  logger: OrgStoreLogger;
}): MarleyOrgStore | undefined {
  const { config } = input;
  if (!config) return undefined;
  const objects = config.sink.kind === "dir" ? input.sdk.fsObjectStore(config.sink.path) : input.sdk.gcsObjectStore({ bucket: config.sink.bucket, accessToken: input.accessToken });
  const store = new input.sdk.OrgStore(
    { objects, impl: MARLEY_IMPL, fixedLabels: { env: config.env }, log: (message, fields) => input.logger.warn("org_store.log", { message, ...fields }) },
    input.sessions,
    input.isCurrent,
  );
  input.logger.info("org_store.on", { env: config.env, sink: config.sink.kind });
  return {
    transcripts: redactingTranscripts(store.transcripts, (event, fields) => input.logger.warn(event, fields)),
    onSessionEvent(_type, payload) {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
      if (!sessionId) return;
      try {
        store.schedule(sessionId);
      } catch (error) {
        input.logger.warn("org_store.schedule_failed", { sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    },
    async close() {
      try {
        await store.close();
      } catch (error) {
        input.logger.warn("org_store.close_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}
