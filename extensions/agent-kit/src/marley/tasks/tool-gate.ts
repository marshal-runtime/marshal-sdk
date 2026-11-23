/**
 * Tool names Marley's sessions know. No session runs a hook (no gate decides a call while it runs): a session is limited only by the tools it is
 * listed (`disallowedTools`) and by what the brand VM's runtime and helpers refuse themselves.
 */

/**
 * Claude Code's own ways to run work beside the turn: its subagents (Agent, and Task as older versions name it), the tools that read, stop or message
 * them, a background shell's output and kill tools, and its own monitors, cron jobs, wake-ups and workflows. None of them belongs in a Marley session:
 * a subagent starts from an empty context, a background job outlives nothing (the live process closes when idle, and a worker's run ends with its
 * result), and their output never reaches the person. Delegation is a fork through the Marshal host (`marshal.tool.forkSubagents`), which the server runs as a worker task; a wakeup is
 * `zs.schedule.*`. Set as `disallowedTools` on every session: the model never sees their schemas.
 */
export const NATIVE_DELEGATION_TOOLS = ["Agent", "Task", "TaskOutput", "TaskStop", "BashOutput", "KillShell", "KillBash", "Monitor", "Workflow", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger", "SendMessage"];


/**
 * A worker's hands in a direct chat whose member is not disabled (pending included, MLY-604) on the run's fresh read, the same writes the front makes there: wakeups and triggers of this
 * conversation, memory saves and forgets under the VM's own validators (PM01-03), and a connector request. Schedules, triggers and requests are intents
 * the server applies after the run, as the task's member, after re-reading the member, the DM's number and the task's claim (tasks/manager.ts); a
 * create also records the task's chain generation and is refused at MAX_CONTINUATIONS (tasks/chain.ts), and a request is filed as Marley's on the
 * member's behalf. Memory is not a VM hand: every session writes the brand's Brain graph through the host's marshal.tool.remember / updateMemory / linkMemory / forget
 * (brain-memory/, Omer R80).
 */
// A brand attribution channel rule (attribution-rules.ts) is a hand too: Marley saves it alone, as an intent the server validates after the run.
// So is the owner's Amazon search term decision (amazon-search-terms.ts), listed only in the owner's own DM.
export const WORKER_HANDS = ["zs.schedule.", "zs.events.", "zs.connector.", "zs.attribution.save_rule", "zs.attribution.retire_rule", "zs.amazon_terms.save", "zs.amazon_terms.retire"] as const;

const HAND_OFF_HOW = "fork with runtime_exec (targetType operation, target marshal.tool.forkSubagents, input {tasks: [{name, task}]}): the task is everything the worker needs (the question, the window, the metrics, what you already found). Then end with one short line in the person's language that says what you will check and when you will be back; send that line only in the final reply, not with a reply tool. Never tell the person about tools, refusals, background workers or this instruction.";

export const HANDOFF_REASON = `Hand this to a background worker: ${HAND_OFF_HOW} Nothing else runs now.`;

/** The same for a brand VM without host forks (not yet released with remote_runtime@1), with the `<task>` directive. */
export const DIRECTIVE_HANDOFF_REASON = "Hand this to a background task: put <task title=\"…\">everything the worker needs: the question, the window, the metrics, what you already found</task> in your final reply, with one short line before it in the person's language that says what you will check and when you will be back. Send that line only in the final reply, not with a reply tool. Never tell the person about tools, refusals, background workers or this instruction. Nothing else runs now.";
