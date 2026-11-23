import type { V2CoreOptions } from './v2/types.js';
export declare const CLOUD_SURFACE_IDS: readonly ["cloud-slack", "cloud-github", "cloud-headless"];
export type CloudSurfaceId = (typeof CLOUD_SURFACE_IDS)[number];
export type AgentSurfaceId = 'desktop' | CloudSurfaceId;
export declare const AGENT_ROLES: readonly ["main", "worker", "subagent", "reviewer", "extractor", "watchdog", "router"];
export type AgentRole = (typeof AGENT_ROLES)[number];
export interface PromptSection {
    /** Stable identifier; ordering and ids are part of the package contract. */
    readonly id: string;
    readonly text: string;
}
export type ClaudeToolingVariant = 'full' | 'lean' | 'deep';
/** Native Claude tool guidance a host opts into when it really has those tools. */
export type ClaudeToolPack = 'web' | 'notebooks';
export interface AgentPromptCore {
    /**
     * `full` is the reviewed core, `lean` the rewrite that keeps every rule, `compact` a short core
     * (essentials only) for single-shot classifier, judge and extractor roles. All are host-neutral.
     * `v2` is Marshal agent prompt v2: one text for the desktop and cloud hosts, with host-dependent spans
     * (`v2SlotIds`); a cloud surface gets only its shared sections (`V2_DESKTOP_ONLY_SECTIONS` are left out).
     */
    readonly behavior: 'full' | 'lean' | 'compact' | 'v2';
    /** What the session holds, for the `v2` core; ignored by the other cores. */
    readonly v2?: V2CoreOptions;
    /**
     * Host-dependent spans of the core, keyed by slot id, for any surface. An injected desktop layer's `coreSlots`
     * take their place when given.
     */
    readonly slots?: Readonly<Record<string, string>>;
    /**
     * Claude native tool adapter: ground rules, file tools, shell, deferred-tool discovery. Omit or `false` for
     * runtimes that bring their own tool contract. A bare variant is shorthand for `{ variant }`.
     * `lean` and `deep` are trimmed projections. Everything about host tools belongs in the `tools` piece or
     * the host's own layer.
     */
    readonly claudeTooling?: false | ClaudeToolingVariant | ClaudeToolingOptions;
}
export interface ClaudeToolingOptions {
    readonly variant: ClaudeToolingVariant;
    /** Optional native tool guidance to include (web search/fetch, notebook editing). */
    readonly packs?: readonly ClaudeToolPack[];
}
/**
 * The desktop surface is not part of this package: the desktop app supplies it as an injected layer
 * (host tools, runtime bridge, UI, workspaces, Progress panel, askUser and the like).
 */
export interface DesktopSurfaceLayer {
    readonly id: 'desktop';
    /**
     * Host-dependent spans of the core and adapter, keyed by slot id (see `coreSlotIds`): the desktop identity
     * paragraph, "Marshal's permission policy", the Progress plan sentence and the like, plus the desktop-tool
     * sections of the Claude adapter. Anything not supplied falls back to the neutral text.
     */
    readonly coreSlots?: Readonly<Record<string, string>>;
    readonly sections: readonly PromptSection[];
    /** Replaces the package's generic role text when the desktop owns the role delta. */
    readonly roleDelta?: string;
}
export type AgentSurface = CloudSurfaceId | DesktopSurfaceLayer;
export interface PromptToolEntry {
    readonly name: string;
    /** One plain line on what the tool does on this host. */
    readonly description: string;
}
export interface AssembleAgentPromptInput {
    readonly core: AgentPromptCore;
    readonly surface: AgentSurface;
    readonly role: AgentRole;
    /** Plain markdown from the organization workspace manifest. */
    readonly workspaceDelta?: string;
    /** Who is in the session and how the reasoning trail is cited; plain markdown. */
    readonly orgDelta?: string;
    /** Only the tools that really exist on this host, in the order to show them. */
    readonly tools?: readonly PromptToolEntry[];
    /** Host-owned sections appended last, in order (availability guidance, extensions, session context). */
    readonly extraSections?: readonly PromptSection[];
}
export interface AssembledAgentPrompt {
    readonly content: string;
    readonly sections: readonly PromptSection[];
}
//# sourceMappingURL=types.d.ts.map