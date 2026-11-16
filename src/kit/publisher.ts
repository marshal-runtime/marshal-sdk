/**
 * Shares each session to the Brain's session index after its turns end (`kit.sessions.publish`). One upload per
 * session at a time; a turn that ends while one is in flight queues exactly one more, so the index ends with the
 * latest transcript. Failures are logged, never thrown: a run must not fail because the index is down.
 */
export class SessionPublisher {
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly results = new Map<string, { at: string; ok: boolean; status?: string; error?: string }>();

  constructor(
    private readonly share: (sessionId: string) => Promise<unknown>,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  private closed = false;

  schedule(sessionId: string): void {
    if (this.closed) return;
    if (this.running.has(sessionId)) {
      this.again.add(sessionId);
      return;
    }
    const run = this.publish(sessionId).finally(() => {
      this.running.delete(sessionId);
      if (this.again.delete(sessionId)) this.schedule(sessionId);
    });
    this.running.set(sessionId, run);
  }

  /** Waits until every scheduled upload, and any it queued, has finished. */
  async flush(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()]);
  }

  /** Finishes every upload, then takes no more: what is scheduled after this has no Brain left to reach. */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  /** The last upload of each session: when, and whether the Brain took it. */
  status(): Record<string, { at: string; ok: boolean; status?: string; error?: string }> {
    return Object.fromEntries(this.results);
  }

  private async publish(sessionId: string): Promise<void> {
    const at = new Date().toISOString();
    try {
      const answer = (await this.share(sessionId)) as { status?: unknown; details?: { cloud?: { status?: unknown } } } | undefined;
      const status = typeof answer?.status === "string" ? answer.status : typeof answer?.details?.cloud?.status === "string" ? answer.details.cloud.status : undefined;
      this.results.set(sessionId, { at, ok: true, ...(status ? { status } : {}) });
      this.log(`published session ${sessionId} to the Brain's session index${status ? ` (${status})` : ""}`);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
      this.results.set(sessionId, { at, ok: false, error: message });
      this.log(`publishing session ${sessionId} to the Brain failed: ${message}`);
    }
  }
}
