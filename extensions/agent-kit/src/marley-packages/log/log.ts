/**
 * The one logger of every Marley service (docs/knowledge/shared-logger-20261102.md).
 *
 * One JSON line per event, in Cloud Logging's shape: `severity` (what log-based metrics and alerts filter on), `level`,
 * `time`, `service` and a stable dotted `event`, then the caller's fields. A line at ERROR or above always carries
 * `error: {kind, message, stack}`, which Datadog Error Tracking groups into issues: from the thrown value when the caller
 * passes one (`logCaughtError`, or an Error in any field), otherwise from the call site.
 *
 * Protections, applied here so no call site has to remember them:
 * - fields whose name can carry message text or a credential are dropped (`DEFAULT_DROP_FIELDS`, plus the app's own);
 * - the same names are dropped at any depth of a nested value;
 * - every string (fields, error message, stack, nested values) is masked: phone numbers that have a phone shape (E.164, a
 *   whatsapp:/tel: label or a `|whatsapp|` conversation key, grouped digits, Israeli 05x, 972..., 00..., North American
 *   1 + 10 digits), email addresses (also %40; Google service accounts kept), Bearer/Basic credentials, Cookie values, URL
 *   passwords, sk-ant-/sk- keys, ya29. tokens, JWTs and secret URL parameters. A digit run that touches a letter, digit or
 *   underscore is never a phone (brand ids, act_<digits>). UUIDs, ISO timestamps and runs of 16+ digits are kept.
 *   Numbers are not masked (epoch milliseconds are 13 digits); the Datadog forwarder masks them on export.
 *
 * This file has no imports: apps/sandbox/src/vendor/log.ts is a byte-identical copy (the sandbox image ships no workspace
 * package), and `pnpm check:logging` fails when the two differ. The Python twin is data/airflow/dags/common/log_fields.py;
 * both are checked against packages/log/log-fields.json.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";
export type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";
export type LogFields = Record<string, unknown>;
/** Receives one serialized line (no trailing newline) and its severity. */
export type LogWriter = (line: string, severity: Severity) => void;
type CallSite = (...args: any[]) => unknown;

/** The four methods every app's code calls. Test fakes implement only these. */
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/** The logger `createLogger` returns. */
export interface StructuredLogger extends Logger {
  /** CRITICAL. Logs only; the caller decides whether the process exits. */
  fatal(event: string, fields?: LogFields): void;
  /** One line at `level`; `callSite` is the outermost logging function, whose frames a call-site stack omits. */
  log(level: LogLevel, event: string, fields?: LogFields, callSite?: CallSite): void;
}

export interface LoggerOptions {
  /** Emitting service. Default: env ZS_SERVICE, else "marley". A caller field named `service` wins on its own line. */
  service?: string;
  /** Lowest level written. Default: env LOG_LEVEL, else "info". */
  level?: LogLevel;
  /** Default: stdout, one line each (console.log where there is no process.stdout). */
  write?: LogWriter;
  /** Fields on every line (after the reserved ones, before the caller's). */
  base?: LogFields;
  /** Field names dropped in addition to DEFAULT_DROP_FIELDS (case-insensitive). */
  dropFields?: readonly string[];
  /** Clock, for tests. */
  now?: () => Date;
}

/** Attribute names, shared with the Python formatter through packages/log/log-fields.json. */
export const LOG_FIELDS = {
  severity: "severity",
  level: "level",
  time: "time",
  service: "service",
  event: "event",
  error: "error",
  errorKind: "kind",
  errorMessage: "message",
  errorStack: "stack",
} as const;

export const PHONE_MASK = "[REDACTED_PHONE]";
export const EMAIL_MASK = "[REDACTED_EMAIL]";
export const SECRET_MASK = "[REDACTED]";
export const MAX_ERROR_MESSAGE = 1000;
export const MAX_ERROR_STACK = 16000;
const MAX_DEPTH = 8;

export const SEVERITY: Readonly<Record<LogLevel, Severity>> = { debug: "DEBUG", info: "INFO", warn: "WARNING", error: "ERROR", fatal: "CRITICAL" };
const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const LEVEL_OF_SEVERITY: Readonly<Record<string, LogLevel>> = {
  DEBUG: "debug", INFO: "info", NOTICE: "info", DEFAULT: "info", WARNING: "warn", WARN: "warn", ERROR: "error", CRITICAL: "fatal", ALERT: "fatal", EMERGENCY: "fatal", FATAL: "fatal",
};

