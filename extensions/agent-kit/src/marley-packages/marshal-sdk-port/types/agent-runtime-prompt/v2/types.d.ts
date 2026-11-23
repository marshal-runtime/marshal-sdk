/** The sections of Marshal agent prompt v2, in the order a desktop session renders the fixed ones. */
export declare const V2_SECTION_IDS: readonly ["identity", "working-loop", "finding-information", "delegation", "typescript", "typescript-brokered", "typescript-rules", "showing-results", "memory-and-records", "requests", "long-running", "tools", "communication-and-code", "knowledge", "extensions"];
export type V2SectionId = (typeof V2_SECTION_IDS)[number];
/**
 * Sections only the desktop renders: forks and lanes, trusted Node blocks, app UI, the request ledger, automations
 * and goals, the desktop tool list, and extension management. A cloud host never renders them.
 */
export declare const V2_DESKTOP_ONLY_SECTIONS: readonly V2SectionId[];
/** Where the session runs: the desktop app, or a cloud host (the Slack, GitHub and headless surfaces). */
export type V2Host = 'desktop' | 'cloud';
/** What the session holds, which decides the fixed v2 sections it gets. */
export interface V2CoreOptions {
    /** Forks are this session's way to delegate (the desktop: forkSubagents on a session with host tools). */
    readonly delegation?: boolean;
    /** The runtime bridge of this session: trusted Node blocks, brokered blocks, or none. A cloud host runs brokered blocks only. */
    readonly runtime?: false | 'trusted' | 'brokered';
    /** Host tools are on this session's surface (not a tool-free, reviewer or fixed-toolset session). */
    readonly hostTools?: boolean;
    /**
     * The host renders a memory block (top memories for this person and workspace) in the session context. Without it a
     * cloud session gets no text that speaks of one; the desktop always renders one.
     */
    readonly memoryBlock?: boolean;
}
//# sourceMappingURL=types.d.ts.map