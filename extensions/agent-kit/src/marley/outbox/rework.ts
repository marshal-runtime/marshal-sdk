import type { ConversationKey } from "../store.js";
import { reworkRequest, reworkRunRequest, type OutboxDeps } from "./outbox.js";

/**
 * Where the outbox agent's rework (the composer's `rework`) goes: back to the agent that wrote the piece (docs/design/marley-model.md). A task's words go to
 * its worker (TaskManager.steer: the worker's session resumes with the note and its old words, and its new outbox words replace the piece); a routine run's
 * words go to that run's own session (ExtensionRoutineEngine.reworkRun; the rework turn's outbox parts go back through run-sends.ts `runSendsTo`); the words of a turn of the conversation go to
 * that conversation's next turn (the service's `reviseFor`). These are the wirings service.ts uses, so the tests exercise the same functions.
 */

/** The worker side: the task is resolved in the moment's own conversation only (SD01). */
export function taskRework(tasks: { steer(input: { scope: ConversationKey; taskId: string; text: string; turnId: string }): "started" | "queued" | "refused" }): NonNullable<OutboxDeps["rework"]> {
  return (key, taskId, request) => tasks.steer({ scope: key, taskId, turnId: `rework:${request.momentId}`, text: reworkRequest(request.note, request.text) });
}

/** The routine side: the run's own session takes the rework in the piece's conversation (its home). `engine` is read at the call (it starts after the outbox). */
export function runRework(engine: () => { reworkRun(input: { brandId: string; sessionId: string; home: ConversationKey; text: string }): Promise<"started" | "refused"> } | undefined): NonNullable<OutboxDeps["reworkRun"]> {
  return async (key, runId, request) => (await engine()?.reworkRun({ brandId: key.brandId, sessionId: runId, home: key, text: reworkRunRequest(request.note, request.text) })) ?? "refused";
}
