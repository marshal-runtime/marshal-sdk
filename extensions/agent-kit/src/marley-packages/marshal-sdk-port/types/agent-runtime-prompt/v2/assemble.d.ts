import type { CoreSlotValues } from '../core/render.js';
import type { PromptSection } from '../types.js';
import { type V2CoreOptions, type V2Host, type V2SectionId } from './types.js';
/** Ids of every host-dependent span of the v2 sections. */
export declare function v2SlotIds(): string[];
/**
 * One v2 section as the host renders it, trimmed. Per span: the host's value if it gave one, else the neutral cloud
 * text, else nothing. A cloud host may not render a desktop-only section.
 */
export declare function renderV2Section(id: V2SectionId, slots?: CoreSlotValues, host?: V2Host): string;
/** The fixed v2 sections a session gets, in order; a cloud host gets only the shared ones. */
export declare function v2FixedSectionIds(host: V2Host, options?: V2CoreOptions): V2SectionId[];
/**
 * The fixed v2 sections as prompt sections (`core.v2.<id>`). With the desktop's slot values and host `desktop` their
 * text joined by a blank line is what the desktop's own v2 assembler renders before its session-dependent part.
 */
export declare function buildV2CoreSections(host: V2Host, options?: V2CoreOptions, slots?: CoreSlotValues): PromptSection[];
//# sourceMappingURL=assemble.d.ts.map