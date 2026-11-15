/**
 * Replaces the desktop's createLogger (common/marshal-logger.ts) in the lifted rooms files: a sink the host chooses
 * (`connectOrgRooms({ log })`), silent by default. Messages carry error names and counts only, never room content.
 */
export type RoomsLogSink = (level: "info" | "warn", tag: string, message: string) => void;

let sink: RoomsLogSink | undefined;

export function setRoomsLog(next: RoomsLogSink | undefined): void {
  sink = next;
}

export interface RoomsLogger {
  info(...parts: unknown[]): void;
  warn(...parts: unknown[]): void;
  error(...parts: unknown[]): void;
}

export function createLogger(tag: string): RoomsLogger {
  const write = (level: "info" | "warn", parts: unknown[]) => sink?.(level, tag, parts.map(String).join(" "));
  return { info: (...parts) => write("info", parts), warn: (...parts) => write("warn", parts), error: (...parts) => write("warn", parts) };
}
