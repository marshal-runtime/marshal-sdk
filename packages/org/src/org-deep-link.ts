import path from "node:path";

export const ORG_DEEP_LINK_SCHEME = "marshal";

const ORG_SESSION_LINK_PATTERN = /^marshal:\/\/org-session\/([A-Za-z0-9_-]{1,128})$/i;

/**
 * Parses `marshal://org-session/<id>` and nothing else. The whole string is matched, so there is
 * no room for credentials, a port (empty or not), a query or fragment (empty or not), extra or dot
 * path segments, percent-encoding, whitespace or control characters; the id is limited to a
 * conservative character set. The URL comes from outside the app (a chat message, another
 * process), so it is data, never opened or fetched.
 */
export function parseOrgSessionDeepLink(raw: string): { sessionId: string } | null {
  const match = ORG_SESSION_LINK_PATTERN.exec(raw);
  return match ? { sessionId: match[1] } : null;
}

/** Windows and Linux hand a link to the app as a command-line argument. */
export function findOrgSessionDeepLinkInArgv(argv: readonly string[]): string | undefined {
  return argv.find((arg) => parseOrgSessionDeepLink(arg) !== null);
}

export interface ProtocolClientApp {
  setAsDefaultProtocolClient(scheme: string, execPath?: string, args?: string[]): boolean;
}

/**
 * Registers this app as the OS handler for `marshal://`. Under `electron:dev` the running binary
 * is the generic Electron executable, so the OS must be told to start it with the app path too.
 */
export function registerOrgDeepLinkProtocol(
  app: ProtocolClientApp,
  runtime: { defaultApp: boolean; execPath: string; argv: readonly string[] },
): boolean {
  if (runtime.defaultApp) {
    const entry = runtime.argv[1];
    if (!entry) return false;
    return app.setAsDefaultProtocolClient(ORG_DEEP_LINK_SCHEME, runtime.execPath, [
      path.resolve(entry),
    ]);
  }
  return app.setAsDefaultProtocolClient(ORG_DEEP_LINK_SCHEME);
}

/**
 * Whether to register as the OS handler. Not in mock/E2E runs (they must not rewrite the machine's
 * handler), and not when `MARSHAL_SKIP_PROTOCOL_REGISTRATION=1`. Unpackaged dev builds do register:
 * `pnpm electron:dev` is how links are exercised during development, and the dev registration
 * (execPath + app path) is replaced by the installed app's the next time it registers.
 */
export function shouldRegisterOrgDeepLinkProtocol(options: {
  mockMode: boolean;
  env: Readonly<Record<string, string | undefined>>;
}): boolean {
  return (
    !options.mockMode &&
    options.env.MARSHAL_E2E !== "1" &&
    options.env.MARSHAL_SKIP_PROTOCOL_REGISTRATION !== "1"
  );
}

export interface OrgDeepLinkRouterDeps {
  /** Whether this computer has a session with that id (read from the local session store). */
  hasLocalSession: (sessionId: string) => boolean;
  /** Brings the main window forward. */
  focus: () => void;
  /** Tells the renderer a link is waiting; it then asks for it with `takePending`. */
  notify: () => void;
}

/**
 * Holds the latest valid link until the renderer takes it, so a link that arrives before the
 * window has loaded (cold start from a click) is not lost.
 */
export class OrgDeepLinkRouter {
  private pending: string | null = null;

  constructor(private readonly deps: OrgDeepLinkRouterDeps) {}

  /** Returns whether the link was accepted. Anything that does not parse is dropped. */
  handle(raw: string): boolean {
    const parsed = parseOrgSessionDeepLink(raw);
    if (!parsed) return false;
    this.pending = parsed.sessionId;
    this.deps.focus();
    this.deps.notify();
    return true;
  }

  takePending(): { success: true; sessionId: string | null; local: boolean } {
    const sessionId = this.pending;
    this.pending = null;
    return {
      success: true,
      sessionId,
      local: sessionId !== null && this.deps.hasLocalSession(sessionId),
    };
  }
}
