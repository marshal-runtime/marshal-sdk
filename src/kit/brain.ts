import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SessionClaims } from "../session-claims.js";
import type { SessionRecord } from "../session-store.js";

/** The cloud Brain's front door: the proxy that serves knowledge.*, memories and shared sessions. */
export const BRAIN_CLOUD_URL = "https://zyg-agents-front-559219955260.us-central1.run.app";
/** The service account the desktop mints its ID token for (the person's own credentials sign the request). */
export const BRAIN_CALLER_SERVICE_ACCOUNT = "brain-portal@zyg-ecom-meetings.iam.gserviceaccount.com";
/**
 * Brains by the name a manifest gives them (`"brain": {"index": "zyg"}`): the company Brain is the only one the SDK
 * knows by name today; another Brain is named by its address (brain.url) until a discovery list serves the names.
 */
export const BRAIN_INDEXES: Readonly<Record<string, string>> = { zyg: BRAIN_CLOUD_URL };
export const DEFAULT_BRAIN_INDEX = "zyg";
export const BRAIN_IDENTITY = "@marshal/brain";
/** Where to find a built @marshal/brain package when the kit is not given one. */
export const BRAIN_PACKAGE_ENV = "MARSHAL_SDK_BRAIN_PACKAGE";

export interface BrainKitOptions {
  /** A built @marshal/brain package (runtime-extension.json at its root). Defaults to $MARSHAL_SDK_BRAIN_PACKAGE. */
  packageRoot?: string;
  cloudUrl?: string;
  cloudAudience?: string;
  /**
   * `desktop` (default): the person's own Google user credentials (gcloud ADC, or `credentialsFile`) mint an
   * ID token; the Brain answers as that person. `delegated`: a service on Google Cloud signs with its own
   * metadata-server ID token, and the person comes from the host principal's `callerEmail` claim. `service-key`:
   * the same, signed with a service account key (`credentialsFile`, else $GOOGLE_APPLICATION_CREDENTIALS_JSON, else
   * the file $GOOGLE_APPLICATION_CREDENTIALS names), for a service with no metadata server (an E2B sandbox).
   */
  callerMode?: "desktop" | "delegated" | "service-key";
  /**
   * Desktop mode: an `authorized_user` credentials file (default: gcloud's application default credentials).
   * Service-key mode: a `service_account` key file.
   */
  credentialsFile?: string;
  callerServiceAccount?: string;
  /** Delegated mode: the person a run works for (lower-case work email). Put on the principal, never taken from model input. */
  callerEmail?: string;
  /** Access labels on the host principal (`staff`, `user:<email>`, `group:<name>`). */
  access?: readonly string[];
  /**
   * Claims of one session, for a host whose sessions act for different people, brands or members (one host serving
   * every brand). Called on every capability call a session makes, with the host's own session record (its `labels` are
   * the host's; nothing a model writes reaches them); the result is merged over `callerEmail`/`access` above for that
   * call. Fields: `callerEmail`, `conversationId`, `access`, `brand`, `member`; malformed values are dropped, so a call
   * with no valid `callerEmail` is refused by the Brain rather than made for the host. Calls outside a session (and
   * sessions this returns nothing for) keep the host's claims. With it, a delegated or service-key host that names no
   * `callerEmail` still loads the Brain: the person comes per session.
   */
  claimsFor?: (session: SessionRecord) => SessionClaims | undefined;
  /** knowledge.feedback writes to the Brain's search log. Off unless asked for. */
  feedback?: boolean;
  /**
   * How long one Brain call may wait, 1000-120000 ms. Default 60000: the Brain's front scales to zero and a cold
   * start can take more than the extension's own 30 s default; an unattended host has nobody waiting on it.
   */
  timeoutMs?: number;
}

export const BRAIN_TIMEOUT_MS = 60_000;

export interface BrainConfigurationInput {
  brain: BrainKitOptions;
  /** The directory name of the host's workspace: the Brain route that carries memory writes is keyed by it. */
  workspaceName: string;
  memoryWrites: boolean;
}

/** Where image/pack.mjs puts the Brain inside the installed SDK (onboarding's DEFAULT_EXTENSIONS "bundled"). */
export const BUNDLED_BRAIN = "extensions/brain";

/** The installed SDK's bundled Brain, when this SDK was packed with one. */
export function bundledBrainRoot(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(dir, "package.json")) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const bundled = path.join(dir, BUNDLED_BRAIN);
  return fs.existsSync(path.join(bundled, "runtime-extension.json")) ? bundled : undefined;
}

export function brainPackageRoot(
  options: BrainKitOptions,
  env: NodeJS.ProcessEnv = process.env,
  bundled: () => string | undefined = bundledBrainRoot,
): string {
  const root = options.packageRoot ?? env[BRAIN_PACKAGE_ENV] ?? bundled();
  if (!root) {
    throw new Error(
      `The kit's Brain needs a built ${BRAIN_IDENTITY} package: pass kit.brain.packageRoot, set ${BRAIN_PACKAGE_ENV}, or install an SDK packed with the Brain (see docs/kit.md).`,
    );
  }
  const resolved = path.resolve(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(resolved, "runtime-extension.json"), "utf8")) as { identity?: string };
  if (manifest.identity !== BRAIN_IDENTITY) {
    throw new Error(`${resolved} holds ${manifest.identity ?? "no extension"}, not ${BRAIN_IDENTITY}.`);
  }
  return resolved;
}

/** The Brain that keeps every person's personal memories (the extension's `memoryRoute`): the company Brain. */
export const PERSONAL_MEMORY_ROUTE = "zyg";

/**
 * The Brain extension's cloud-only surface: the knowledge tools, the shared-session tools, and the memory graph
 * writes when the kit carries memory: this workspace's route (`memory: true`) is the `workspace` home, and the company
 * Brain's route, pinned as `memoryRoute`, is the `personal` home (docs/memory.md). No local index, no brand tools, no
 * answer card.
 */
export function brainConfiguration(input: BrainConfigurationInput): Record<string, unknown> {
  const { brain } = input;
  const cloudUrl = brain.cloudUrl ?? BRAIN_CLOUD_URL;
  const cloudAudience = brain.cloudAudience ?? cloudUrl;
  return {
    brainSurface: "demo",
    answerCard: "off",
    noBrainWorkspaces: [],
    brainHostMemory: false,
    cloudEnabled: true,
    brandRemoteEnabled: false,
    cloudCallerMode: brain.callerMode ?? "desktop",
    cloudUrl,
    cloudAudience,
    cloudCallerServiceAccount: brain.callerServiceAccount ?? BRAIN_CALLER_SERVICE_ACCOUNT,
    cloudTimeoutMs: Math.min(120_000, Math.max(1_000, Math.round(brain.timeoutMs ?? BRAIN_TIMEOUT_MS))),
    ...(brain.credentialsFile ? { cloudCredentialsFile: brain.credentialsFile } : {}),
    ...(input.memoryWrites
      ? {
          memoryRoute: PERSONAL_MEMORY_ROUTE,
          brainRoutes: {
            [PERSONAL_MEMORY_ROUTE]: { cloudUrl: BRAIN_CLOUD_URL, cloudAudience: BRAIN_CLOUD_URL, memory: true },
            // The workspace's own Brain (kit.brain.cloudUrl); the company Brain when it has none.
            [input.workspaceName]: {
              cloudUrl,
              cloudAudience,
              memory: true,
            },
          },
        }
      : {}),
  };
}
