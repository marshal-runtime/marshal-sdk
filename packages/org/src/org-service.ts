import { EventEmitter } from "node:events";

import {
  OrgApiError,
  OrgClient,
  buildAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  fetchOrgDiscovery,
  oidcConfigurationUrl,
  parseOidcProviderMetadata,
  randomUrlSafe,
  refreshAccessToken,
  type FetchLike,
  type OidcProviderMetadata,
  type OrgDiscoveryDocument,
} from "@marshal/agent-runtime-org";

import type { OrgStatus } from "./contract/org-types";
import { createLogger } from "../host-deps";
import { normalizeOrgUrl } from "./common/org-url";
import {
  BROKER_TIMEOUT_MS,
  prepareBrokerRequest,
  readBrokerResponse,
  type OrgBrokerFetchInit,
  type OrgBrokerFetchResult,
  type OrgBrokerIdentity,
} from "./org-broker-fetch";
import { startOrgLoopback, type OrgLoopbackCallback } from "./org-loopback";
import type { OrgStoredSession, OrgTokenStore } from "./org-token-store";

const log = createLogger("Org");

const REFRESH_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DISCOVERY_BACKOFF_MS = 30_000;
const IDENTITY_RETRY_MS = 60_000;
const MAX_JSON_RESPONSE_CHARS = 2 * 1024 * 1024;
const MAX_RESPONSE_CHARS = 1024 * 1024;
const DEFAULT_SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface OrgFlags {
  /** `org.enabled` */
  enabled: boolean;
  /** `org.signIn` */
  signIn: boolean;
  /** `org.workspaces` */
  workspaces: boolean;
  /** `org.remoteSessions` */
  remoteSessions: boolean;
  /** `org.sessionSharing` */
  sessionSharing?: boolean;
  /** `org.mentions` */
  mentions?: boolean;
  /** `org.cloudMove` */
  cloudMove?: boolean;
  /** `org.sessionAudit` */
  sessionAudit?: boolean;
  /** `org.remoteMode` */
  remoteMode?: boolean;
  /** `org.cloudGroup` */
  cloudGroup?: boolean;
  /** `org.fork` */
  fork?: boolean;
  /** `org.placement` */
  placement?: boolean;
  /** `org.liveSessions` */
  liveSessions?: boolean;
  /** `org.onboarding` */
  onboarding?: boolean;
  /** `org.rooms` */
  rooms?: boolean;
}

export interface OrgServiceDeps {
  getFlags: () => OrgFlags;
  /** The effective organization URL; `managed` is true when an admin policy pins it. */
  getOrgUrl: () => { url?: string; managed: boolean };
  persistOrgUrl: (orgUrl: string) => void;
  tokenStore: OrgTokenStore;
  openExternal: (url: string) => void;
  fetch?: FetchLike;
  now?: () => number;
  signInTimeoutMs?: number;
  /** Bound for the token exchange, refresh and revoke requests. */
  requestTimeoutMs?: number;
  /** Identities trusted through "Trust local builds"; shown as a warning in Settings. */
  getLocallyTrustedExtensions?: () => string[];
}

export class OrgNotSignedInError extends Error {
  constructor() {
    super("not signed in to the organization");
    this.name = "OrgNotSignedInError";
  }
}

function errorCode(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; error?: unknown };
    if (typeof record.code === "string" && ERROR_CODE_PATTERN.test(record.code)) return record.code;
    if (typeof record.error === "string" && ERROR_CODE_PATTERN.test(record.error)) {
      return `token-${record.error}`;
    }
  }
  return fallback;
}

function statusOf(error: unknown): number | undefined {
  const status =
    typeof error === "object" && error !== null
      ? (error as { status?: unknown }).status
      : undefined;
  return typeof status === "number" ? status : undefined;
}

/**
 * Organization sign-in for the desktop: discovery, OIDC authorization code + PKCE through the system
 * browser and a loopback redirect, encrypted token storage, refresh, revocation and `whoami`.
 * With the flags off every public method returns the disabled status without any network or disk I/O.
 */
