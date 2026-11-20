import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { ANTIGRAVITY_AUTH_SETUP_INSTRUCTIONS } from "../../common/runtime-config";
import {
  ANTIGRAVITY_CREDENTIALS_FILENAME,
  ANTIGRAVITY_DEFAULT_VERTEX_LOCATION,
  ANTIGRAVITY_SERVICE_ACCOUNT_FILENAME,
  GEMINI_API_KEY_ENV,
  GOOGLE_API_KEY_ENV,
  GOOGLE_APPLICATION_CREDENTIALS_ENV,
  GOOGLE_CLOUD_LOCATION_ENV,
  GOOGLE_CLOUD_PROJECT_ENV,
  GOOGLE_GENAI_USE_VERTEXAI_ENV,
  type AntigravityProcessEnv,
} from "./constants";

/**
 * How the bridge reaches Gemini. Vertex runs on a project (Application Default
 * Credentials or a service-account key file) or on an express-mode API key;
 * the Gemini API runs on an API key.
 */
export type AntigravityEndpoint =
  | {
      kind: "vertex";
      project: string;
      location: string;
      /** Service-account key file; absent = Application Default Credentials. */
      credentialsFile?: string;
    }
  | { kind: "vertex-express"; apiKey: string }
  | { kind: "gemini"; apiKey: string };

/** What Marshal stores for an account (`credentials.json`, mode 0600). */
export type StoredAntigravityCredentials = AntigravityEndpoint & { savedAt?: string };

export { ANTIGRAVITY_AUTH_SETUP_INSTRUCTIONS };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function antigravityCredentialsPath(homeDir: string): string {
  return path.join(homeDir, ANTIGRAVITY_CREDENTIALS_FILENAME);
}

function parseStored(value: unknown): StoredAntigravityCredentials | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value["kind"];
  if (kind === "vertex") {
    const project = text(value["project"]);
    if (!project) return undefined;
    const credentialsFile = text(value["credentialsFile"]);
    return {
      kind,
      project,
      location: text(value["location"]) ?? ANTIGRAVITY_DEFAULT_VERTEX_LOCATION,
      ...(credentialsFile ? { credentialsFile } : {}),
    };
  }
  if (kind === "vertex-express" || kind === "gemini") {
    const apiKey = text(value["apiKey"]);
    return apiKey ? { kind, apiKey } : undefined;
  }
  return undefined;
}

export async function loadStoredAntigravityCredentials(
  homeDir: string,
): Promise<StoredAntigravityCredentials | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(antigravityCredentialsPath(homeDir), "utf8"));
    return parseStored(parsed);
  } catch {
    return undefined;
  }
}

async function readGcloudProject(env: AntigravityProcessEnv): Promise<string | undefined> {
  const configDir =
    env["CLOUDSDK_CONFIG"] ??
    (process.platform === "win32"
      ? path.join(env["APPDATA"] ?? homedir(), "gcloud")
      : path.join(env["HOME"] ?? homedir(), ".config", "gcloud"));
  try {
    const active = (await readFile(path.join(configDir, "active_config"), "utf8")).trim() || "default";
    const ini = await readFile(path.join(configDir, "configurations", `config_${active}`), "utf8");
    let section = "";
    for (const line of ini.split(/\r?\n/)) {
      const header = /^\s*\[(.+)\]\s*$/.exec(line);
      if (header) {
        section = header[1] ?? "";
        continue;
      }
      const entry = /^\s*project\s*=\s*(\S+)\s*$/.exec(line);
      if (section === "core" && entry) return entry[1];
    }
  } catch {
    // No gcloud configuration on this machine.
  }
  return undefined;
}

/**
 * The endpoint a session runs on: the account's stored credentials first,
 * then the launch environment (the variables the Python SDK itself reads).
 */
export async function resolveAntigravityEndpoint(
  homeDir: string,
  env: AntigravityProcessEnv,
): Promise<AntigravityEndpoint | undefined> {
  const stored = await loadStoredAntigravityCredentials(homeDir);
  if (stored) {
    const { savedAt: _savedAt, ...endpoint } = stored;
    return endpoint;
  }
  const project = text(env[GOOGLE_CLOUD_PROJECT_ENV]);
  const location = text(env[GOOGLE_CLOUD_LOCATION_ENV]) ?? ANTIGRAVITY_DEFAULT_VERTEX_LOCATION;
  const credentialsFile = text(env[GOOGLE_APPLICATION_CREDENTIALS_ENV]);
  if (truthy(env[GOOGLE_GENAI_USE_VERTEXAI_ENV])) {
    const apiKey = text(env[GOOGLE_API_KEY_ENV]);
    if (!project && apiKey) return { kind: "vertex-express", apiKey };
    const resolvedProject = project ?? (await readGcloudProject(env));
    if (resolvedProject) {
      return {
        kind: "vertex",
        project: resolvedProject,
        location,
        ...(credentialsFile ? { credentialsFile } : {}),
      };
    }
  }
  const geminiKey = text(env[GEMINI_API_KEY_ENV]) ?? text(env[GOOGLE_API_KEY_ENV]);
  if (geminiKey) return { kind: "gemini", apiKey: geminiKey };
  return undefined;
}

