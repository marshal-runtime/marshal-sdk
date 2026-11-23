// Extract of zygstinct apps/agent-server/src/tasks/runtime-features.ts at 7110e58c8: only FeatureAnswer.
/** How a probe answered, decided where it is read: the runtime lists the feature, it does not, the probe command failed, or it could not run. */
export type FeatureOutcome = "advertised" | "not_advertised" | "probe_exited" | "probe_failed";

/** A probe's typed answer: whether the runtime has the feature, and why. */
export interface FeatureAnswer { supported: boolean; outcome: FeatureOutcome }
