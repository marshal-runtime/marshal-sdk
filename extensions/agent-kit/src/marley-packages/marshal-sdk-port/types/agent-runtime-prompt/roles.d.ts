import type { AgentRole } from './types.js';
/**
 * Role deltas are additive: every role keeps the full core, and a delta tightens or focuses it.
 * Runtime-neutral: nothing here names a tool, so any surface can carry any role.
 */
export declare const ROLE_DELTAS: Readonly<Record<AgentRole, string>>;
//# sourceMappingURL=roles.d.ts.map