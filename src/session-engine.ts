// The desktop's SessionManager (packages/providers/src/engine/sessions.ts): the turn loop, steering, queueing,
// compaction, fork and subagent bookkeeping and runtime switching, over the session engine. It reaches the
// host through the same ports as the engine (configureEngineHost in providers.js), so this bundle imports
// them from there and both share one host.
export { SessionManager } from "../packages/providers/src/engine/sessions";
export { TurnAccumulator } from "../packages/providers/src/engine/turn-accumulator";
export { SessionStartCoordinator } from "../packages/providers/src/engine/session-start-coordinator";
