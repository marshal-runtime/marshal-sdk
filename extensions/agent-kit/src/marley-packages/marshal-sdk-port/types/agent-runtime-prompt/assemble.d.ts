import { type CoreSlotValues } from './core/render.js';
import type { V2Host } from './v2/types.js';
import { type AgentPromptCore, type AssembleAgentPromptInput, type AssembledAgentPrompt, type PromptSection } from './types.js';
/** Every host-dependent span a host may fill, for the core and adapter variants. */
export declare function coreSlotIds(): string[];
/**
 * The core's pieces; with the desktop's slot values they equal what the desktop emitted before the split. The `v2`
 * core is several pieces (`core.v2.<section>`), chosen by `host` and `core.v2`.
 */
export declare function buildCoreSections(core: AgentPromptCore, slots?: CoreSlotValues, host?: V2Host): PromptSection[];
/**
 * Deterministic assembly of the shared agent prompt.
 *
 * Ordering contract (a stable prefix first, session-dependent text last):
 *   core.behavior, core.adapter.claude, surface.*, role.<role>, workspace, org, tools, extra.*
 * Empty and whitespace-only pieces are dropped; every piece is trimmed; pieces join with a blank line.
 */
export declare function assembleAgentPrompt(input: AssembleAgentPromptInput): AssembledAgentPrompt;
//# sourceMappingURL=assemble.d.ts.map