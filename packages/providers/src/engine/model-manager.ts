/**
 * ModelManager — model listing, policy checks, and default/session model persistence.
 *
 * Extracted from SessionManager (Tier 2 of the SessionManager decomposition).
 * All state access goes through the injected deps, keeping
 * ModelManager decoupled from session orchestration.
 */

import { APP_AGENT_DEFAULTS, normalizeModelIdForMatch } from "../common/agent-defaults";
import type { ContextTier, ModelInfo, ReasoningEffort } from "../../host/engine-host-types";
import { createLogger } from "../common/marshal-logger";
import { parseOrgAgentDefaults } from "../common/org-onboarding-agent-defaults";
import { parseRuntimeQualifiedModel } from "../common/runtime-qualified-model";
import type { TierModelDefaults } from "../backend/types";
import type { ISessionStore } from "../../host/engine-host-types";

const log = createLogger("ModelManager");

const FEATURED_MODEL_IDS = new Set([
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.5",
  "claude-opus-4.6",
  "claude-opus-4.7",
  "claude-sonnet-4.6",
  "gpt-5.4",
  "gemini-3-pro-preview",
]);

/** Last-resort fallback when no default is stored, the stored default isn't
 *  available on the active backend, AND the backend itself can't suggest
 *  one (cache empty before first listModels). The id may not exist on the
 *  active backend — that's accepted: a stale fallback is better than empty
 *  string, and the next session-create will fall through to backend's own
 *  default-picking. */
export const DEFAULT_MODEL = APP_AGENT_DEFAULTS.main.model;

export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const REASONING_EFFORT_SET = new Set<string>(REASONING_EFFORTS);
export const CONTEXT_TIERS = ["default", "long_context"] as const;
const CONTEXT_TIER_SET = new Set<string>(CONTEXT_TIERS);

/** Tier whose default model + reasoning effort applies to a session.
 *  `chat` keeps the legacy `defaultModel` + per-model `defaultReasoningEfforts`
 *  map; `subagent` / `workflow` use the `TierModelDefaults` records. */
export type SessionTier = "chat" | "subagent" | "workflow";

/** Automatic reasoning effort for the default model. Other models retain the
 *  previous High preference when they support it. */
export const SYSTEM_DEFAULT_REASONING_EFFORT: ReasoningEffort = "max";
const FALLBACK_REASONING_EFFORT: ReasoningEffort = "high";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK model objects are untyped
type AnyModel = any;

export interface ModelManagerDeps {
  store: Pick<ISessionStore, "loadIndex" | "withIndexLock" | "loadSessionData" | "saveSessionData">;
  listModelsFromBackend: () => Promise<AnyModel[]>;
  getCachedModelsFromBackend: () => AnyModel[] | null;
  /** This backend's natural default — polymorphic via IToolBackend.getDefaultModel.
   *  Returns undefined while the model cache is unpopulated; ModelManager
   *  falls back to its hardcoded DEFAULT_MODEL in that case. */
  getBackendDefaultModel: () => string | undefined;
  getTenantPolicy: () => { disabledModels?: string[] } | undefined;
  /** Whether the active runtime holds credentials. Absent or `undefined` = not known yet, treated as signed in. */
  isActiveRuntimeAuthenticated?: () => boolean | undefined;
  /** Cached, runtime-qualified models of other signed-in runtimes. */
  getPeerModels?: () => ModelInfo[];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORT_SET.has(value);
}