/**
 * Turns what a person pasted into stored credentials. A service-account key
 * (JSON with `type: "service_account"`) is kept as its own 0600 file; a JSON
 * object with `project` selects Vertex on Application Default Credentials;
 * a JSON object with `vertexApiKey` is a Vertex express key; anything else is
 * a Gemini API key.
 */
export async function saveAntigravityCredential(
  homeDir: string,
  pasted: string,
): Promise<StoredAntigravityCredentials> {
  const value = pasted.trim();
  if (!value) throw new Error(ANTIGRAVITY_AUTH_SETUP_INSTRUCTIONS);
  let parsed: unknown;
  if (value.startsWith("{")) {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("The pasted value starts with { but is not valid JSON.");
    }
  }
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  let stored: StoredAntigravityCredentials;
  if (isRecord(parsed)) {
    if (parsed["type"] === "service_account") {
      const project = text(parsed["project_id"]);
      if (!project) throw new Error("The service-account key has no project_id.");
      const credentialsFile = path.join(homeDir, ANTIGRAVITY_SERVICE_ACCOUNT_FILENAME);
      await writeFile(credentialsFile, value, { mode: 0o600 });
      await chmod(credentialsFile, 0o600);
      stored = {
        kind: "vertex",
        project,
        location: text(parsed["location"]) ?? ANTIGRAVITY_DEFAULT_VERTEX_LOCATION,
        credentialsFile,
      };
    } else if (text(parsed["vertexApiKey"])) {
      stored = { kind: "vertex-express", apiKey: text(parsed["vertexApiKey"]) ?? "" };
    } else if (text(parsed["project"])) {
      const credentialsFile = text(parsed["credentialsFile"]);
      stored = {
        kind: "vertex",
        project: text(parsed["project"]) ?? "",
        location: text(parsed["location"]) ?? ANTIGRAVITY_DEFAULT_VERTEX_LOCATION,
        ...(credentialsFile ? { credentialsFile } : {}),
      };
    } else {
      throw new Error(ANTIGRAVITY_AUTH_SETUP_INSTRUCTIONS);
    }
  } else {
    stored = { kind: "gemini", apiKey: value };
  }
  const file = antigravityCredentialsPath(homeDir);
  await writeFile(file, JSON.stringify({ ...stored, savedAt: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
  await chmod(file, 0o600);
  return stored;
}

export async function clearAntigravityCredentials(homeDir: string): Promise<void> {
  await rm(antigravityCredentialsPath(homeDir), { force: true });
  await rm(path.join(homeDir, ANTIGRAVITY_SERVICE_ACCOUNT_FILENAME), { force: true });
}

export function describeAntigravityEndpoint(endpoint: AntigravityEndpoint): string {
  switch (endpoint.kind) {
    case "vertex":
      return `vertex:${endpoint.project}/${endpoint.location}${endpoint.credentialsFile ? " (service account)" : " (ADC)"}`;
    case "vertex-express":
      return "vertex (express API key)";
    case "gemini":
      return "gemini-api (API key)";
  }
}

/** The bridge's endpoint config plus the environment its harness needs. */
export function bridgeEndpoint(endpoint: AntigravityEndpoint): {
  config: Record<string, string>;
  env: Record<string, string>;
} {
  switch (endpoint.kind) {
    case "vertex":
      return {
        config: { kind: "vertex", project: endpoint.project, location: endpoint.location },
        env: {
          [GOOGLE_GENAI_USE_VERTEXAI_ENV]: "true",
          [GOOGLE_CLOUD_PROJECT_ENV]: endpoint.project,
          [GOOGLE_CLOUD_LOCATION_ENV]: endpoint.location,
          ...(endpoint.credentialsFile
            ? { [GOOGLE_APPLICATION_CREDENTIALS_ENV]: endpoint.credentialsFile }
            : {}),
        },
      };
    case "vertex-express":
      return { config: { kind: "vertex", apiKey: endpoint.apiKey }, env: {} };
    case "gemini":
      return { config: { kind: "gemini", apiKey: endpoint.apiKey }, env: {} };
  }
}
