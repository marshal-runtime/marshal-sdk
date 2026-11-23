export const CONNECTOR_MODES = ["mock", "fivetran"] as const;
export type ConnectorMode = (typeof CONNECTOR_MODES)[number];

export interface Flags {
  provisioningEnabled: boolean;
  connectorMode: ConnectorMode;
  /** Off switch of the Google Drive source: while false it has no tile, no routes and no OAuth start. */
  googleDriveEnabled: boolean;
  /**
   * Off switch of the monday.com source (a Fivetran connection of the owner's boards and tasks): while false it has no tile, its
   * routes answer 404 and the connection page never lists it. Only exactly "true" turns it on.
   */
  mondayEnabled: boolean;
  /**
   * Off switch of the Flashy source (a Fivetran Connector SDK connection of the brand's email and SMS campaign reports): while false it
   * has no tile, its routes answer 404 and the connections page never lists it. Only exactly "true" turns it on.
   */
  flashyEnabled: boolean;
  /**
   * Off switch of the PostHog source (a Fivetran connection of the brand's product-analytics events and people): while false it has no
   * tile, its routes answer 404 and the connections page never lists it. Only exactly "true" turns it on.
   */
  posthogEnabled: boolean;
  /**
   * POSTHOG_BRANDS: the only brands PostHog can be connected for (tile, guided step, connect routes), whatever the switch above says.
   * Nothing limits a PostHog key to one project yet, so the source opens brand by brand. Same shape and strictness as the Workspace list below.
   */
  posthogBrands: readonly string[];
  /**
   * Off switch of the Google Workspace connection (Gmail, Drive, Docs and Calendar for the brand): while false neither of its two
   * tiles ("read" and "act with approval") exists and their routes and the VM token broker answer 404.
   */
  googleWorkspaceEnabled: boolean;
  /**
   * GOOGLE_WORKSPACE_BRANDS: the only brands that may use Google Workspace (tiles, connect routes, VM token broker), whatever the switch above says.
   * Canonical lower-case brand UUIDs, comma separated. Empty (the default), or any malformed entry, means no brand: the switch alone opens nothing.
   */
  googleWorkspaceBrands: readonly string[];
  /**
   * Triple Whale through Marley's own OAuth app instead of a Fivetran card (docs/design/triple-whale-oauth.md). While false the
   * Fivetran card stays and the token broker answers 404. A connection that is already connected keeps its mode until disconnected.
   */
  tripleWhaleOauthEnabled: boolean;
  /**
   * Off switch of the signup greeting on the web side: while true the wizard shows the WhatsApp opt-in line, records the
   * opt-in and says Marley will message the owner in a moment. The agent server sends the greeting only with its own
   * SIGNUP_GREETING_TEMPLATE set, and only to an owner whose opt-in was recorded. Turn it on last, after the template is
   * approved and the gateway and agent server are ready (CONTRACTS.md, signup greeting rollout).
   */
  signupGreetingEnabled: boolean;
  /**
   * Off switch of the phone code (D51): while true the wizard's phone step sends a one-time code to the owner's number
   * by WhatsApp or iMessage (through the channel gateway) after the save, and asks for it before the last step. The signup
   * greeting goes only to a number verified this way, so turn this on before SIGNUP_GREETING_ENABLED.
   */
  phoneCodeEnabled: boolean;
}

export const SHARED_HOST_ID = "shared-1";

const BRAND_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A per-brand allow-list from an env value: canonical lower-case UUIDs, comma separated. Unset, empty or any malformed entry gives no brand (fail closed). */
export function parseBrandAllowList(value: string | undefined): readonly string[] {
  if (!value || !value.trim()) return [];
  const entries = value.split(",").map((entry) => entry.trim());
  return entries.every((entry) => BRAND_UUID.test(entry)) ? [...new Set(entries)] : [];
}

/** These flags as one brand sees them: Google Workspace and PostHog each exist for it only when the switch is on AND its brand id is on that source's allow-list. */
export function flagsForBrand(flags: Flags, brandId: string): Flags {
  const workspaceOff = flags.googleWorkspaceEnabled && !flags.googleWorkspaceBrands.includes(brandId);
  const posthogOff = flags.posthogEnabled && !flags.posthogBrands.includes(brandId);
  if (!workspaceOff && !posthogOff) return flags;
  return { ...flags, ...(workspaceOff ? { googleWorkspaceEnabled: false } : {}), ...(posthogOff ? { posthogEnabled: false } : {}) };
}

export function readFlags(env: Record<string, string | undefined> = process.env): Flags {
  const mode = env.CONNECTOR_MODE ?? "mock";
  if (!CONNECTOR_MODES.includes(mode as ConnectorMode)) {
    throw new Error(`CONNECTOR_MODE must be one of ${CONNECTOR_MODES.join(", ")}, got "${mode}"`);
  }
  return {
    provisioningEnabled: env.PROVISIONING_ENABLED === "true",
    connectorMode: mode as ConnectorMode,
    googleDriveEnabled: env.GOOGLE_DRIVE_ENABLED === "true",
    mondayEnabled: env.MONDAY_ENABLED === "true",
    flashyEnabled: env.FLASHY_ENABLED === "true",
    posthogEnabled: env.POSTHOG_ENABLED === "true",
    posthogBrands: parseBrandAllowList(env.POSTHOG_BRANDS),
    googleWorkspaceEnabled: env.GOOGLE_WORKSPACE_ENABLED === "true",
    googleWorkspaceBrands: parseBrandAllowList(env.GOOGLE_WORKSPACE_BRANDS),
    tripleWhaleOauthEnabled: env.TRIPLE_WHALE_OAUTH_ENABLED === "true",
    signupGreetingEnabled: env.SIGNUP_GREETING_ENABLED === "true",
    phoneCodeEnabled: env.PHONE_CODE_ENABLED === "true",
  };
}
