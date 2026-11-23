import type { ComposeRunRequest } from "../claude.js";
import { RoleRunError, type RoleRunRecord } from "../engine/run-role.js";
import { ComposeToolRefusedError, PoolNotConfiguredError, TurnAbortedError } from "../types.js";
import { COMPOSE_JSON_SCHEMA, ComposerError, type ComposeRequest, type Composer, type ComposerFailure } from "./composer.js";

/**
 * The production composer (docs/design/organism-outbox.md, part B; decision 2: no owner figures go to another provider). Each moment is one no-tool run of the
 * front's model on the brand's own sandbox, through the turn runner's `compose` (claude.ts), with `COMPOSE_SYSTEM` as its system prompt and the moment's
 * input as its prompt. The answer is the SDK's structured output against `COMPOSE_JSON_SCHEMA`; the outbox validates it again (`validateDecision`). Every
 * failure is a `ComposerError` whose cause is set from a typed value (an error class, the run's subtype), never from a message (LN02).
 */
export interface SandboxComposerDeps {
  /** The turn runner's composer run (`ClaudeTurnRunner.compose`). */
  run(request: ComposeRunRequest): Promise<RoleRunRecord>;
  /** The brand's sandbox host, read fresh with the rule a turn uses; asked only when the moment has no turn (the held tick). */
  hostOf(brandId: string): Promise<string | null>;
}

/** A run's own end, by the subtype `runRole` set (the SDK's result subtype, or its own `timeout`/`aborted`/`no_result`). */
const RUN_ENDS: Record<string, ComposerFailure> = {
  timeout: "timeout",
  aborted: "timeout",
  error_max_structured_output_retries: "no_output",
  error_max_turns: "no_output",
  no_result: "no_output",
};

export class SandboxComposer implements Composer {
  constructor(private readonly deps: SandboxComposerDeps) {}

  async compose(input: ComposeRequest, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new ComposerError("timeout", "aborted before the run");
    let hostId = input.hostId;
    if (hostId === null) {
      try {
        hostId = await this.deps.hostOf(input.key.brandId);
      } catch (error) {
        throw failure("unavailable", "the brand's sandbox host could not be read", error);
      }
      if (!hostId) throw new ComposerError("unavailable", "the brand has no sandbox host");
    }
    let record: RoleRunRecord;
    try {
      record = await this.deps.run({ key: input.key, hostId, system: input.system, prompt: input.prompt, schema: COMPOSE_JSON_SCHEMA, signal, composer: true });
    } catch (error) {
      throw runFailure(error, signal);
    }
    if (record.structuredOutput === undefined) throw new ComposerError("no_output", "the run ended without a structured answer");
    return record.structuredOutput;
  }
}

/** A composer run's failure as a typed `ComposerError` (its cause from the error's class or the run's subtype, never its message, LN02). */
export function runFailure(error: unknown, signal: AbortSignal): ComposerError {
  if (error instanceof ComposerError) return error;
  if (error instanceof ComposeToolRefusedError) return failure("refused", `a tool call was refused (${error.code})`, error);
  if (signal.aborted || error instanceof TurnAbortedError) return failure("timeout", "the run was aborted", error);
  if (error instanceof PoolNotConfiguredError) return failure("unavailable", "no model pool for the run", error);
  if (error instanceof RoleRunError) return failure(RUN_ENDS[error.subtype] ?? "http", `the run ended with ${error.subtype}`, error);
  return failure("http", "the run failed", error);
}

export function failure(cause: ComposerFailure, message: string, error: unknown): ComposerError {
  return Object.assign(new ComposerError(cause, message), { error });
}
