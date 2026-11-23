// The typed failure of a role session, in a module with no imports: `operation-error.ts` reads it for log fields, and that file is bundled alone with
// `sandbox/ssh.ts` (test/ssh-rebuild.test.ts), so it must not pull in the Agent SDK through `run-role.ts`.

/** The SDK's own typed label on an error it throws (`errorClass` property), never read from the message. */
const SDK_ERROR_CLASSES = new Set(["error_result", "process_exited_nonzero", "process_killed_by_signal", "aborted"]);

/** The SDK's typed fields of a thrown value: its `errorClass` (when one the SDK sets) and the CLI's `exitCode`, read only beside that tag (another error's exitCode is not the CLI's). */
export function sdkErrorFields(error: unknown): { sdkErrorClass: string | null; exitCode: number | null } {
  if (!error || typeof error !== "object") return { sdkErrorClass: null, exitCode: null };
  const { errorClass, exitCode } = error as { errorClass?: unknown; exitCode?: unknown };
  if (typeof errorClass !== "string" || !SDK_ERROR_CLASSES.has(errorClass)) return { sdkErrorClass: null, exitCode: null };
  return { sdkErrorClass: errorClass, exitCode: typeof exitCode === "number" && Number.isInteger(exitCode) ? exitCode : null };
}

/** A role session that ended without a successful result. */
export class RoleRunError extends Error {
  constructor(
    readonly role: string,
    readonly subtype: string,
    readonly costUsd: number,
  ) {
    super(`role '${role}' ended with ${subtype} after $${costUsd.toFixed(2)}`);
    this.name = "RoleRunError";
  }
  /** The SDK's typed label and the CLI's exit code when the SDK threw after the session ended (see `runRole`); null when it did not. */
  sdkErrorClass: string | null = null;
  exitCode: number | null = null;
}
