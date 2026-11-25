// Per-session principal claims (kit.brain.claimsFor). One host can serve sessions that act for different people,
// brands or members; the Brain extension reads who it acts for only from the invocation's principal claims. The
// runtime host fixes one principal for the whole host (its kernel port resolves every call's context with it), so a
// claim that differs per session is merged here, after the port resolved the context and before the kernel runs it.
import { AsyncLocalStorage } from "node:async_hooks";

/** The claims a host may set per session. Each comes from the host's own session record, never from model input. */
export interface SessionClaims {
  /** The person the session works for, lower case (the Brain's delegated-mode caller). */
  callerEmail?: string;
  /** The conversation the Brain pins to its first caller; default the session id. */
  conversationId?: string;
  /** Access labels (`staff`, `user:<email>`, `person:<id>` ...). Replaces the host's labels for this session. */
  access?: readonly string[];
  /** The tenant (a brand) the session belongs to. */
  brand?: string;
  /** The member whose private stores the session may read (a direct chat's member). */
  member?: string;
}

const EMAIL = /^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9][a-z0-9.-]{0,127}\.[a-z]{2,24}$/;
const IDENTIFIER = /^[\x21-\x7e]{1,512}$/;
const MAX_LABELS = 64;

/**
 * The claims of one session, checked: unknown keys and malformed values are dropped rather than passed on, so the
 * Brain refuses a call (no caller) instead of acting for a wrong one. Undefined when nothing valid remains.
 */
export function checkedSessionClaims(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const email = typeof input.callerEmail === "string" ? input.callerEmail.trim().toLowerCase() : undefined;
  if (email && EMAIL.test(email)) out.callerEmail = email;
  for (const key of ["conversationId", "brand", "member"] as const) {
    const text = input[key];
    if (typeof text === "string" && IDENTIFIER.test(text)) out[key] = text;
  }
  if (Array.isArray(input.access)) {
    const labels = input.access.filter((label): label is string => typeof label === "string" && IDENTIFIER.test(label)).slice(0, MAX_LABELS);
    out.access = Object.freeze([...labels]);
  }
  return Object.keys(out).length ? Object.freeze(out) : undefined;
}

/** What a call runs with: the session's own claims, or none (a call outside any claimed session). */
type Scope = { readonly claims: Readonly<Record<string, unknown>> | undefined };

interface ExecutingKernel {
  runtimeExec(request: unknown, context: unknown): Promise<unknown>;
}

interface Port {
  execute(request: unknown, context?: { sessionId?: string } & Record<string, unknown>): Promise<unknown>;
}

/**
 * Wires per-session claims into a shared runtime. `port` is the runtime's kernel port (it resolves a call's context with
 * the host principal), `core` the kernel it runs on. Returns the port's `execute` for host callers: each call runs in a
 * scope that names its session's claims (or none), and the kernel's `runtimeExec` merges the scope's claims over the host
 * principal's. A call made from inside a call (a TypeScript block, a fork, the kit's own Brain calls) keeps the scope
 * of the call it came from; a call through `execute` for another session takes that session's.
 */
export function installSessionClaims(input: {
  port: Port;
  core: ExecutingKernel;
  claimsFor: (sessionId: string | undefined) => unknown;
  log?: (line: string) => void;
}): Port["execute"] {
  const scopes = new AsyncLocalStorage<Scope>();
  const runtimeExec = input.core.runtimeExec.bind(input.core);
  input.core.runtimeExec = (request, context) => {
    const claims = scopes.getStore()?.claims;
    if (!claims || !context || typeof context !== "object") return runtimeExec(request, context);
    const resolved = context as { principal?: { claims?: Record<string, unknown> } & Record<string, unknown> };
    const principal = resolved.principal ?? {};
    return runtimeExec(request, {
      ...resolved,
      principal: Object.freeze({ ...principal, claims: Object.freeze({ ...(principal.claims ?? {}), ...claims }) }),
    });
  };
  const execute = input.port.execute.bind(input.port);
  return (request, context) => {
    let claims: Readonly<Record<string, unknown>> | undefined;
    try {
      claims = checkedSessionClaims(input.claimsFor(context?.sessionId));
    } catch (error) {
      // A claims hook that fails leaves the call with none: the Brain then refuses it rather than acting for the host.
      input.log?.(`kit.brain.claimsFor failed for session ${String(context?.sessionId)}: ${String((error as Error)?.message ?? error)}`);
      claims = undefined;
    }
    return scopes.run({ claims }, () => execute(request, context));
  };
}
