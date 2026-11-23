// Extract of zygstinct apps/agent-server/src/claude.ts at 7110e58c8: only ComposeRunRequest, PortAllocator.
import type { Role } from "./engine/roles.js";
import { type ConversationKey } from "./store.js";
import { ComposeToolRefusedError } from "./types.js";

/** Gives each session a loopback port on its VM for the reverse tunnel; two live sessions never share one. */
export class PortAllocator {
  private readonly used = new Set<number>();
  private next: number;

  constructor(
    private readonly low = 41_000,
    private readonly high = 45_999,
  ) {
    this.next = low;
  }

  take(): { port: number; release(): void } {
    for (let i = 0; i <= this.high - this.low; i += 1) {
      const port = this.next;
      this.next = this.next >= this.high ? this.low : this.next + 1;
      if (!this.used.has(port)) {
        this.used.add(port);
        return { port, release: () => void this.used.delete(port) };
      }
    }
    throw new Error("no free tunnel port");
  }
}

/** The composer's question (outbox/sandbox-composer.ts): which conversation and sandbox, its words, and the JSON Schema of its structured answer. */
export interface ComposeRunRequest {
  key: ConversationKey;
  hostId: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  signal: AbortSignal;
  /** The outbox composer's own run takes `OUTBOX_COMPOSER_MODEL`; every other structured run (decide-first, the screen) keeps the fast front model. */
  composer?: boolean;
  /** A model id for this run only (the daily review's reviewer); unset keeps the rule above. */
  model?: string;
  /** Thinking on for this run (the daily review); unset or false keeps it off like every other structured run. */
  thinking?: boolean;
  /** Adaptive thinking at this effort (the session composer's reply and its pass after a send). */
  effort?: Role["effort"];
  /** The session to resume (the composer's own, outbox/session-composer.ts): its transcript is put back on the VM first. Unset: a fresh session. */
  resume?: string;
  /** Tools this run may call, by name (only the composer's pass after a send): run by the chat's runtime on the VM, everything else refused. Unset: none. Needs `gate`. */
  tools?: readonly string[];
  /** The gate a run with tools must carry (the afterthought lane's COMPOSER_REFLECT_TOOLS): see ComposeGate. */
  gate?: ComposeGate;
  /** The DM member a gated run reads for (from the caller's fresh directory read): its staged snapshot's viewer. Required with `gate`. */
  memberId?: string;
  /** The session id as soon as the engine reports it (before the run ends), so a host capability can find the conversation of a running session. */
  onSession?: (sessionId: string) => void;
}

/**
 * What a composer run with tools is held to. `exec` goes into the run's own staged snapshot (the VM runtime refuses every operation off its list for that
 * exec), `disallowedTools` is passed to the engine, and `check` sees every tool call the run makes: a non-null answer (a refusal code) is logged without
 * the input and the run carries on; the VM's composer gate refuses the call and its error tells the model what it can call. A listed browser tool is
 * refused before the run starts (ComposeToolRefusedError).
 */
export interface ComposeGate {
  exec: string;
  disallowedTools: readonly string[];
  check(name: string, input: unknown): string | null;
}