export class OrgService extends EventEmitter {
  private loading: Promise<void> | null = null;
  private session: OrgStoredSession | null = null;
  private identity: { displayName: string; email: string } | undefined;
  private identityFetch: Promise<void> | null = null;
  private identityFetchFailedAt: number | undefined;
  private orgDisplayName: string | undefined;
  private features: string[] = [];
  private discovery: { orgUrl: string; value: OrgDiscoveryDocument } | null = null;
  private discoveryInFlight: { orgUrl: string; promise: Promise<OrgDiscoveryDocument> } | null =
    null;
  private discoveryGeneration = 0;
  private discoveryFailure: { orgUrl: string; at: number; error: unknown } | null = null;
  private metadata: { issuer: string; value: OidcProviderMetadata } | null = null;
  private signingIn = false;
  private activeLoopback: OrgLoopbackCallback | null = null;
  private refreshing: Promise<void> | null = null;
  private lastError: string | undefined;

  constructor(private readonly deps: OrgServiceDeps) {
    super();
  }

  private get fetchImpl(): FetchLike {
    return this.deps.fetch ?? fetch;
  }

  /** Token-endpoint calls must never hang sign-in, refresh or sign-out on an unresponsive provider. */
  private readonly timedFetch: FetchLike = (input, init) =>
    this.fetchImpl(input, {
      ...init,
      signal: AbortSignal.timeout(this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
    });

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private isActive(): boolean {
    const flags = this.deps.getFlags();
    return flags.enabled && flags.signIn;
  }

  /**
   * The signed-in session, or null. A session belongs to the organization URL it was issued for:
   * when the effective URL no longer matches (policy refresh, settings replaced, a Save URL racing a
   * sign-in) the session is dropped so its tokens are never sent to a different organization.
   */
  private currentSession(): OrgStoredSession | null {
    const session = this.session;
    if (!session) return null;
    if (session.orgUrl === this.deps.getOrgUrl().url) return session;
    this.session = null;
    this.identity = undefined;
    void this.deps.tokenStore.clear().catch(() => undefined);
    this.emit("changed");
    return null;
  }

  /** The organization id of the current session, or undefined when signed out (or the session predates org ids). */
  signedInOrgId(): string | undefined {
    return this.currentSession()?.orgId;
  }

  /** Call when settings or the admin policy change: drops a session for another org and refreshes the UI. */
  onConfigChanged(): void {
    if (!this.isActive()) this.activeLoopback?.close();
    else this.currentSession();
    this.emit("changed");
  }

  async getStatus(): Promise<OrgStatus> {
    if (!this.isActive()) return this.disabledStatus();
    await this.ensureLoaded();
    const session = this.currentSession();
    // Saved tokens restore the session without discovery, so the feature list is fetched here:
    // a status that says signed-in with no features would be read as "the org offers nothing".
    let discoveryFailed = false;
    if (session && this.discovery?.orgUrl !== session.orgUrl) {
      try {
        await this.ensureDiscovery(session.orgUrl, { respectBackoff: true });
      } catch {
        discoveryFailed = true;
      }
    }
    // The person is kept in memory only, so a session restored from saved tokens has none until whoami runs.
    if (session && !this.identity && this.discovery?.orgUrl === session.orgUrl) {
      this.fetchIdentityInBackground();
    }
    const status = this.buildStatus();
    if (discoveryFailed) status.discoveryFailed = true;
    return status;
  }

  private fetchIdentityInBackground(): void {
    if (this.identityFetch) return;
    const failedAt = this.identityFetchFailedAt;
    if (failedAt !== undefined && this.now() - failedAt < IDENTITY_RETRY_MS) return;
    this.identityFetch = this.whoami()
      .then(() => {
        this.identityFetchFailedAt = this.identity ? undefined : this.now();
      })
      .catch(() => {
        this.identityFetchFailedAt = this.now();
      })
      .finally(() => {
        this.identityFetch = null;
      });
  }

  async setOrgUrl(input: string): Promise<OrgStatus> {
    if (!this.isActive()) return this.disabledStatus();
    const current = this.deps.getOrgUrl();
    if (current.managed) return { ...(await this.getStatus()), success: false, error: "managed" };
    const normalized = normalizeOrgUrl(input);
    if (!normalized) return { ...(await this.getStatus()), success: false, error: "invalid-url" };
    if (normalized !== current.url) {
      await this.signOut();
      this.deps.persistOrgUrl(normalized);
      this.discovery = null;
      this.discoveryInFlight = null;
      this.discoveryFailure = null;
      this.discoveryGeneration += 1;
      this.metadata = null;
      this.lastError = undefined;
      this.emit("changed");
    }
    return this.getStatus();
  }

  async signIn(): Promise<OrgStatus> {
    if (!this.isActive()) return this.disabledStatus();
    if (this.signingIn) return this.buildStatus();
    this.signingIn = true;
    this.lastError = undefined;
    this.emit("changed");
    try {
      await this.runSignIn();
    } catch (error) {
      const code = errorCode(error, "sign-in-failed");
      this.lastError = code === "closed" ? undefined : code;
      if (this.lastError) log.warn(`Organization sign-in failed: ${this.lastError}`);
    } finally {
      this.signingIn = false;
      this.activeLoopback = null;
      this.emit("changed");
    }
    return this.buildStatus();
  }

  async signOut(): Promise<OrgStatus> {
    if (!this.isActive()) return this.disabledStatus();
    this.activeLoopback?.close();
    await this.ensureLoaded();
    const session = this.session;
    if (session) {
      await this.dropSession();
      this.emit("changed");
      await this.revoke(session).catch(() => undefined);
    }
    this.lastError = undefined;
    this.emit("changed");
    return this.buildStatus();
  }

  async whoami(): Promise<OrgStatus> {
    if (!this.isActive()) return this.disabledStatus();
    await this.ensureLoaded();
    if (this.currentSession()) {
      try {
        const client = await this.getClient();
        if (client) {
          const identity = await client.whoami();
          this.identity = { displayName: identity.displayName, email: identity.email };
          this.lastError = undefined;
        }
      } catch (error) {
        await this.handleApiFailure(error);
      }
      this.emit("changed");
    }
    return this.buildStatus();
  }

  /** A client for the signed-in organization, or null when signed out. */
  async getClient(): Promise<OrgClient | null> {
    if (!this.isActive()) return null;
    await this.ensureLoaded();
    const session = this.currentSession();
    if (!session) return null;
    const discovery = await this.ensureDiscovery(session.orgUrl);
    return new OrgClient({
      discovery,
      accessToken: () => this.getAccessToken(),
      fetch: this.fetchImpl,
    });
  }

  /**
   * One JSON request to a route of the organization API that the client package does not wrap yet
   * (the Slack destination list and a cloud run's `slackDestination`). Failures are `OrgApiError`s
   * with the server's short error code, like the package's own calls.
   */
  async requestJson(
    method: "GET" | "POST" | "PUT",
    route: string,
    body?: unknown,
  ): Promise<unknown> {
    const client = await this.getClient();
    if (!client) throw new OrgNotSignedInError();
    const token = await this.getAccessToken();
    const url = `${client.discovery.apiBase.replace(/\/+$/, "")}${route}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch {
      throw new OrgApiError(
        0,
        controller.signal.aborted ? "timeout" : "unreachable",
        "request failed",
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (text.length > MAX_JSON_RESPONSE_CHARS) {
      throw new OrgApiError(response.status, "response-too-large", "response exceeds 2 MiB");
    }
    let parsed: unknown;
    try {
      parsed = text.length ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      throw new OrgApiError(response.status, "invalid-json", "response is not JSON");
    }
    if (!response.ok) {
      const serverCode =
        typeof parsed === "object" && parsed !== null && "error" in parsed
          ? parsed.error
          : undefined;
      const code =
        typeof serverCode === "string" ? serverCode.slice(0, 64) : `http-${response.status}`;
      const serverField =
        typeof parsed === "object" && parsed !== null && "field" in parsed
          ? parsed.field
          : undefined;
      // The field name (short, a request property) lets a caller tell which input was refused.
      const detail = typeof serverField === "string" ? ` (field ${serverField.slice(0, 64)})` : "";
      throw new OrgApiError(
        response.status,
        code,
        `organization API answered ${response.status}${detail}`,
      );
    }
    return parsed;
  }

  /**
   * Authenticated binary upload to a route of the organization API (a published extension archive).
   * The answer is parsed like `requestJson`; the body is sent as is with the given headers.
   */
  async uploadBytes(
    route: string,
    headers: Record<string, string>,
    bytes: Uint8Array,
  ): Promise<unknown> {
    const client = await this.getClient();
    if (!client) throw new OrgNotSignedInError();
    const token = await this.getAccessToken();
    const url = `${client.discovery.apiBase.replace(/\/+$/, "")}${route}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5 * 60_000);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          ...headers,
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/gzip",
          "content-length": String(bytes.byteLength),
        },
        body: new Blob([new Uint8Array(bytes)]),
        signal: controller.signal,
      });
    } catch {
      throw new OrgApiError(
        0,
        controller.signal.aborted ? "timeout" : "unreachable",
        "upload failed",
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      throw new OrgApiError(response.status, "invalid-json", "response is not JSON");
    }
    if (!response.ok) {
      const serverCode =
        typeof parsed === "object" && parsed !== null && "error" in parsed
          ? parsed.error
          : undefined;
      throw new OrgApiError(
        response.status,
        typeof serverCode === "string" ? serverCode.slice(0, 64) : `http-${response.status}`,
        `organization API answered ${response.status}`,
      );
    }
    return parsed;
  }

  /** What onboarding needs to know about the signed-in org; undefined when signed out. */
  async onboardingContext(): Promise<
    | {
        orgId?: string;
        orgUrl: string;
        orgName?: string;
        features: string[];
        apiBase: string;
      }
    | undefined
  > {
    const client = await this.getClient();
    const session = this.currentSession();
    if (!client || !session) return undefined;
    return {
      ...(session.orgId ? { orgId: session.orgId } : {}),
      orgUrl: session.orgUrl,
      ...(this.orgDisplayName ? { orgName: this.orgDisplayName } : {}),
      features: [...this.features],
      apiBase: client.discovery.apiBase,
    };
  }

  /**
   * Authenticated binary download from the org API (extension archives). The URL must be on the
   * API's origin so the token never goes elsewhere, and the body is capped at `maxBytes`.
   */
  async requestBytes(url: string, maxBytes: number): Promise<Uint8Array> {
    const client = await this.getClient();
    if (!client) throw new OrgNotSignedInError();
    if (new URL(url).origin !== new URL(client.discovery.apiBase).origin) {
      throw new OrgApiError(0, "foreign-origin", "download is not on the organization API");
    }
    const token = await this.getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5 * 60_000);
    try {
      const response = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new OrgApiError(response.status, "download-failed", "download failed");
      }
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxBytes) {
        throw new OrgApiError(
          response.status,
          "response-too-large",
          "archive is larger than announced",
        );
      }
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength > maxBytes) {
        throw new OrgApiError(
          response.status,
          "response-too-large",
          "archive is larger than announced",
        );
      }
      return body;
    } catch (error) {
      if (error instanceof OrgApiError) throw error;
      throw new OrgApiError(
        0,
        controller.signal.aborted ? "timeout" : "unreachable",
        "download failed",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async getAccessToken(): Promise<string> {
    await this.ensureLoaded();
    const session = this.currentSession();
    if (!session) throw new OrgNotSignedInError();
    const { expiresAt } = session.tokens;
    if (expiresAt !== undefined && expiresAt - this.now() < REFRESH_SKEW_MS) {
      await this.refresh();
    }
    const fresh = this.currentSession();
    if (!fresh) throw new OrgNotSignedInError();
    return fresh.tokens.accessToken;
  }

  /** The signed-in person for extensions; carries no credential. Undefined when signed out or unreachable. */
  async getBrokerIdentity(): Promise<OrgBrokerIdentity | undefined> {
    if (!this.isActive()) return undefined;
    try {
      await this.ensureLoaded();
      const session = this.currentSession();
      if (!session) return undefined;
      const discovery = await this.ensureDiscovery(session.orgUrl);
      if (!this.identity) await this.whoami();
      const email = this.identity?.email.trim().toLowerCase();
      if (!email) return undefined;
      return {
        email,
        orgId: session.orgId ?? discovery.orgId,
        orgDisplayName: this.orgDisplayName ?? "",
      };
    } catch {
      return undefined;
    }
  }

  /**
   * One read request to `{apiBase}/v1/broker/...` made here with a fresh bearer, so extensions never
   * hold the token. Paths outside the broker prefix, other origins, oversized bodies and slow
   * answers are refused with `OrgApiError`s carrying a short code.
   */
  async brokerFetch(path: string, init: OrgBrokerFetchInit = {}): Promise<OrgBrokerFetchResult> {
    if (!this.isActive()) throw new OrgNotSignedInError();
    await this.ensureLoaded();
    const session = this.currentSession();
    if (!session) throw new OrgNotSignedInError();
    const discovery = await this.ensureDiscovery(session.orgUrl);
    const { url, request } = prepareBrokerRequest(discovery.apiBase, path, init);
    const token = await this.getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BROKER_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        ...request,
        headers: { ...request.headers, authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: controller.signal,
      });
      return await readBrokerResponse(response);
    } catch (error) {
      if (error instanceof OrgApiError) throw error;
      throw new OrgApiError(
        0,
        controller.signal.aborted ? "timeout" : "unreachable",
        "broker request failed",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Where the organization's rooms service answers, when `org.rooms` is on and the signed-in
   * organization serves `rooms`; undefined otherwise (no network call while the flag is off).
   */
  async getRoomsEndpoint(): Promise<
    { orgId: string; apiBase: string; socketUrl: string } | undefined
  > {
    if (!this.isActive() || this.deps.getFlags().rooms !== true) return undefined;
    await this.ensureLoaded();
    const session = this.currentSession();
    if (!session) return undefined;
    const discovery = await this.ensureDiscovery(session.orgUrl, { respectBackoff: true });
    if (!discovery.features.includes("rooms") || !discovery.rooms) return undefined;
    return { orgId: session.orgId ?? discovery.orgId, ...discovery.rooms };
  }

  private disabledStatus(): OrgStatus {
    return {
      success: true,
      state: "disabled",
      enabled: false,
      workspacesEnabled: false,
      remoteSessionsEnabled: false,
      orgUrlManaged: false,
      features: [],
    };
  }

  private buildStatus(): OrgStatus {
    const { url, managed } = this.deps.getOrgUrl();
    const flags = this.deps.getFlags();
    const signedIn = this.session !== null && this.session.orgUrl === url;
    const status: OrgStatus = {
      success: true,
      state: this.signingIn ? "signing-in" : signedIn ? "signed-in" : "signed-out",
      enabled: true,
      workspacesEnabled: flags.workspaces,
      remoteSessionsEnabled: flags.remoteSessions,
      sessionSharingEnabled: flags.sessionSharing === true,
      mentionsEnabled: flags.mentions === true,
      cloudMoveEnabled: flags.cloudMove === true,
      sessionAuditEnabled: flags.sessionAudit === true,
      remoteModeEnabled: flags.remoteMode === true,
      cloudGroupEnabled: flags.cloudGroup === true,
      forkEnabled: flags.fork === true,
      onboardingEnabled: flags.onboarding === true,
      placementEnabled: flags.placement === true,
      liveSessionsEnabled: flags.liveSessions === true,
      roomsEnabled: flags.rooms === true,
      orgUrlManaged: managed,
      features: signedIn ? [...this.features] : [],
    };
    if (signedIn && this.discovery?.orgUrl === url) status.featuresKnown = true;
    if (url) status.orgUrl = url;
    if (signedIn && this.orgDisplayName) status.orgDisplayName = this.orgDisplayName;
    if (signedIn && this.identity) status.identity = this.identity;
    const locallyTrusted = this.deps.getLocallyTrustedExtensions?.() ?? [];
    if (locallyTrusted.length > 0) status.locallyTrustedExtensions = locallyTrusted;
    if (this.lastError) status.lastError = this.lastError;
    return status;
  }

  private ensureLoaded(): Promise<void> {
    // A failed load must not stick: caching it left the app signed out with no requests until restart.
    this.loading ??= this.load().catch((error: unknown) => {
      this.loading = null;
      throw error;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    const stored = await this.deps.tokenStore.load();
    // Marshal used to ship pointing at one organization. A person signed in through that default,
    // with no URL saved in settings, keeps the organization they signed in to instead of losing it.
    if (stored && !this.deps.getOrgUrl().url) this.deps.persistOrgUrl(stored.orgUrl);
    if (stored && stored.orgUrl === this.deps.getOrgUrl().url) this.session = stored;
    else if (stored) await this.deps.tokenStore.clear();
  }

  /**
   * One fetch is shared by concurrent callers. After a failure, status reads (`respectBackoff`) do
   * not retry for `DISCOVERY_BACKOFF_MS`; sign-in and API calls always try again.
   */
  private ensureDiscovery(
    orgUrl: string,
    options: { respectBackoff?: boolean } = {},
  ): Promise<OrgDiscoveryDocument> {
    if (this.discovery?.orgUrl === orgUrl) return Promise.resolve(this.discovery.value);
    if (this.discoveryInFlight?.orgUrl === orgUrl) return this.discoveryInFlight.promise;
    const failure = this.discoveryFailure;
    if (
      options.respectBackoff &&
      failure?.orgUrl === orgUrl &&
      this.now() - failure.at < DISCOVERY_BACKOFF_MS
    ) {
      return Promise.reject(failure.error);
    }
    const promise = this.loadDiscovery(orgUrl).finally(() => {
      if (this.discoveryInFlight?.promise === promise) this.discoveryInFlight = null;
    });
    this.discoveryInFlight = { orgUrl, promise };
    return promise;
  }

  private async loadDiscovery(orgUrl: string): Promise<OrgDiscoveryDocument> {
    const generation = this.discoveryGeneration;
    let value: OrgDiscoveryDocument;
    try {
      value = await fetchOrgDiscovery(orgUrl, {
        fetch: this.fetchImpl,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      if (generation === this.discoveryGeneration) {
        this.discoveryFailure = { orgUrl, at: this.now(), error };
      }
      throw error;
    }
    // The organization URL changed while this fetch ran: its answer belongs to the old org.
    if (generation !== this.discoveryGeneration) return value;
    const before = this.discoveryKey();
    this.discoveryFailure = null;
    this.discovery = { orgUrl, value };
    if (orgUrl === this.deps.getOrgUrl().url) {
      this.orgDisplayName = value.displayName;
      this.features = [...value.features];
    }
    // Only a real change (features, or discovery becoming known) tells the renderer to re-read
    // the status, so a status that said discoveryFailed clears without a refresh loop.
    if (this.discoveryKey() !== before) this.emit("changed");
    return value;
  }

  private discoveryKey(): string {
    return `${this.discovery?.orgUrl ?? ""}|${this.features.join(",")}`;
  }

  private async ensureMetadata(issuer: string): Promise<OidcProviderMetadata> {
    if (this.metadata?.issuer === issuer) return this.metadata.value;
    const body = await this.getJson(oidcConfigurationUrl(issuer));
    const value = parseOidcProviderMetadata(body, issuer);
    this.metadata = { issuer, value };
    return value;
  }

  private async getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok)
        throw Object.assign(new Error("oidc-metadata"), { code: `http-${response.status}` });
      const text = await response.text();
      if (text.length > MAX_RESPONSE_CHARS)
        throw Object.assign(new Error("too large"), { code: "response-too-large" });
      return JSON.parse(text) as unknown; // SF-4: unknown; parsed by parseOidcProviderMetadata
    } finally {
      clearTimeout(timer);
    }
  }

  private async runSignIn(): Promise<void> {
    const orgUrl = this.deps.getOrgUrl().url;
    if (!orgUrl) throw Object.assign(new Error("no org url"), { code: "no-org-url" });

    const discovery = await this.ensureDiscovery(orgUrl);
    if (!discovery.features.includes("signIn")) {
      throw Object.assign(new Error("sign-in unsupported"), { code: "sign-in-unsupported" });
    }
    const metadata = await this.ensureMetadata(discovery.oidc.issuer);

    const state = randomUrlSafe(24);
    const pkce = await createPkcePair();
    const loopback = await startOrgLoopback({
      expectedState: state,
      timeoutMs: this.deps.signInTimeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS,
    });
    this.activeLoopback = loopback;
    try {
      this.deps.openExternal(
        buildAuthorizationUrl({
          authorizationEndpoint: metadata.authorizationEndpoint,
          clientId: discovery.oidc.clientId,
          redirectUri: loopback.redirectUri,
          scopes: discovery.oidc.scopes,
          state,
          codeChallenge: pkce.challenge,
        }),
      );
      const code = await loopback.result;
      const tokens = await exchangeAuthorizationCode(
        {
          tokenEndpoint: metadata.tokenEndpoint,
          clientId: discovery.oidc.clientId,
          code,
          redirectUri: loopback.redirectUri,
          codeVerifier: pkce.verifier,
        },
        this.timedFetch,
      );
      if (this.deps.getOrgUrl().url !== orgUrl) {
        throw Object.assign(new Error("org url changed"), { code: "org-url-changed" });
      }
      this.identity = undefined;
      await this.setSession({ orgUrl, orgId: discovery.orgId, tokens });
    } finally {
      loopback.close();
    }
    try {
      const client = await this.getClient();
      if (client) {
        const identity = await client.whoami();
        this.identity = { displayName: identity.displayName, email: identity.email };
      }
    } catch (error) {
      this.lastError = errorCode(error, "whoami-failed");
    }
  }

  private async setSession(session: OrgStoredSession): Promise<void> {
    this.session = session;
    await this.deps.tokenStore.save(session);
  }

  private async dropSession(): Promise<void> {
    this.session = null;
    this.identity = undefined;
    await this.deps.tokenStore.clear();
  }

  private refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const session = this.currentSession();
    if (!session) throw new OrgNotSignedInError();
    if (!session.tokens.refreshToken) {
      await this.dropSession();
      this.emit("changed");
      throw new OrgNotSignedInError();
    }
    try {
      const discovery = await this.ensureDiscovery(session.orgUrl);
      const metadata = await this.ensureMetadata(discovery.oidc.issuer);
      const tokens = await refreshAccessToken(
        {
          tokenEndpoint: metadata.tokenEndpoint,
          clientId: discovery.oidc.clientId,
          refreshToken: session.tokens.refreshToken,
        },
        this.timedFetch,
      );
      if (this.session !== session || this.deps.getOrgUrl().url !== session.orgUrl) return;
      await this.setSession({
        orgUrl: session.orgUrl,
        ...(session.orgId ? { orgId: session.orgId } : {}),
        tokens,
      });
    } catch (error) {
      const status = statusOf(error);
      if (status === 400 || status === 401) {
        if (this.session === session) await this.dropSession();
        this.lastError = "session-expired";
        this.emit("changed");
        throw new OrgNotSignedInError();
      }
      throw error;
    }
  }

  private async handleApiFailure(error: unknown): Promise<void> {
    if (error instanceof OrgNotSignedInError) return;
    if (statusOf(error) === 401) {
      await this.dropSession();
      this.lastError = "session-expired";
      return;
    }
    this.lastError = errorCode(error, "request-failed");
  }

  private async revoke(session: OrgStoredSession): Promise<void> {
    const discovery = await this.ensureDiscovery(session.orgUrl);
    const metadata = await this.ensureMetadata(discovery.oidc.issuer);
    if (!metadata.revocationEndpoint) return;
    const token = session.tokens.refreshToken ?? session.tokens.accessToken;
    const form = new URLSearchParams({
      token,
      token_type_hint: session.tokens.refreshToken ? "refresh_token" : "access_token",
      client_id: discovery.oidc.clientId,
    });
    await this.timedFetch(metadata.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  }
}
