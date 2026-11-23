import { Daytona, DaytonaConflictError, DaytonaNotFoundError } from "@daytona/sdk";

/** What the provider needs from one sandbox; the live client fills it from the SDK, tests from a fake. */
export interface DaytonaSandboxInfo {
  id: string;
  /** Daytona's state name: `started`, `stopped`, `starting`, `stopping`, `creating`, `error`, ... */
  state: string;
  labels: Record<string, string>;
  /** In state `error`: whether Daytona says the error can be recovered (`recover`); absent when Daytona does not say. */
  recoverable?: boolean;
  /** When Daytona made the sandbox (ISO time); absent when Daytona does not say. */
  createdAt?: string;
}

export interface DaytonaExecResult {
  exitCode: number;
  /** stdout and stderr, combined (the toolbox returns them as one string). */
  output: string;
}

/** `get` and `start` of a sandbox Daytona does not have (deleted). Any other failure of `get` is not proof of absence. */
export class SandboxNotFoundError extends Error {
  constructor(readonly sandboxId: string) { super(`Daytona has no sandbox ${sandboxId}`); this.name = "SandboxNotFoundError"; }
}

/** `start` while the sandbox is in the middle of another state change (stopping, starting): wait for it to settle and start again. */
export class SandboxBusyError extends Error {
  constructor(readonly sandboxId: string) { super(`sandbox ${sandboxId} is changing state`); this.name = "SandboxBusyError"; }
}

export interface SignedUrl {
  url: string;
  token: string;
}

export interface CreateSandboxInput {
  snapshot: string;
  labels: Record<string, string>;
  /** Backstop only: the provider stops idle sandboxes itself. */
  autoStopMinutes: number;
  user: string;
}

/**
 * The slice of the Daytona API the agent server uses. The API key never leaves the implementation: callers hold ids and
 * short-lived signed URLs only.
 */
export interface DaytonaClient {
  findByLabels(labels: Record<string, string>): Promise<DaytonaSandboxInfo[]>;
  get(id: string): Promise<DaytonaSandboxInfo>;
  create(input: CreateSandboxInput): Promise<DaytonaSandboxInfo>;
  start(id: string): Promise<void>;
  /** Brings a sandbox in a recoverable `error` state back to `started` (Daytona refuses `start` of a sandbox in `error`). */
  recover(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  /** Deletes the sandbox and its disk. The provider calls it to retire a sandbox made from an outdated snapshot (`retireIfStale`) and to discard one whose repo import was refused; the gate scripts also clean up their own sandboxes with it. */
  delete(id: string): Promise<void>;
  /** Writes a file through the API-key-authenticated file API, creating its folder, with the given octal mode (for example "0600"). */
  uploadFile(id: string, remotePath: string, content: Buffer, mode: string): Promise<void>;
  /** Reads a file through the API-key-authenticated file API. */
  downloadFile(id: string, remotePath: string): Promise<Buffer>;
  exec(id: string, command: string, options?: { cwd?: string; timeoutS?: number }): Promise<DaytonaExecResult>;
  signedPreviewUrl(id: string, port: number, expiresInSeconds: number): Promise<SignedUrl>;
  expireSignedPreviewUrl(id: string, port: number, token: string): Promise<void>;
  refreshActivity(id: string): Promise<void>;
  /** Replaces the sandbox's labels with `labels` (pass the ones to keep too). */
  setLabels(id: string, labels: Record<string, string>): Promise<void>;
}

export const info = (sandbox: { id: string; state?: unknown; labels?: Record<string, string>; recoverable?: unknown; createdAt?: unknown }): DaytonaSandboxInfo => ({
  id: sandbox.id,
  state: String(sandbox.state ?? "unknown"),
  labels: sandbox.labels ?? {},
  ...(typeof sandbox.recoverable === "boolean" ? { recoverable: sandbox.recoverable } : {}),
  ...(typeof sandbox.createdAt === "string" ? { createdAt: sandbox.createdAt } : {}),
});

export interface SdkClientOptions {
  apiKey: string;
  apiUrl?: string;
  target?: string;
}

export class SdkDaytonaClient implements DaytonaClient {
  private readonly daytona: Daytona;

  constructor(options: SdkClientOptions) {
    this.daytona = new Daytona({ apiKey: options.apiKey, ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}), ...(options.target ? { target: options.target } : {}) });
  }

  async findByLabels(labels: Record<string, string>): Promise<DaytonaSandboxInfo[]> {
    const found: DaytonaSandboxInfo[] = [];
    for await (const sandbox of this.daytona.list({ labels })) found.push(info(sandbox));
    return found;
  }

  async get(id: string): Promise<DaytonaSandboxInfo> {
    try { return info(await this.daytona.get(id)); } catch (error) { throw error instanceof DaytonaNotFoundError ? new SandboxNotFoundError(id) : error; }
  }

  async create(input: CreateSandboxInput): Promise<DaytonaSandboxInfo> {
    const sandbox = await this.daytona.create({ snapshot: input.snapshot, labels: input.labels, user: input.user, autoStopInterval: input.autoStopMinutes });
    return info(sandbox);
  }

  async start(id: string): Promise<void> {
    const sandbox = await this.daytona.get(id).catch((error: unknown) => { throw error instanceof DaytonaNotFoundError ? new SandboxNotFoundError(id) : error; });
    try { await sandbox.start(120); } catch (error) { throw error instanceof DaytonaConflictError ? new SandboxBusyError(id) : error; }
  }

  async recover(id: string): Promise<void> {
    const sandbox = await this.daytona.get(id).catch((error: unknown) => { throw error instanceof DaytonaNotFoundError ? new SandboxNotFoundError(id) : error; });
    try { await sandbox.recover(120); } catch (error) { throw error instanceof DaytonaConflictError ? new SandboxBusyError(id) : error; }
  }

  async stop(id: string): Promise<void> {
    await (await this.daytona.get(id)).stop(120);
  }

  async delete(id: string): Promise<void> {
    await (await this.daytona.get(id)).delete(120);
  }

  async uploadFile(id: string, remotePath: string, content: Buffer, mode: string): Promise<void> {
    const sandbox = await this.daytona.get(id);
    const folder = remotePath.slice(0, remotePath.lastIndexOf("/")) || "/";
    await sandbox.fs.createFolder(folder, "0700");
    await sandbox.fs.uploadFile(content, remotePath);
    await sandbox.fs.setFilePermissions(remotePath, { mode });
  }

  async downloadFile(id: string, remotePath: string): Promise<Buffer> {
    return Buffer.from(await (await this.daytona.get(id)).fs.downloadFile(remotePath));
  }

  async exec(id: string, command: string, options: { cwd?: string; timeoutS?: number } = {}): Promise<DaytonaExecResult> {
    const result = await (await this.daytona.get(id)).process.executeCommand(command, options.cwd, undefined, options.timeoutS);
    return { exitCode: result.exitCode, output: result.result ?? "" };
  }

  async signedPreviewUrl(id: string, port: number, expiresInSeconds: number): Promise<SignedUrl> {
    const signed = await (await this.daytona.get(id)).getSignedPreviewUrl(port, expiresInSeconds);
    return { url: signed.url, token: signed.token };
  }

  async expireSignedPreviewUrl(id: string, port: number, token: string): Promise<void> {
    await (await this.daytona.get(id)).expireSignedPreviewUrl(port, token);
  }

  async refreshActivity(id: string): Promise<void> {
    await (await this.daytona.get(id)).refreshActivity();
  }

  async setLabels(id: string, labels: Record<string, string>): Promise<void> {
    await (await this.daytona.get(id)).setLabels(labels);
  }
}