function isContextTier(value: unknown): value is ContextTier {
  return typeof value === "string" && CONTEXT_TIER_SET.has(value);
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isObjectRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

type ContextCapabilities = Pick<ModelInfo, "supportedContextTiers" | "contextWindowTokens">;

function normalizeContextCapabilities(
  rawModel: Record<string, unknown>,
): Partial<ContextCapabilities> {
  const capabilities = isObjectRecord(rawModel.capabilities) ? rawModel.capabilities : undefined;
  const limits =
    capabilities && isObjectRecord(capabilities.limits) ? capabilities.limits : undefined;
  const billing = isObjectRecord(rawModel.billing) ? rawModel.billing : undefined;
  const tokenPrices =
    billing && isObjectRecord(billing.tokenPrices) ? billing.tokenPrices : undefined;
  const longContext =
    tokenPrices && isObjectRecord(tokenPrices.longContext) ? tokenPrices.longContext : undefined;

  const defaultTokens =
    numberField(tokenPrices, "contextMax") ?? numberField(tokenPrices, "maxPromptTokens");
  const longContextPromptTokens =
    numberField(longContext, "contextMax") ?? numberField(longContext, "maxPromptTokens");
  const longContextTokens =
    numberField(limits, "max_context_window_tokens") ?? longContextPromptTokens;
  const declared = Array.isArray(rawModel.supportedContextTiers)
    ? rawModel.supportedContextTiers.filter(isContextTier)
    : [];
  if (
    declared.length === 0 &&
    defaultTokens === undefined &&
    longContextPromptTokens === undefined &&
    longContextTokens === undefined
  ) {
    return {};
  }
  const supportsLongContext =
    declared.includes("long_context") || longContextPromptTokens !== undefined;
  const supportedContextTiers: ContextTier[] = supportsLongContext
    ? ["default", "long_context"]
    : ["default"];
  const contextWindowTokens =
    defaultTokens !== undefined || longContextTokens !== undefined
      ? {
          ...(defaultTokens !== undefined ? { default: defaultTokens } : {}),
          ...(longContextTokens !== undefined ? { long_context: longContextTokens } : {}),
        }
      : undefined;

  return {
    supportedContextTiers,
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
  };
}

export function normalizeDiscoveredModels(models: AnyModel[]): ModelInfo[] {
  return models
    .map((rawModel) => {
      if (!isObjectRecord(rawModel)) return null;

      const id = typeof rawModel.id === "string" && rawModel.id.length > 0 ? rawModel.id : "";
      if (!id) return null;

      const name =
        typeof rawModel.name === "string" && rawModel.name.length > 0 ? rawModel.name : id;

      const normalized: ModelInfo = {
        ...rawModel,
        id,
        name,
        featured: FEATURED_MODEL_IDS.has(id.toLowerCase()),
        ...normalizeContextCapabilities(rawModel),
      };
      return normalized;
    })
    .filter((model): model is ModelInfo => model !== null);
}

export class ModelManager {
  constructor(private deps: ModelManagerDeps) {}

  async listModels(): Promise<ModelInfo[]> {
    return normalizeDiscoveredModels(await this.deps.listModelsFromBackend());
  }

  /** Check if a specific model ID is blocked by tenant policy. */
  isModelDisabled(modelId: string): boolean {
    const policy = this.deps.getTenantPolicy();
    const disabled = policy?.disabledModels;
    if (!disabled?.length) return false;
    const blocklist = new Set(disabled.map((m) => m.toLowerCase()));
    return blocklist.has((parseRuntimeQualifiedModel(modelId)?.model ?? modelId).toLowerCase());
  }

  /** Tri-state — `"unknown"` while the lazy listModels cache is still empty,
   *  so callers can distinguish "not yet known" from "definitely not in the
   *  cache". */
  private availabilityOnBackend(id: string): "yes" | "no" | "unknown" {
    const cached = normalizeDiscoveredModels(this.deps.getCachedModelsFromBackend() ?? []);
    if (cached.length === 0) return "unknown";
    const target = id.toLowerCase();
    return cached.some((m) => m.id.toLowerCase() === target) ? "yes" : "no";
  }

  isModelAvailable(modelId: string): boolean {
    return !this.isModelDisabled(modelId) && this.availabilityOnBackend(modelId) === "yes";
  }

  private getCachedModel(id: string): ModelInfo | null {
    const cached = normalizeDiscoveredModels(this.deps.getCachedModelsFromBackend() ?? []);
    if (cached.length === 0) return null;
    const target = id.toLowerCase();
    return cached.find((m) => m.id.toLowerCase() === target) ?? null;
  }

  private getSupportedReasoningEfforts(model: ModelInfo): ReasoningEffort[] {
    const declared = model.supportedReasoningEfforts?.filter(isReasoningEffort) ?? [];
    if (declared.length > 0) return declared;

    const supports = model.capabilities?.supports;
    if (supports?.reasoningEffort === true) return [...REASONING_EFFORTS];

    return [];
  }

  private getSupportedContextTiers(model: ModelInfo): ContextTier[] {
    const declared = model.supportedContextTiers?.filter(isContextTier) ?? [];
    return declared.length > 0 ? declared : ["default"];
  }

  private activeRuntimeSignedOut(): boolean {
    return this.deps.isActiveRuntimeAuthenticated?.() === false;
  }

  private peerModels(): ModelInfo[] {
    return this.deps.getPeerModels?.() ?? [];
  }

  /** The app-default model for a slot, but only where it can run now: on the active runtime
   *  when it holds credentials, else on a signed-in peer runtime. */
  private findAppDefaultModel(slot: "main" | "subagents"): string | undefined {
    const wanted = normalizeModelIdForMatch(APP_AGENT_DEFAULTS[slot].model);
    if (!this.activeRuntimeSignedOut()) {
      const cached = normalizeDiscoveredModels(this.deps.getCachedModelsFromBackend() ?? []);
      const own = cached.find((m) => normalizeModelIdForMatch(m.id) === wanted);
      if (own && !this.isModelDisabled(own.id)) return own.id;
    }
    const peer = this.peerModels().find(
      (m) =>
        normalizeModelIdForMatch(parseRuntimeQualifiedModel(m.id)?.model ?? m.id) === wanted &&
        !this.isModelDisabled(m.id),
    );
    return peer?.id;
  }

  /** Reasoning effort the app defaults assign to a model in a tier, if the model is that tier's default. */
  private appDefaultEffort(
    tier: SessionTier,
    model: string | undefined,
  ): ReasoningEffort | undefined {
    if (!model) return undefined;
    const slot = tier === "chat" ? "main" : "subagents";
    const bare = parseRuntimeQualifiedModel(model)?.model ?? model;
    return normalizeModelIdForMatch(bare) ===
      normalizeModelIdForMatch(APP_AGENT_DEFAULTS[slot].model)
      ? APP_AGENT_DEFAULTS[slot].reasoningEffort
      : undefined;
  }

  private isStoredModelUsable(stored: string): boolean {
    if (this.isModelDisabled(stored)) return false;
    if (this.peerModels().some((m) => m.id === stored)) return true;
    if (parseRuntimeQualifiedModel(stored)) return false;
    return !this.activeRuntimeSignedOut() && this.availabilityOnBackend(stored) !== "no";
  }

  getDefaultModel(): string {
    const index = this.deps.store.loadIndex();
    const stored = index.defaultModel;
    // Honor the stored preference unless we KNOW it's missing on this
    // backend — overriding it during the cold-start window (cache empty)
    // would silently downgrade a saved selection on the first session.
    // A qualified id that is not in the peer list is stale; fall through.
    if (stored && this.isStoredModelUsable(stored)) return stored;

    const appDefault = this.findAppDefaultModel("main");
    if (appDefault) return appDefault;

    if (this.activeRuntimeSignedOut()) {
      // Never default to a runtime without credentials: the first signed-in peer, else nothing.
      return this.peerModels().find((m) => !this.isModelDisabled(m.id))?.id ?? "";
    }

    // Polymorphic fallback: each backend owns its own preference chain via
    // IToolBackend.getDefaultModel. Skip if the chain returns a tenant-
    // disabled id — the disabled list applies regardless of who picked.
    const backendDefault = this.deps.getBackendDefaultModel();
    if (backendDefault && !this.isModelDisabled(backendDefault)) {
      return backendDefault;
    }

    return this.isModelDisabled(DEFAULT_MODEL) ? "" : DEFAULT_MODEL;
  }

  /** getDefaultModel() after populating a cold model cache, so the active
   *  runtime's own preference chain answers instead of the cross-runtime
   *  DEFAULT_MODEL (a fresh Claude install otherwise defaulted to a GPT id). */
  async resolveDefaultModel(): Promise<string> {
    if ((this.deps.getCachedModelsFromBackend() ?? []).length === 0) {
      try {
        await this.deps.listModelsFromBackend();
      } catch (error) {
        log.warn("Model list unavailable while resolving the default model:", error);
      }
    }
    return this.getDefaultModel();
  }

  async setDefaultModel(model: string): Promise<{ success: boolean; error?: string }> {
    if (this.isModelDisabled(model)) {
      return { success: false, error: "This model is disabled by your organization's policy" };
    }
    await this.deps.store.withIndexLock((index) => {
      index.defaultModel = model;
    });
    log.info("Default model set to:", model);
    return { success: true };
  }

  /**
   * Applies an org manifest's `agentDefaults` once, filling only values the user has not set.
   * The input is parsed narrowly; a missing or malformed value changes nothing.
   */
  async applyOrgAgentDefaults(raw: unknown): Promise<{ applied: boolean }> {
    const defaults = parseOrgAgentDefaults(raw);
    if (!defaults) return { applied: false };
    let applied = false;
    await this.deps.store.withIndexLock((index) => {
      if (index.orgAgentDefaultsApplied) return;
      applied = true;
      index.orgAgentDefaultsApplied = true;
      const { main, subagents } = defaults;
      if (main && !index.defaultModel && !this.isModelDisabled(main.model)) {
        index.defaultModel = main.model;
        const efforts = { ...(index.defaultReasoningEfforts ?? {}) };
        if (main.effort) efforts[main.model] ??= main.effort;
        index.defaultReasoningEfforts = Object.keys(efforts).length > 0 ? efforts : undefined;
      }
      if (subagents && !this.isModelDisabled(subagents.model)) {
        for (const key of ["subagentDefaults", "workflowDefaults"] as const) {
          const next: TierModelDefaults = { ...(index[key] ?? {}) };
          next.model ??= subagents.model;
          if (subagents.effort) next.reasoningEffort ??= subagents.effort;
          index[key] = next;
        }
      }
    });
    if (applied) log.info("Org agent defaults applied");
    return { applied };
  }

  getDefaultReasoningEffort(model: string | undefined): ReasoningEffort | undefined {
    if (!model) return undefined;
    const stored = this.deps.store.loadIndex().defaultReasoningEfforts?.[model];
    if (!isReasoningEffort(stored)) return undefined;

    const cachedModel = this.getCachedModel(model);
    if (!cachedModel) return stored;

    const supported = this.getSupportedReasoningEfforts(cachedModel);
    return supported.includes(stored) ? stored : undefined;
  }

  async setDefaultReasoningEffort(
    model: string,
    effort: ReasoningEffort | undefined,
  ): Promise<{ success: boolean; error?: string }> {
    if (this.isModelDisabled(model)) {
      return { success: false, error: "This model is disabled by your organization's policy" };
    }
    if (effort !== undefined && !isReasoningEffort(effort)) {
      return { success: false, error: "Unsupported reasoning effort" };
    }

    const cachedModel = this.getCachedModel(model);
    if (cachedModel && effort !== undefined) {
      const supported = this.getSupportedReasoningEfforts(cachedModel);
      if (!supported.includes(effort)) {
        return { success: false, error: "This model does not support that reasoning effort" };
      }
    }

    await this.deps.store.withIndexLock((index) => {
      const next = { ...(index.defaultReasoningEfforts ?? {}) };
      if (effort === undefined) {
        delete next[model];
      } else {
        next[model] = effort;
      }
      index.defaultReasoningEfforts = Object.keys(next).length > 0 ? next : undefined;
    });
    log.info("Default reasoning effort set for model:", model, effort ?? "auto");
    return { success: true };
  }

  getDefaultContextTier(model: string | undefined): ContextTier {
    if (!model) return "default";
    const stored = this.deps.store.loadIndex().defaultContextTiers?.[model];
    const cachedModel = this.getCachedModel(model);
    if (isContextTier(stored)) {
      if (!cachedModel || this.getSupportedContextTiers(cachedModel).includes(stored))
        return stored;
    }
    return this.systemDefaultContextTier(model, cachedModel);
  }

  async setDefaultContextTier(
    model: string,
    contextTier: ContextTier | undefined,
  ): Promise<{ success: boolean; error?: string }> {
    if (this.isModelDisabled(model)) {
      return { success: false, error: "This model is disabled by your organization's policy" };
    }
    if (contextTier !== undefined && !isContextTier(contextTier)) {
      return { success: false, error: "Unsupported context window" };
    }
    const cachedModel = this.getCachedModel(model);
    if (
      cachedModel &&
      contextTier !== undefined &&
      !this.getSupportedContextTiers(cachedModel).includes(contextTier)
    ) {
      return { success: false, error: "This model does not support that context window" };
    }

    await this.deps.store.withIndexLock((index) => {
      const next = { ...(index.defaultContextTiers ?? {}) };
      if (contextTier === undefined) delete next[model];
      else next[model] = contextTier;
      index.defaultContextTiers = Object.keys(next).length > 0 ? next : undefined;
    });
    log.info("Default context tier set for model:", model, contextTier ?? "auto");
    return { success: true };
  }

  // ── Tiered defaults (chat / subagent / workflow) ──────────────────────────
  //
  // Each tier owns a default model + reasoning effort so orchestrators,
  // repo subagents, and workflow agents can run at different strengths.
  // `chat` reuses the legacy `defaultModel` + per-model reasoning map;
  // `subagent` / `workflow` use the `TierModelDefaults` index records.

  /** Effective default model for a tier. Falls back to the app's subagent default, then the
   *  chat default, when the tier has no usable stored model. */
  getTierDefaultModel(tier: SessionTier): string {
    if (tier === "chat") return this.getDefaultModel();
    const index = this.deps.store.loadIndex();
    const stored =
      tier === "subagent" ? index.subagentDefaults?.model : index.workflowDefaults?.model;
    if (stored && this.isStoredModelUsable(stored)) return stored;
    return this.findAppDefaultModel("subagents") ?? this.getDefaultModel();
  }

  /** Raw stored tier defaults (subagent / workflow) for the settings UI. */
  getTierDefaults(tier: "subagent" | "workflow"): TierModelDefaults {
    const index = this.deps.store.loadIndex();
    const stored = tier === "subagent" ? index.subagentDefaults : index.workflowDefaults;
    return {
      model: stored?.model,
      reasoningEffort: isReasoningEffort(stored?.reasoningEffort)
        ? stored.reasoningEffort
        : undefined,
      contextTier: isContextTier(stored?.contextTier) ? stored.contextTier : undefined,
    };
  }

  async setTierDefaultModel(
    tier: "subagent" | "workflow",
    model: string | undefined,
  ): Promise<{ success: boolean; error?: string }> {
    if (model && this.isModelDisabled(model)) {
      return { success: false, error: "This model is disabled by your organization's policy" };
    }
    await this.deps.store.withIndexLock((index) => {
      const key = tier === "subagent" ? "subagentDefaults" : "workflowDefaults";
      const next: TierModelDefaults = { ...(index[key] ?? {}) };
      if (model) next.model = model;
      else delete next.model;
      index[key] = Object.keys(next).length > 0 ? next : undefined;
    });
    log.info(`Default ${tier} model set to:`, model ?? "(inherit chat default)");
    return { success: true };
  }

  async setTierDefaultReasoningEffort(
    tier: "subagent" | "workflow",
    effort: ReasoningEffort | undefined,
  ): Promise<{ success: boolean; error?: string }> {
    if (effort !== undefined && !isReasoningEffort(effort)) {
      return { success: false, error: "Unsupported reasoning effort" };
    }
    const model = this.getTierDefaultModel(tier);
    const cachedModel = this.getCachedModel(model);
    if (cachedModel && effort !== undefined) {
      const supported = this.getSupportedReasoningEfforts(cachedModel);
      if (!supported.includes(effort)) {
        return { success: false, error: "This model does not support that reasoning effort" };
      }
    }
    await this.deps.store.withIndexLock((index) => {
      const key = tier === "subagent" ? "subagentDefaults" : "workflowDefaults";
      const next: TierModelDefaults = { ...(index[key] ?? {}) };
      if (effort === undefined) delete next.reasoningEffort;
      else next.reasoningEffort = effort;
      index[key] = Object.keys(next).length > 0 ? next : undefined;
    });
    log.info(`Default ${tier} reasoning effort set to:`, effort ?? "auto");
    return { success: true };
  }

  async setTierDefaultContextTier(
    tier: "subagent" | "workflow",
    contextTier: ContextTier | undefined,
  ): Promise<{ success: boolean; error?: string }> {
    if (contextTier !== undefined && !isContextTier(contextTier)) {
      return { success: false, error: "Unsupported context window" };
    }
    const model = this.getTierDefaultModel(tier);
    const cachedModel = this.getCachedModel(model);
    if (
      cachedModel &&
      contextTier !== undefined &&
      !this.getSupportedContextTiers(cachedModel).includes(contextTier)
    ) {
      return { success: false, error: "This model does not support that context window" };
    }
    await this.deps.store.withIndexLock((index) => {
      const key = tier === "subagent" ? "subagentDefaults" : "workflowDefaults";
      const next: TierModelDefaults = { ...(index[key] ?? {}) };
      if (contextTier === undefined) delete next.contextTier;
      else next.contextTier = contextTier;
      index[key] = Object.keys(next).length > 0 ? next : undefined;
    });
    log.info(`Default ${tier} context tier set to:`, contextTier ?? "auto");
    return { success: true };
  }

  /** Validate a per-session reasoning override against the session's model.
   *  Throws on an unsupported value (used by SessionManager.setSessionReasoningEffort). */
  assertReasoningEffortSupported(
    model: string | undefined,
    effort: ReasoningEffort | undefined,
  ): void {
    if (effort === undefined) return;
    if (!isReasoningEffort(effort)) throw new Error("Unsupported reasoning effort");
    const cachedModel = model ? this.getCachedModel(model) : null;
    if (cachedModel) {
      const supported = this.getSupportedReasoningEfforts(cachedModel);
      if (!supported.includes(effort)) {
        throw new Error("This model does not support that reasoning effort");
      }
    }
  }

  assertContextTierSupported(
    model: string | undefined,
    contextTier: ContextTier | undefined,
  ): void {
    if (contextTier === undefined) return;
    if (!isContextTier(contextTier)) throw new Error("Unsupported context window");
    const cachedModel = model ? this.getCachedModel(model) : null;
    if (cachedModel && !this.getSupportedContextTiers(cachedModel).includes(contextTier)) {
      throw new Error("This model does not support that context window");
    }
  }

  /**
   * Resolve the reasoning effort to pass to the backend for a session.
   * Precedence: explicit per-session override → tier default → system
   * default (High where supported, else the model's own SDK default).
   * Returns undefined for models that don't support reasoning effort at all
   * (the SDK rejects a reasoningEffort on those).
   */
  resolveReasoningEffort(args: {
    tier: SessionTier;
    model: string | undefined;
    sessionOverride?: ReasoningEffort;
  }): ReasoningEffort | undefined {
    const { tier, model, sessionOverride } = args;
    const cachedModel = model ? this.getCachedModel(model) : null;
    // `null` = unknown support (cache cold) — trust configured values, matching
    // getDefaultReasoningEffort's cold-cache behavior. The default model supports effort.
    const supported = cachedModel ? this.getSupportedReasoningEfforts(cachedModel) : null;
    const accepts = (e: ReasoningEffort | undefined): e is ReasoningEffort =>
      e !== undefined && (supported === null || supported.includes(e));
    const systemDefault =
      this.appDefaultEffort(tier, model) ??
      (model?.toLowerCase() === "gpt-5.6-sol"
        ? SYSTEM_DEFAULT_REASONING_EFFORT
        : FALLBACK_REASONING_EFFORT);

    if (accepts(sessionOverride)) return sessionOverride;

    const tierStored = this.getStoredTierReasoningEffort(tier, model);
    if (accepts(tierStored)) return tierStored;

    if (supported === null) return systemDefault;
    if (supported.length === 0) return undefined;
    if (supported.includes(systemDefault)) {
      return systemDefault;
    }
    if (supported.includes(FALLBACK_REASONING_EFFORT)) {
      return FALLBACK_REASONING_EFFORT;
    }
    const sdkDefault = cachedModel?.defaultReasoningEffort;
    return sdkDefault && isReasoningEffort(sdkDefault) && supported.includes(sdkDefault)
      ? sdkDefault
      : undefined;
  }

  resolveContextTier(args: {
    tier: SessionTier;
    model: string | undefined;
    sessionOverride?: ContextTier;
  }): ContextTier {
    const { tier, model, sessionOverride } = args;
    const cachedModel = model ? this.getCachedModel(model) : null;
    const supported = cachedModel ? this.getSupportedContextTiers(cachedModel) : null;
    const accepts = (value: ContextTier | undefined): value is ContextTier =>
      value !== undefined && (supported === null || supported.includes(value));

    if (accepts(sessionOverride)) return sessionOverride;
    if (tier !== "chat") {
      const tierDefaults =
        tier === "subagent"
          ? this.deps.store.loadIndex().subagentDefaults
          : this.deps.store.loadIndex().workflowDefaults;
      if (accepts(tierDefaults?.contextTier)) return tierDefaults.contextTier;
    }
    const stored = model ? this.deps.store.loadIndex().defaultContextTiers?.[model] : undefined;
    if (accepts(stored)) return stored;
    return this.systemDefaultContextTier(model, cachedModel);
  }

  private systemDefaultContextTier(
    model: string | undefined,
    cachedModel: ModelInfo | null,
  ): ContextTier {
    if (model?.toLowerCase() !== "gpt-5.6-sol") return "default";
    if (!cachedModel || this.getSupportedContextTiers(cachedModel).includes("long_context")) {
      return "long_context";
    }
    return "default";
  }

  private getStoredTierReasoningEffort(
    tier: SessionTier,
    model: string | undefined,
  ): ReasoningEffort | undefined {
    const index = this.deps.store.loadIndex();
    if (tier === "chat") {
      if (!model) return undefined;
      const stored = index.defaultReasoningEfforts?.[model];
      return isReasoningEffort(stored) ? stored : undefined;
    }
    const tierDefaults = tier === "subagent" ? index.subagentDefaults : index.workflowDefaults;
    const stored = tierDefaults?.reasoningEffort;
    return isReasoningEffort(stored) ? stored : undefined;
  }

  getSessionModel(sessionId: string): string | undefined {
    const session = this.deps.store.loadSessionData(sessionId);
    return session?.model;
  }

  /**
   * Validate and persist a session model change. Throws on failure.
   * Does NOT handle backend session lifecycle (destroy/recreate) —
   * that stays in SessionManager.
   */
  validateAndPersistSessionModel(sessionId: string, model: string): { soul?: string } {
    const session = this.deps.store.loadSessionData(sessionId);
    if (!session) throw new Error("Session not found");
    // Enforce tenant policy: block disabled models
    if (this.isModelDisabled(model)) {
      throw new Error(`Model "${model}" is disabled by tenant policy`);
    }
    session.model = model;
    this.deps.store.saveSessionData(session);
    return { soul: session.soul };
  }
}
