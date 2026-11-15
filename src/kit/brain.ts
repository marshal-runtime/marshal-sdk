import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The cloud Brain's front door: the proxy that serves knowledge.*, memories and shared sessions. */
export const BRAIN_CLOUD_URL = "https://zyg-agents-front-559219955260.us-central1.run.app";
/** The service account the desktop mints its ID token for (the person's own credentials sign the request). */
export const BRAIN_CALLER_SERVICE_ACCOUNT = "brain-portal@zyg-ecom-meetings.iam.gserviceaccount.com";
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
   * metadata-server ID token, and the person comes from the host principal's `callerEmail` claim.
   */
  callerMode?: "desktop" | "delegated";
  /** An `authorized_user` credentials file for desktop mode; defaults to gcloud's application default credentials. */
  credentialsFile?: string;
  callerServiceAccount?: string;
  /** Delegated mode: the person a run works for (lower-case work email). Put on the principal, never taken from model input. */
  callerEmail?: string;
  /** Access labels on the host principal (`staff`, `user:<email>`, `group:<name>`). */
  access?: readonly string[];
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
  memoryAnchorPath?: string;
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

/**
 * The Brain extension's cloud-only surface: the knowledge tools, the shared-session tools, and memory
 * proposals only when writes are on (a route with `memory: true` for this workspace). No local index,
 * no brand tools, no answer card.
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
          brainRoutes: {
            [input.workspaceName]: {
              cloudUrl,
              cloudAudience,
              memory: true,
              ...(input.memoryAnchorPath ? { memoryAnchorPath: input.memoryAnchorPath } : {}),
            },
          },
        }
      : {}),
  };
}
