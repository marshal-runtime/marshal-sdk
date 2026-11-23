// Extract of zygstinct apps/agent-server/src/routine-state/ua-files.ts at 7110e58c8: only UA_DURABLE_PATTERNS, UA_SCRATCH_PATTERNS.
// UA (Meta ad analysis) keeps its working files in the chat's `~/work/ua/` (the recipe is unchanged); the server captures the durable ones into the store after
// each turn and before the next, and restores what is missing on a fresh machine (D121). This file says which files are durable (a key), which are scratch (rebuilt
// or disposable) and everything else is unknown, which the move check refuses. The python scripts in sandbox/ua-files-scripts.ts apply the same lists.
export const UA_DAY = "\\d{4}-\\d{2}-\\d{2}";

/** Relative to `~/work/ua/`. */
export const UA_DURABLE_PATTERNS = [`^(latest|config|said)\\.json$`, `^${UA_DAY}/(findings|result|run)\\.json$`] as const;

export const UA_SCRATCH_PATTERNS = [
  `^${UA_DAY}/(status|snapshot|settings|publish)\\.json$`, `^${UA_DAY}/(worker|launch)\\.log$`, `^${UA_DAY}/(worker|publish)\\.lock$`,
  `^${UA_DAY}/job-[a-f0-9]{16}\\.json$`, `^publish\\.lock$`, `^\\.tmp-[0-9a-f]+$`, `^${UA_DAY}/\\.tmp-[0-9a-f]+$`,
] as const;

const durable = UA_DURABLE_PATTERNS.map((pattern) => new RegExp(pattern));

const scratch = UA_SCRATCH_PATTERNS.map((pattern) => new RegExp(pattern));
