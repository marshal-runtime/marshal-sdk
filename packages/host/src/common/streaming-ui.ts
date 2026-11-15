/** Fence info string that marks assistant TSX to render live as the message streams. */
export const STREAMING_UI_FENCE = "marshal-ui";

/** Largest TSX body the live-compile path accepts; longer sources stay as text. */
export const STREAMING_UI_MAX_SOURCE_BYTES = 128 * 1024;

export interface RuntimeUiStreamScope {
  readonly sessionId: string;
  readonly workspaceName: string;
}

export interface RuntimeUiStreamFrameRequest extends RuntimeUiStreamScope {
  /** Stable per-card key; keeps scratch files and in-flight frames apart. */
  readonly cardKey: string;
  readonly source: string;
  /** True for the finished message: the exact source is compiled, with no tail repair. */
  readonly complete: boolean;
  /**
   * Set on the final frame of a card that watched the block stream in live: a
   * failed compile is then reported to the session. Reloads of old messages
   * never set it, so history does not wake the agent.
   */
  readonly reportFailure?: boolean;
}

export interface RuntimeUiStreamFrame {
  /** MCP App document produced by the same compiler as `runtimeShowUi` views. */
  readonly html: string;
  readonly htmlDigest: string;
  /** True when the frame compiled from a repaired prefix, not the exact source. */
  readonly repaired: boolean;
}

export interface RuntimeUiStreamPromoteRequest extends RuntimeUiStreamScope {
  readonly source: string;
  readonly title: string;
}

export interface RuntimeUiStreamPromoteResult {
  readonly instanceId: string;
}
