import { createLogger as createSharedLogger, silentLogger as sharedSilentLogger, type LogFields, type Logger as SharedLogger } from "@zygstinct/log";

export { logCaughtError, withheldMessage } from "@zygstinct/log";

/** The agent server's log levels (no `fatal`: the service logs ERROR and exits). */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** The four methods every agent-server module calls; the shared logger implements them (packages/log). */
export type Logger = SharedLogger;

/**
 * The agent server's logger: the shared one (packages/log), writing to `write`. `base.service` names the emitting process
 * (zs-agent-server, or a check or CLI); the other base fields go on every line. Message text and credentials are dropped by
 * field name, every string is masked, and an ERROR line carries error.kind/message/stack.
 */
export function createLogger(
  write?: (line: string) => void,
  level: LogLevel = "info",
  base: Record<string, unknown> = {},
): Logger {
  const { service, ...rest } = base as LogFields & { service?: unknown };
  return createSharedLogger({
    ...(write ? { write: (line: string) => write(line) } : {}),
    level,
    base: rest,
    service: typeof service === "string" ? service : "zs-agent-server",
  });
}

/** A logger that drops everything, for tests. */
export const silentLogger: Logger = sharedSilentLogger;

const ERROR_CLASSES = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "ApiError", "HttpError", "GatewayError",
  "QueryRejected", "PgQueryRejected", "CronError", "TurnAbortedError", "PoolNotConfiguredError", "ProviderRefusedError", "DatabaseError", "RoleRunError",
]);

/**
 * A safe label for a thrown value, for logs on paths where the message can quote brand data (a Postgres or BigQuery error
 * repeats the value that failed to cast). Only a Postgres SQLSTATE, a Node errno, an HTTP status or a known class name comes
 * out; the message, detail, context and the statement never do.
 */
export function errorClass(error: unknown): string {
  if (error && typeof error === "object") {
    const { code, name } = error as { code?: unknown; name?: unknown };
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && /[0-9]/.test(code)) return `sqlstate:${code}`;
    if (typeof code === "string" && /^E[A-Z_]{2,24}$/.test(code)) return code;
    if (typeof code === "number" && Number.isInteger(code) && code >= 100 && code < 600) return `http:${code}`;
    if (typeof name === "string" && ERROR_CLASSES.has(name)) return name;
  }
  return "Error";
}

/** The message of an unknown thrown value, without a stack. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
