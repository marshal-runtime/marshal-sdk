/** Contract C7: the developer tools an org names in its onboarding manifest, plus the install IPC shapes. */

export const DEV_TOOL_IDS = ["gcloud", "coder", "gh", "docker"] as const;
export type DevToolId = (typeof DEV_TOOL_IDS)[number];

/** The org only names which tool; it never carries commands or URLs. */
export interface OrgOnboardingTool {
  id: DevToolId;
  required: boolean;
  why: string;
  /**
   * Coder only: SHA-256 of the CLI build per CPU. The manifest arrives over HTTPS, so a pin makes
   * a plain-HTTP Coder server safe to download from. It only narrows what is allowed.
   */
  sha256?: { arm64?: string; amd64?: string };
}

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_TOOLS = DEV_TOOL_IDS.length;

function isDevToolId(value: unknown): value is DevToolId {
  return DEV_TOOL_IDS.some((id) => id === value);
}

function parseSha256Pins(value: unknown): OrgOnboardingTool["sha256"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pins: NonNullable<OrgOnboardingTool["sha256"]> = {};
  for (const arch of ["arm64", "amd64"] as const) {
    const pin: unknown = Reflect.get(value, arch);
    if (typeof pin === "string" && SHA256.test(pin.toLowerCase())) pins[arch] = pin.toLowerCase();
  }
  return pins.arm64 || pins.amd64 ? pins : undefined;
}

/** Narrow parse of the manifest's `tools` field; anything unknown is dropped. */
export function parseOrgOnboardingTools(value: unknown): OrgOnboardingTool[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<DevToolId>();
  const tools: OrgOnboardingTool[] = [];
  for (const entry of value.slice(0, MAX_TOOLS * 2)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const id: unknown = Reflect.get(entry, "id");
    const why: unknown = Reflect.get(entry, "why");
    const required: unknown = Reflect.get(entry, "required");
    if (!isDevToolId(id) || seen.has(id)) continue;
    if (typeof why !== "string" || !why.trim() || why.length > 300) continue;
    seen.add(id);
    const sha256 = id === "coder" ? parseSha256Pins(Reflect.get(entry, "sha256")) : undefined;
    tools.push({ id, required: required === true, why, ...(sha256 ? { sha256 } : {}) });
  }
  return tools;
}

export interface DevToolDetection {
  id: DevToolId;
  installed: boolean;
  version?: string;
  /** Where the executable was found. */
  path?: string;
}

/** What an install would do, shown to the user before they confirm. */
export interface DevToolInstallPlan {
  id: DevToolId;
  title: string;
  version?: string;
  /** Host the installer downloads from. */
  source: string;
  /** How the download is checked. */
  verification: string;
  /** Where it ends up. */
  destination: string;
  /** Plain-language caveat, e.g. an unencrypted connection. */
  warning?: string;
  /** Windows and unsupported platforms: what to install by hand. */
  manual?: string;
}

export type DevToolsDetectResult =
  | { success: true; platform: string; tools: DevToolDetection[] }
  | { success: false; error: string };

export type DevToolsPlanResult =
  | { success: true; plan: DevToolInstallPlan; token: string }
  | { success: false; error: string };

export type DevToolsInstallResult =
  | { success: true; detection: DevToolDetection; note?: string }
  | { success: false; error: string };
