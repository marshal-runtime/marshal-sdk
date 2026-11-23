// Extract of zygstinct apps/agent-server/src/sandbox/brand-link.ts at 7110e58c8: only BrandLinks.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { Logger } from "../logger.js";
import type { SshTarget } from "./ssh-target.js";

/** The Cloud SQL private IP and port a sandbox's 127.0.0.1:15432 reaches (DESIGN 5.4: never the cloud-sql-proxy sidecar). */
export interface BrandLinkForward {
  remotePort: number;
  targetHost: string;
  targetPort: number;
}

export interface BrandLinkOptions {
  /** ssh arguments up to and including `user@host`, from `SshRunner.baseArgs(user, target, false)`; `key` is the brand id the link was opened for. */
  sshArgs(target: SshTarget, key: string): string[];
  forward: BrandLinkForward;
  logger: Logger;
  spawn?: (command: string, args: string[]) => ChildProcess;
  /** Restart delays: first, then doubling up to the cap. */
  backoffMs?: { first: number; max: number };
  setTimer?: (fn: () => void, ms: number) => { unref?(): unknown };
}

interface Link {
  key: string;
  target: SshTarget;
  child: ChildProcess | null;
  closed: boolean;
  restarts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * One supervised SSH connection per running sandbox that carries `-R 127.0.0.1:<remotePort>:<cloudSqlIp>:5432`, so the sandbox's
 * Postgres client reaches the brand's Cloud SQL without the sandbox holding a credential or a route. A chat session keeps only its own
 * model-proxy `-R`. The link restarts itself with backoff while it is open; callers hold leases while a turn uses the sandbox, and
 * the idle stop in the provider never fires while a lease is held.
 */
export class BrandLinks {
  private readonly links = new Map<string, Link>();
  /** The lease count of a brand's sandbox, outside the Link: a replaced link keeps it and every release closure handed out keeps pointing at it. */
  private readonly held = new Map<string, { leases: number }>();
  /** Who holds each outstanding lease (the call site's frames and when it was taken), so a lease that is never given back can be named (see `holders`). */
  private readonly holdersOf = new Map<string, Map<object, { at: number; where: string }>>();
  private readonly spawn: (command: string, args: string[]) => ChildProcess;

  constructor(private readonly options: BrandLinkOptions) {
    this.spawn = options.spawn ?? ((command, args) => nodeSpawn(command, args, { stdio: ["ignore", "ignore", "pipe"] }));
  }

  /** Opens the link of a sandbox, or keeps the one that is up; a changed target (a restart gave a new alias) replaces it. */
  open(key: string, target: SshTarget): void {
    const existing = this.links.get(key);
    if (existing && !existing.closed && JSON.stringify(existing.target) === JSON.stringify(target)) return;
    if (existing) this.close(key, true);
    const link: Link = { key, target, child: null, closed: false, restarts: 0, timer: null };
    this.links.set(key, link);
    this.start(link);
  }

  isOpen(key: string): boolean {
    const link = this.links.get(key);
    return Boolean(link && !link.closed && link.child && link.child.exitCode === null && !link.child.killed);
  }

  /** Marks the sandbox as in use until the returned function is called (once). */
  lease(key: string): () => void {
    if (!this.links.has(key)) return () => undefined;
    let record = this.held.get(key);
    if (!record) { record = { leases: 0 }; this.held.set(key, record); }
    const own = record;
    own.leases += 1;
    const token = {};
    let holders = this.holdersOf.get(key);
    if (!holders) { holders = new Map(); this.holdersOf.set(key, holders); }
    holders.set(token, { at: Date.now(), where: (new Error().stack ?? "").split("\n").slice(2, 7).map((line) => line.trim().replace(/^at\s+/, "").replace(/\(?file:\/\/\/app\/dist\//, "(")).join(" < ") });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      own.leases = Math.max(0, own.leases - 1);
      holders?.delete(token);
    };
  }

  leases(key: string): number {
    return this.held.get(key)?.leases ?? 0;
  }

  /** The oldest outstanding leases of a sandbox (age and the call stack that took each), for the log that says why an idle stop did not run. */
  holders(key: string, limit = 3): { ageMs: number; where: string }[] {
    const now = Date.now();
    return [...(this.holdersOf.get(key)?.values() ?? [])].sort((a, b) => a.at - b.at).slice(0, limit).map((holder) => ({ ageMs: now - holder.at, where: holder.where.slice(0, 400) }));
  }

  /** Closes the link and forgets its leases; `replacing` (a new target takes over) keeps them. */
  close(key: string, replacing = false): void {
    const link = this.links.get(key);
    if (!replacing) { this.held.delete(key); this.holdersOf.delete(key); }
    if (!link) return;
    link.closed = true;
    if (link.timer) clearTimeout(link.timer);
    link.child?.kill("SIGTERM");
    this.links.delete(key);
  }

  closeAll(): void {
    for (const key of [...this.links.keys()]) this.close(key);
  }

  private start(link: Link): void {
    const { forward } = this.options;
    const args = [
      "-N",
      "-T",
      "-o", "ExitOnForwardFailure=yes",
      "-R", `127.0.0.1:${forward.remotePort}:${forward.targetHost}:${forward.targetPort}`,
      ...this.options.sshArgs(link.target, link.key),
    ];
    const child = this.spawn("ssh", args);
    link.child = child;
    let exited = false;
    const onExit = (code: number | null): void => {
      if (exited) return;
      exited = true;
      if (link.closed) return;
      const { first, max } = this.options.backoffMs ?? { first: 1000, max: 30_000 };
      const delay = Math.min(max, first * 2 ** link.restarts);
      link.restarts += 1;
      this.options.logger.warn("brand_link.exited", { key: link.key, exitCode: code, restartInMs: delay });
      const set = this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
      link.timer = set(() => {
        link.timer = null;
        if (!link.closed) this.start(link);
      }, delay) as ReturnType<typeof setTimeout>;
      link.timer.unref?.();
    };
    child.on("exit", onExit);
    child.on("error", () => onExit(null));
    // A link that stays up resets its backoff.
    const stable = setTimeout(() => { if (!exited) link.restarts = 0; }, 60_000);
    stable.unref();
    child.stderr?.on("data", () => undefined);
  }
}