/** Field names that never reach a log line: message text and credentials. Compared case-insensitively. */
export const DEFAULT_DROP_FIELDS: readonly string[] = [
  "text", "body", "caption", "prompt", "token", "access_token", "accessToken", "refresh_token", "refreshToken", "id_token", "idToken",
  "apiKey", "api_key", "app_secret", "appSecret", "verify_token", "secret", "password", "authorization", "authorization_header", "cookie",
];

const DEFAULT_DROP_SET: ReadonlySet<string> = new Set(DEFAULT_DROP_FIELDS.map((name) => name.toLowerCase()));

/** Keys the logger owns. A caller field with one of these names is kept as `field_<name>`. */
const RESERVED = new Set<string>([LOG_FIELDS.severity, LOG_FIELDS.level, LOG_FIELDS.time, LOG_FIELDS.event]);

// --- masking ----------------------------------------------------------------------------------------------------------

// One left-to-right scan; at one position the alternatives are tried in order, so the shapes that are kept (UUID, ISO
// timestamp, a run of more than 15 digits) win over the phone shapes that would match their digits. A digit run that touches
// a letter, digit or underscore is never a phone number (a brand id `brand_<hex>_shopify`, `act_<digits>`, an epoch in a name);
// a bare run is masked only when it has a phone shape (+ prefix, a label such as whatsapp: or tel:, grouped separators, an
// Israeli 05x number, 972..., 00..., or a North American 1 + 10 digits). Epoch milliseconds, order ids and ad account ids
// are not masked. Same scan as the Datadog forwarder's UDF.
const NOT_WORD_BEFORE = "(?<![A-Za-z0-9_])";
const NOT_WORD_AFTER = "(?![A-Za-z0-9_])";
const SCAN = new RegExp([
  "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})", // 1 UUID: kept
  "([0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:[.,][0-9]+)?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)", // 2 timestamp: kept
  "([A-Za-z0-9._%+-]{1,64}(?:@|%40)(?:[A-Za-z0-9-]{1,63}\\.){1,8}[A-Za-z]{2,24})", // 3 email, also percent-encoded
  `${NOT_WORD_BEFORE}(\\+[0-9](?:[ .()-]{0,2}[0-9]){6,14})(?![0-9])`, // 4 E.164, 7 to 15 digits
  "([0-9]{16,})", // 5 longer than any phone number: kept
  `${NOT_WORD_BEFORE}((?:whatsapp|tel|sms|imessage|phone|msisdn|wa_id)[:=|] ?)\\+?[0-9]{7,15}${NOT_WORD_AFTER}`, // 6 labelled number or conversation id
  `${NOT_WORD_BEFORE}(\\(?[0-9]{2,4}\\)?[ -][0-9]{3}[ -]?[0-9]{3,4})${NOT_WORD_AFTER}`, // 7 national number in groups (054-123-4567, (415) 555-0100)
  `${NOT_WORD_BEFORE}((?:05[0-9]{8}|972[0-9]{9}|00[0-9]{9,13}|1[2-9][0-9]{2}[2-9][0-9]{6}))${NOT_WORD_AFTER}`, // 8 bare Israeli, 972, 00 or North American shape
].join("|"), "g");
const SERVICE_ACCOUNT_EMAIL = /\.gserviceaccount\.com$/i;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi;
const COOKIE = /\b((?:Set-)?Cookie\s*[:=]\s*)[^\r\n]+/gi;
// Anchored on the literal :// with bounded classes, so a long run of scheme characters costs nothing.
const URL_USERINFO = /(:\/\/[^\s:/@"'<>\\]{1,64}:)[^\s/@"'<>\\]{1,128}(@)/g;
const TOKEN_SHAPES = /\bsk-ant-[A-Za-z0-9_-]{8,}|\bsk-[A-Za-z0-9_-]{20,}|\bya29\.[A-Za-z0-9_-]{10,}|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const URL_SECRET = /([?&#;](?:access_token|refresh_token|id_token|token|api_key|apikey|key|sig|signature|code|password|secret|auth|session|otp)=)[^&#;\s"']+/gi;

// A bare number after a phone label is a phone number: phone=4155550100, "phone":"14155550100", conversation 14155550100,
// to=447911123456, recipient 447911123456 (no left boundary on the label, so user_phone= counts; `to` needs one). Anchored on
// the label, every class bounded. Same rule as the Datadog forwarder's UDF (PHONE_LABELLED).
const PHONE_LABELLED = /((?:(?:phone|msisdn|mobile|wa_?id|conversation|recipients?|sender|whatsapp)(?:[_ ]?(?:number|num|no|id))?|(?<![A-Za-z0-9_])to)(?:\\?["'])?\)?(?:\s{0,2}[:=]\s{0,2}|\s{1,2})(?:\(|\\?["']|\+){0,2})[0-9]{9,15}(?![A-Za-z0-9_])/gi;
// Postgres detail lines: Key (channel, conversation_id)=(whatsapp, 14155550100) already exists.
// The columns may hold function calls (Key (lower((phone)::text))=(...)): lazy, bounded, ends at the first )=( after them.
const PG_KEY = /\bKey \((.{1,200}?)\)=\(([^()]{1,300})\)/g;
const PHONE_COLUMN = /phone|msisdn|mobile|wa_?id|conversation|recipient|sender|whatsapp/i;
const DIGIT_RUN = /(^|[^A-Za-z0-9_])[0-9]{9,15}(?![A-Za-z0-9_])/g;

/** Masks phone numbers, emails and credentials in one string. Idempotent. */
export function maskText(text: string): string {
  if (!/[0-9@]|%40|bearer|basic|cookie|eyJ|sk-|ya29/i.test(text)) return text;
  return text
    .replace(BEARER, (_match, scheme: string) => `${scheme} ${SECRET_MASK}`)
    .replace(COOKIE, (_match, label: string) => `${label}${SECRET_MASK}`)
    .replace(URL_USERINFO, (_match, head: string, at: string) => `${head}${SECRET_MASK}${at}`)
    .replace(TOKEN_SHAPES, SECRET_MASK)
    .replace(URL_SECRET, (_match, name: string) => `${name}${SECRET_MASK}`)
    .replace(PG_KEY, (match, columns: string, values: string) => (PHONE_COLUMN.test(columns) ? `Key (${columns})=(${values.replace(DIGIT_RUN, `$1${PHONE_MASK}`)})` : match))
    .replace(PHONE_LABELLED, (_match, head: string) => `${head}${PHONE_MASK}`)
    .replace(SCAN, (match, uuid?: string, timestamp?: string, email?: string, e164?: string, longRun?: string, label?: string, grouped?: string, bare?: string) => {
      if (uuid || timestamp || longRun) return match;
      if (email) return SERVICE_ACCOUNT_EMAIL.test(email) ? match : EMAIL_MASK;
      if (e164 || bare) return PHONE_MASK;
      if (label) return `${label}${PHONE_MASK}`;
      if (grouped) {
        const digits = grouped.replace(/[^0-9]/g, "").length;
        return digits >= 9 && digits <= 15 ? PHONE_MASK : match;
      }
      return match;
    });
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// A bare digit run has no phone shape, but a digits-only string or integer under a phone-like key is a phone number (a
// WhatsApp conversation id is the bare number), however deep: {conversation: {id: "14155550100"}}, {recipients: [1415...]}.
const PHONE_FIELD = /phone|msisdn|mobile|whatsapp|wa_?id|conversation|recipient|sender|^to$/i;
const TIME_KEY_SNAKE = /(^|_)(at|time|ts|timestamp|date|expires?|created|updated)$/i;
const TIME_KEY_CAMEL = /[a-z0-9](At|Time|Ts|Timestamp|Date|Expires?|Created|Updated)$/;

/** Where a value sits under a phone-like key: `direct` when its own key is phone-like, `key` its own key. */
interface PhoneContext { direct: boolean; key: string }

function isBarePhone(item: unknown): boolean {
  return (typeof item === "number" ? Number.isInteger(item) : typeof item === "string") && /^\+?[0-9]{9,15}$/.test(String(item));
}

// A time-named key holding an epoch in the current range (seconds or milliseconds, 2017-2039) inside a phone-keyed object is a
// timestamp, unless its own key is the phone-like one. Any other key, and anything out of range, is masked.
function isEpoch(value: unknown, key: string): boolean {
  return typeof value === "number" && (TIME_KEY_SNAKE.test(key) || TIME_KEY_CAMEL.test(key))
    && ((value >= 1.5e9 && value < 2.2e9) || (value >= 1.5e12 && value < 2.2e12));
}

/** The context of a field called `key` inside a value whose own context is `parent`. */
export function phoneContextOf(parent: PhoneContext | undefined, key: string): PhoneContext | undefined {
  if (PHONE_FIELD.test(key)) return { direct: true, key };
  return parent ? { direct: false, key } : undefined;
}

/** A JSON-safe, masked copy of any value: strings masked and `drop` keys removed at every depth, digits under phone-like keys masked, Errors summarized, binary and cycles cut. */
export function redact(value: unknown, depth = 0, drop?: ReadonlySet<string>, phone?: PhoneContext): unknown {
  if (phone && isBarePhone(value) && !(!phone.direct && isEpoch(value, phone.key))) return PHONE_MASK;
  if (typeof value === "string") return maskText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return value;
  if (typeof value === "bigint") return maskText(value.toString());
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (value instanceof Error) {
    const { kind, message } = describeError(value);
    return { kind, message };
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, drop, phone));
  if (value instanceof Map) return redact(Object.fromEntries(value), depth + 1, drop, phone);
  if (value instanceof Set) return redact([...value], depth + 1, drop, phone);
  const out: LogFields = {};
  for (const [key, item] of Object.entries(value as LogFields)) {
    if (drop?.has(key.toLowerCase())) continue;
    out[key] = redact(item, depth + 1, drop, phoneContextOf(phone, key));
  }
  return out;
}

// --- errors -----------------------------------------------------------------------------------------------------------

/** What an error line carries for Error Tracking. Every string is masked and bounded. */
export interface ErrorFields {
  kind: string;
  message: string;
  stack?: string;
}

function kindOf(error: Error): string {
  if (typeof error.name === "string" && error.name && error.name !== "Error") return error.name;
  const constructorName = (error as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof constructorName === "string" && constructorName && constructorName !== "Object" ? constructorName : "Error";
}

function stackOf(error: Error, depth: number): string {
  const own = typeof error.stack === "string" && error.stack ? error.stack : `${kindOf(error)}: ${error.message}`;
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && depth < 3) return `${own}\nCaused by: ${stackOf(cause, depth + 1)}`;
  return own;
}

/** kind, message and stack of a thrown value (any value can be thrown), masked and bounded. */
export function describeError(thrown: unknown): ErrorFields {
  if (thrown instanceof Error) {
    const kind = kindOf(thrown);
    const message = typeof thrown.message === "string" && thrown.message ? thrown.message : kind;
    return { kind, message: clip(maskText(message), MAX_ERROR_MESSAGE), stack: clip(maskText(stackOf(thrown, 0)), MAX_ERROR_STACK) };
  }
  if (thrown === null || thrown === undefined) return { kind: String(thrown), message: String(thrown) };
  const message = typeof thrown === "object" && typeof (thrown as { message?: unknown }).message === "string"
    ? (thrown as { message: string }).message
    : typeof thrown === "object" ? safeJson(thrown) : String(thrown);
  return { kind: typeof thrown, message: clip(maskText(message), MAX_ERROR_MESSAGE) };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(redact(value, 0, DEFAULT_DROP_SET)) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * The thrown value with its message withheld: `kind` as name and message, and the thrown value's own stack frames. For
 * paths whose error text can quote brand data that masking cannot recognize (a Postgres error repeats the value that failed
 * to cast, git stderr names a member's file): the line still groups by kind and stack, and the text never leaves.
 */
export function withheldMessage(thrown: unknown, kind: string): Error {
  const withheld = new Error(kind);
  withheld.name = kind;
  const frames = thrown instanceof Error && typeof thrown.stack === "string"
    ? thrown.stack.split("\n").filter((line) => /^\s+at /.test(line))
    : (withheld.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line)).slice(1);
  withheld.stack = [kind, ...frames].join("\n");
  return withheld;
}

type StackCapture = (target: object, omitAbove?: CallSite) => void;

/** A parseable stack of the logging call site, omitting the logger's own frames above `callSite`. */
function callSiteStack(kind: string, message: string, callSite: CallSite): string {
  const capture = (Error as unknown as { captureStackTrace?: StackCapture }).captureStackTrace;
  const holder: { name: string; message: string; stack?: string } = { name: kind, message };
  if (capture) capture(holder, callSite);
  else holder.stack = new Error(message).stack;
  const frames = (holder.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line));
  return clip(maskText([`${kind}: ${message}`, ...frames].join("\n")), MAX_ERROR_STACK);
}

// --- writers ----------------------------------------------------------------------------------------------------------

type ProcessLike = { stdout?: { write?: (chunk: string) => unknown }; stderr?: { write?: (chunk: string) => unknown }; env?: Record<string, string | undefined> };
const proc = (): ProcessLike | undefined => (typeof process === "undefined" ? undefined : (process as unknown as ProcessLike));

/** One line on stdout (Cloud Logging reads `severity` from the JSON, not the stream). */
export const stdoutWriter: LogWriter = (line) => {
  const out = proc()?.stdout;
  if (out?.write) out.write(`${line}\n`);
  else globalThis.console.log(line);
};

/** One line on stderr, for processes whose stdout is a protocol (an MCP or broker worker). */
export const stderrWriter: LogWriter = (line) => {
  const err = proc()?.stderr;
  if (err?.write) err.write(`${line}\n`);
  else globalThis.console.error(line);
};

/** console.error for ERROR and above, console.warn for WARNING, console.info otherwise (Next.js server code). */
export const consoleWriter: LogWriter = (line, severity) => {
  if (severity === "ERROR" || severity === "CRITICAL") globalThis.console.error(line);
  else if (severity === "WARNING") globalThis.console.warn(line);
  else globalThis.console.info(line);
};

// --- the logger -------------------------------------------------------------------------------------------------------

function envLevel(): LogLevel | undefined {
  const raw = (proc()?.env?.LOG_LEVEL ?? "").toLowerCase();
  const level = raw === "warning" ? "warn" : raw;
  return level in LEVEL_ORDER ? (level as LogLevel) : undefined;
}

export function createLogger(options: LoggerOptions = {}): StructuredLogger {
  const service = options.service ?? proc()?.env?.ZS_SERVICE ?? "marley";
  const threshold = LEVEL_ORDER[options.level ?? envLevel() ?? "info"];
  const write = options.write ?? stdoutWriter;
  const now = options.now ?? (() => new Date());
  const drop = new Set([...DEFAULT_DROP_FIELDS, ...(options.dropFields ?? [])].map((name) => name.toLowerCase()));
  const base = options.base ?? {};

  const emit = (level: LogLevel, event: string, fields: LogFields, callSite: CallSite): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    try {
      const severity = SEVERITY[level];
      const all: LogFields = { ...base, ...fields };
      const hasErrorField = LOG_FIELDS.error in all && all[LOG_FIELDS.error] !== undefined;
      // The thrown value: the `error` field when it is an Error, else (no `error` field) the first Error in any field.
      const thrownKey = hasErrorField
        ? (all[LOG_FIELDS.error] instanceof Error ? LOG_FIELDS.error : undefined)
        : Object.keys(all).find((key) => all[key] instanceof Error && !drop.has(key.toLowerCase()));
      const rest: LogFields = {};
      for (const [key, value] of Object.entries(all)) {
        if (drop.has(key.toLowerCase()) || value === undefined || key === thrownKey || key === LOG_FIELDS.error) continue;
        rest[RESERVED.has(key) ? `field_${key}` : key] = redact(value, 0, drop, phoneContextOf(undefined, key));
      }
      let error: LogFields | undefined;
      if (thrownKey !== undefined) {
        const described = describeError(all[thrownKey]);
        error = { [LOG_FIELDS.errorKind]: described.kind, [LOG_FIELDS.errorMessage]: described.message };
        if (described.stack) error[LOG_FIELDS.errorStack] = described.stack;
      } else if (LEVEL_ORDER[level] >= LEVEL_ORDER.error) {
        // No thrown value: kind from the caller's error class (else the event), stack from the call site.
        const kind = typeof rest.errorClass === "string" && rest.errorClass ? rest.errorClass : event;
        const message = hasErrorField ? describeError(all[LOG_FIELDS.error]).message
          : typeof rest.reason === "string" && rest.reason ? `${event}: ${rest.reason}` : event;
        error = { [LOG_FIELDS.errorKind]: kind, [LOG_FIELDS.errorMessage]: message, [LOG_FIELDS.errorStack]: callSiteStack(kind, message, callSite) };
      } else if (hasErrorField) {
        // A plain `error` value below ERROR (a class name, a short reason) keeps one shape: error.message.
        error = { [LOG_FIELDS.errorMessage]: describeError(all[LOG_FIELDS.error]).message };
      }
      const line: LogFields = {
        [LOG_FIELDS.severity]: severity,
        [LOG_FIELDS.level]: level,
        [LOG_FIELDS.time]: now().toISOString(),
        [LOG_FIELDS.service]: service,
        [LOG_FIELDS.event]: event,
        ...rest,
      };
      if (error) line[LOG_FIELDS.error] = error;
      write(JSON.stringify(line), severity);
    } catch {
      // A log line must never fail the work that logs it.
    }
  };

  const logger: StructuredLogger = {
    debug: function debug(event, fields = {}) { emit("debug", event, fields, debug); },
    info: function info(event, fields = {}) { emit("info", event, fields, info); },
    warn: function warn(event, fields = {}) { emit("warn", event, fields, warn); },
    error: function error(event, fields = {}) { emit("error", event, fields, error); },
    fatal: function fatal(event, fields = {}) { emit("fatal", event, fields, fatal); },
    log: function log(level, event, fields = {}, callSite) { emit(level, event, fields, callSite ?? log); },
  };
  return logger;
}

/** A logger that drops everything, for tests. */
export const silentLogger: StructuredLogger = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, log() {} };

// --- the default logger and Zyg-style functions -----------------------------------------------------------------------

let defaultInstance: StructuredLogger | undefined;

/** The process-wide logger the free functions use (service from ZS_SERVICE). */
export function defaultLogger(): StructuredLogger {
  defaultInstance ??= createLogger();
  return defaultInstance;
}

/** Replaces the process-wide logger (a service's main sets its service name and level once). */
export function setDefaultLogger(logger: StructuredLogger): void {
  defaultInstance = logger;
}

export function logDebug(event: string, fields?: LogFields): void {
  defaultLogger().log("debug", event, fields, logDebug);
}
export function logInfo(event: string, fields?: LogFields): void {
  defaultLogger().log("info", event, fields, logInfo);
}
export function logWarn(event: string, fields?: LogFields): void {
  defaultLogger().log("warn", event, fields, logWarn);
}
/** ERROR with no thrown value: the error fields come from the call site. */
export function logError(event: string, fields?: LogFields): void {
  defaultLogger().log("error", event, fields, logError);
}
/** CRITICAL. Logs only; the caller exits. */
export function logFatal(event: string, fields?: LogFields): void {
  defaultLogger().log("fatal", event, fields, logFatal);
}

/**
 * The way to log a caught error: ERROR with kind, message and stack taken from the thrown value (masked). Pass the app's
 * injected logger as the last argument; without one the default logger writes.
 */
export function logCaughtError(error: unknown, event: string, fields: LogFields = {}, logger?: Logger): void {
  let thrown: Error;
  if (error instanceof Error) thrown = error;
  else {
    const { kind, message } = describeError(error);
    thrown = new Error(message);
    thrown.name = kind;
    (Error as unknown as { captureStackTrace?: StackCapture }).captureStackTrace?.(thrown, logCaughtError);
  }
  (logger ?? defaultLogger()).error(event, { ...fields, error: thrown });
}

/**
 * Re-emits a line some code built itself (a JSON string or an object with `event` and `severity`), so it gets the same
 * reserved fields, masking and error fields. A string that is not a JSON object is logged as `fallback.event` with the
 * masked text in `detail`.
 */
export function logRecord(record: string | LogFields, fallback: { event: string; level?: LogLevel }, logger: StructuredLogger = defaultLogger()): void {
  let fields: LogFields;
  if (typeof record === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record);
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.log(fallback.level ?? "info", fallback.event, { detail: record.trim() }, logRecord);
      return;
    }
    fields = parsed as LogFields;
  } else {
    fields = record;
  }
  const { severity, level, event, ts: _ts, at: _at, time: _time, ...rest } = fields;
  const named = typeof severity === "string" ? LEVEL_OF_SEVERITY[severity.toUpperCase()] : undefined;
  const levelled = typeof level === "string" ? LEVEL_OF_SEVERITY[level.toUpperCase()] : undefined;
  logger.log(named ?? levelled ?? fallback.level ?? "info", typeof event === "string" && event ? event : fallback.event, rest, logRecord);
}
