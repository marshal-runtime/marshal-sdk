import { GatewayError } from "./gateway.js";
import { errorClass, withheldMessage } from "./logger.js";
import { RoleRunError, sdkErrorFields } from "./engine/role-run-error.js";
import { ProviderRefusedError } from "./types.js";

const OPERATIONS = ["server", "ssh", "brand_ensure", "chat_viewer", "key_grant", "chat_eval", "brain_token", "metadata_token", "embed_token", "speech_token", "vision_token", "daytona", "repo_setup", "activity_append", "repo_write", "inbox_write", "outbox_write", "file_read", "memory_commit", "transcript_pull", "transcript_remove", "transcript_restore", "transcript_stage", "tar_extract", "mirror_init", "mirror_bundle", "mirror_fetch", "mirror_push", "repo_reindex", "transcript_store_unsafe", "repo_head", "repo_ancestry", "mirror_head"] as const;
type Operation = (typeof OPERATIONS)[number];

/** Helper failures carry only fixed metadata, never command output or paths. */
export class OperationError extends Error {
  constructor(readonly operation: Operation, readonly exitCode: number | null) {
    super(`${operation} failed (exit ${exitCode ?? "unknown"})`);
    this.name = "OperationError";
  }
}

/** Fixed metadata of a failure: what a stored result may record. */
export function operationFields(error: unknown): { operation: Operation; exitCode: number | null; errorClass: string } {
  return {
    operation: error instanceof OperationError && OPERATIONS.includes(error.operation) ? error.operation : "server",
    exitCode: error instanceof OperationError && Number.isInteger(error.exitCode) ? error.exitCode : null,
    errorClass: error instanceof OperationError ? "OperationError" : errorClass(error),
  };
}

/**
 * The log fields of a failure: the fixed metadata plus `error` for Error Tracking. An OperationError's own message is fixed
 * metadata, so it goes as it is; any other thrown value keeps its kind and stack frames but never its text (a Postgres,
 * BigQuery or git message can quote brand data that masking cannot recognize).
 */
export function failureFields(error: unknown): ReturnType<typeof operationFields> & {
  error: Error;
  gatewayStatus?: number | null;
  gatewayReason?: string;
  providerStatus?: number;
  providerErrorType?: string | null;
  providerRequestId?: string | null;
  errorCode?: string;
  sdkErrorClass?: string;
  cliExitCode?: number;
} {
  const fields = operationFields(error);
  if (error instanceof RoleRunError) {
    // The session's own limit (timeout, turn or budget limit, an error result), from the result's typed subtype and the SDK's typed fields, never its text.
    return { ...fields, errorClass: "RoleRunError", errorCode: error.subtype, ...(error.sdkErrorClass ? { sdkErrorClass: error.sdkErrorClass } : {}), ...(error.exitCode !== null ? { cliExitCode: error.exitCode } : {}), error: withheldMessage(error, "RoleRunError") };
  }
  if (error instanceof ProviderRefusedError) {
    // Its message is built from the provider's status and error.type field only (fixed metadata), never the provider's message text.
    return { ...fields, errorClass: "ProviderRefusedError", error, providerStatus: error.status, providerErrorType: error.providerErrorType, providerRequestId: error.providerRequestId };
  }
  if (error instanceof GatewayError) {
    // The message is built from the HTTP status, a short reason and a transport errno only, never the gateway's body or the message text.
    return { ...fields, errorClass: "GatewayError", error, gatewayStatus: error.status, ...(error.reason ? { gatewayReason: error.reason } : {}) };
  }
  const sdk = sdkErrorFields(error);
  // A Daytona SDK error has an empty message, so its HTTP status is the only fixed metadata that says why the call failed.
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  const httpStatus = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  return { ...fields, ...(httpStatus !== undefined ? { providerStatus: httpStatus } : {}), ...(sdk.sdkErrorClass ? { sdkErrorClass: sdk.sdkErrorClass } : {}), ...(sdk.exitCode !== null ? { cliExitCode: sdk.exitCode } : {}), error: error instanceof OperationError ? error : withheldMessage(error, fields.errorClass) };
}
