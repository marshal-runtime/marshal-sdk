/**
 * Live compile for `marshal-ui` blocks the assistant streams inline. Frames
 * go through the same ARU compiler as `runtimeShowUi` views (capability
 * `ui.compile.preview`: identical bundling, CSP and bootstrap, nothing
 * persisted), so a streamed card behaves like an authored view. Promotion
 * hands the finished source to `runtimeShowUi` unchanged.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { createLogger } from "../../common/marshal-logger";
import {
  STREAMING_UI_MAX_SOURCE_BYTES,
  type RuntimeUiStreamFrame,
  type RuntimeUiStreamFrameRequest,
  type RuntimeUiStreamPromoteRequest,
  type RuntimeUiStreamPromoteResult,
} from "../../common/streaming-ui";
import { streamingUiCandidates } from "../../common/streaming-ui-normalize";
import { secureAtomicWriteFileSync } from "../platform-security";
import type { MarshalRuntimeApi, MarshalRuntimeScope } from "./contracts";

const log = createLogger("StreamingUi");

const SCRATCH_SUBDIR = [".agent", "ui", "stream"] as const;
const CARD_KEY = /^[A-Za-z0-9_-]{1,96}$/;
const PREVIEW_TITLE = "Streaming UI";

export class StreamingUiError extends Error {
  constructor(
    readonly code: "invalid-request" | "permission-denied" | "operation-failed" | "not-found",
    message: string,
  ) {
    super(message);
  }
}

export interface StreamingUiServiceOptions {
  readonly api: MarshalRuntimeApi;
  readonly resolveScope: (
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<MarshalRuntimeScope | null>;
  /** The root `ui.compile` resolves entry paths against. */
  readonly resolveWorkspacePath: () => Promise<string>;
  /** Runs the `runtimeShowUi` tool for a session and returns its JSON result. */
  readonly showUi: (
    args: Readonly<Record<string, unknown>>,
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<string>;
  /** Called when a live-streamed block's finished source fails to compile. */
  readonly onFinalFailure?: (failure: {
    readonly sessionId: string;
    readonly sourceDigest: string;
    readonly message: string;
  }) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function previewFrom(output: unknown): { html: string; htmlDigest: string } | undefined {
  const preview = isRecord(output) ? output.preview : undefined;
  if (
    isRecord(preview) &&
    typeof preview.html === "string" &&
    typeof preview.htmlDigest === "string"
  ) {
    return { html: preview.html, htmlDigest: preview.htmlDigest };
  }
  return undefined;
}

function assertSource(source: unknown): asserts source is string {
  if (typeof source !== "string" || source.trim() === "") {
    throw new StreamingUiError("invalid-request", "Streaming UI source is empty.");
  }
  if (Buffer.byteLength(source) > STREAMING_UI_MAX_SOURCE_BYTES) {
    throw new StreamingUiError("invalid-request", "Streaming UI source is too large.");
  }
}

export function createStreamingUiService(options: StreamingUiServiceOptions) {
  const requireScope = async (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeScope> => {
    const scope = await options.resolveScope(sessionId, signal);
    if (!scope) throw new StreamingUiError("not-found", "Session scope is unavailable.");
    return scope;
  };

  const compileOne = async (
    scope: MarshalRuntimeScope,
    entryPath: string,
    signal?: AbortSignal,
  ): Promise<{ html: string; htmlDigest: string }> => {
    const response = await options.api.invoke({
      ...scope,
      capability: "ui.compile.preview",
      input: { entryPath, title: PREVIEW_TITLE },
      idempotencyKey: `stream-preview:${randomUUID()}`,
      // Frames compile automatically as text arrives: never raise approval cards.
      approvalPolicy: "forbid",
      signal,
    });
    if (!response.ok) {
      const code =
        response.error.code === "permission-denied" || response.error.code === "approval-required"
          ? "permission-denied"
          : "operation-failed";
      throw new StreamingUiError(code, response.error.message);
    }
    const preview = previewFrom(response.value.output);
    if (!preview) throw new StreamingUiError("operation-failed", "Compile returned no document.");
    return preview;
  };

  return {
    async compileFrame(
      request: RuntimeUiStreamFrameRequest,
      signal?: AbortSignal,
    ): Promise<RuntimeUiStreamFrame> {
      if (!CARD_KEY.test(request.cardKey)) {
        throw new StreamingUiError("invalid-request", "Invalid streaming card key.");
      }
      assertSource(request.source);
      const scope = await requireScope(request.sessionId, signal);
      const workspacePath = await options.resolveWorkspacePath();
      const directory = path.join(workspacePath, ...SCRATCH_SUBDIR);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const fileName = `${request.cardKey}.tsx`;
      const absolute = path.join(directory, fileName);
      const entryPath = [...SCRATCH_SUBDIR, fileName].join("/");
      const attempts = request.complete ? [request.source] : streamingUiCandidates(request.source);
      let firstError: StreamingUiError | undefined;
      try {
        for (const [index, candidate] of attempts.entries()) {
          secureAtomicWriteFileSync(absolute, candidate, { mode: 0o600 });
          try {
            // eslint-disable-next-line no-await-in-loop -- candidates are tried best-first, one compile at a time
            const preview = await compileOne(scope, entryPath, signal);
            return { ...preview, repaired: index > 0 || candidate !== request.source };
          } catch (error) {
            if (!(error instanceof StreamingUiError)) throw error;
            if (error.code === "permission-denied") throw error;
            firstError ??= error;
          }
        }
      } finally {
        rmSync(absolute, { force: true });
      }
      const failure =
        firstError ?? new StreamingUiError("operation-failed", "Nothing to compile in this frame.");
      if (request.complete && request.reportFailure === true) {
        options.onFinalFailure?.({
          sessionId: request.sessionId,
          sourceDigest: createHash("sha256").update(request.source).digest("hex").slice(0, 16),
          message: failure.message,
        });
      }
      throw failure;
    },

    async promote(
      request: RuntimeUiStreamPromoteRequest,
      signal?: AbortSignal,
    ): Promise<RuntimeUiStreamPromoteResult> {
      assertSource(request.source);
      await requireScope(request.sessionId, signal);
      const raw = await options.showUi(
        {
          tsx: request.source,
          title: request.title.slice(0, 256) || "Streamed UI",
          placement: "chat-tab",
        },
        request.sessionId,
        signal,
      );
      let result: unknown;
      try {
        // SF-4: tool result written by runShowUi in this process, never user input
        result = JSON.parse(raw) as unknown;
      } catch {
        log.warn("runtimeShowUi returned a non-JSON result");
        throw new StreamingUiError("operation-failed", "Opening the view failed.");
      }
      if (isRecord(result) && result.ok === true && typeof result.instanceId === "string") {
        return { instanceId: result.instanceId };
      }
      const message =
        isRecord(result) && isRecord(result.error) && typeof result.error.message === "string"
          ? result.error.message
          : isRecord(result) && Array.isArray(result.diagnostics)
            ? result.diagnostics
                .map((entry) => (isRecord(entry) ? String(entry.message) : ""))
                .filter(Boolean)
                .join("\n")
            : "Opening the view failed.";
      throw new StreamingUiError("operation-failed", message || "Opening the view failed.");
    },
  };
}

export type StreamingUiService = ReturnType<typeof createStreamingUiService>;
