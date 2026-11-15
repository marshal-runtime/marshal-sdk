/**
 * `runtimeShowUi` — one host tool call that compiles, renders, and places a
 * React UI, instead of the four separate `ui.compile` / `ui.render` /
 * `ui.application.open` / viewport-declaration steps an agent would
 * otherwise chain by hand. It writes the source to a content-addressed file
 * under the SAME runtime workspace root `ui.compile` already resolves
 * `entryPath` against (see `resolveWorkspacePath` wiring in main.ts, mirrors
 * `hostWorkspacePath` / `marshalRuntimeWorkspaceRoot`), then drives the real
 * `ui.compile` -> `ui.render` -> `ui.application.open` capabilities through
 * the SAME `MarshalRuntimeApi.invoke()` path `runtimeInvoke` uses, so every
 * existing permission check, idempotency, and receipt behavior applies
 * unchanged. It never talks to provider internals directly.
 *
 * Phone and desktop views: see show-ui-views.ts.
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { createLogger } from "../../common/marshal-logger";
import type { MarshalUiViewport } from "../../common/runtime-ui-viewports";
import type { RuntimeTool, RuntimeToolInvocation } from "../backend/runtime-contract";
import { secureAtomicWriteFileSync } from "../platform-security";
import { RUNTIME_UI_LIBRARIES_TOOL_NOTE } from "../prompt/sections/runtime-ui-libraries";
import type { MarshalRuntimeApi, MarshalRuntimeScope } from "./contracts";
import { BUILTIN_UI_COMPONENT_NAMES } from "./show-ui-components";
import { importViewFile, ShowUiFileError, type ShowUiFileAccess } from "./show-ui-files";
import {
  NEXT_AFTER_SHOWN,
  NEXT_AFTER_UPDATED,
  nextAfterFailure,
  resolveRollbackTarget,
  revisionSummary,
  type ShowUiRenderProbe,
  type ShowUiRenderVerdict,
  type ShowUiRevisionLedger,
} from "./show-ui-health";
import {
  findPriorAuthoredView,
  placementDigestFields,
  placementInput,
  SHOW_UI_PLACEMENT_PARAMETERS,
} from "./show-ui-placement";
import {
  declaredViewports,
  parseViewsArgs,
  planSourceFiles,
  readShowUiRecord,
  renderProps,
  type ShowUiRequestedViews,
  type ShowUiViewPaths,
  type ShowUiViews,
  validateViewProps,
  viewsFromSourceFiles,
  writeShowUiRecord,
} from "./show-ui-views";

const log = createLogger("RuntimeShowUi");

export const RUNTIME_SHOW_UI_TOOL_NAME = "runtimeShowUi" as const;

/** Reserved owner for agent-authored renders (matches RESERVED_AUTHORED_UI_OWNER_ID in ui-providers.ts). */
const RESERVED_AUTHORED_OWNER = "marshal.react-ui";
const MAX_TSX_BYTES = 512 * 1024;
/**
 * Every runtimeShowUi view gets the `marshal` client (sendMessage,
 * updateModelContext, subscribe) through an application manifest that declares
 * no actions, tools or extra display modes, so nothing prompts for consent.
 */
export const SHOW_UI_DEFAULT_APPLICATION = Object.freeze({
  version: "1.0.0",
  presentationModes: ["inline"],
  actions: [],
  tools: [],
});
const UI_WORKSPACE_SUBDIR = [".agent", "ui"] as const;

export type ShowUiWorkspaceResolver = (
  scope: MarshalRuntimeScope,
  signal?: AbortSignal,
) => Promise<string>;

export interface ShowUiToolOptions {
  readonly api: MarshalRuntimeApi;
  readonly resolveScope: (
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<MarshalRuntimeScope | null>;
  /** Resolves the SAME physical workspace root ui.compile's entryPath is read against. */
  readonly resolveWorkspacePath?: ShowUiWorkspaceResolver;
  /** The client (phone or desktop) the session's latest turn came from. */
  readonly resolveClientViewport?: (sessionId: string) => MarshalUiViewport;
  /** What a `file` source may read for this session: its workspace and granted folders. */
  readonly resolveFileAccess?: (sessionId: string) => ShowUiFileAccess;
  /** Called with a placed view and its live source files so edits can be pushed to it. */
  readonly onSourcesLive?: (instanceId: string, files: readonly string[]) => void;
  /** Decides whether a freshly placed view really paints (hidden observer window + health reports). */
  readonly probeRender?: ShowUiRenderProbe;
  /** Per-view revision history: a failed candidate never replaces a working revision. */
  readonly revisions?: ShowUiRevisionLedger;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("runtimeShowUi arguments must be an object.");
  }
  return Object.fromEntries(Object.entries(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isJsonErrorCode(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

interface StageError {
  readonly code: string;
  readonly message: string;
  readonly approval?: unknown;
}

interface CompileDiagnostic {
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

type ShowUiResult =
  | {
      readonly ok: true;
      readonly instanceId: string;
      readonly renderId: string;
      readonly componentId: string;
      readonly surface: string;
      /** Absolute, live source file per viewport: editing one recompiles the open view. */
      readonly sources: ShowUiViewPaths;
      readonly viewports: readonly MarshalUiViewport[];
      /** The view whose render this call swapped in place (same id and placement). */
      readonly replaced?: string;
      /** Ledger id of the revision this call made live. */
      readonly revision?: string;
      /** `unverified` when no probe or mount signal could confirm the first paint. */
      readonly painted: boolean | "unverified";
      readonly next: string;
    }
  | {
      readonly ok: true;
      readonly instanceId: string;
      readonly renderId: string;
      readonly surface: string;
      readonly sources?: ShowUiViewPaths;
      readonly rolledBackTo: string;
      readonly revisions: ReturnType<typeof revisionSummary>;
      readonly next: string;
    }
  | {
      readonly ok: true;
      readonly instanceId: string;
      readonly revisions: ReturnType<typeof revisionSummary>;
      readonly next: string;
    }
  | {
      readonly ok: false;
      readonly stage: "runtime";
      readonly diagnostics: readonly { readonly message: string; readonly stack?: string }[];
      readonly instanceId: string;
      /** The earlier working revision put back on screen after this candidate failed. */
      readonly restored?: string;
      readonly next: string;
    }
  | {
      readonly ok: false;
      readonly stage: "props";
      readonly error: { readonly message: string };
    }
  | {
      readonly ok: false;
      readonly stage: "source";
      readonly error: StageError;
    }
  | {
      readonly ok: false;
      readonly stage: "compile";
      readonly diagnostics: readonly CompileDiagnostic[];
      readonly instanceId?: string;
      /** Set when an earlier working revision is still showing. */
      readonly kept?: string;
      readonly next?: string;
    }
  | {
      readonly ok: false;
      readonly stage: "compile" | "render" | "open" | "update";
      readonly error: StageError;
    };

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "ui";
}

/** Deterministic path so re-showing identical content (a built-in, or the same TSX) reuses the same compiled artifact. */
function contentAddressedEntryPath(label: string, source: string): string {
  const hash = createHash("sha256").update(source, "utf8").digest("hex").slice(0, 12);
  return [...UI_WORKSPACE_SUBDIR, `${slugify(label)}-${hash}.tsx`].join("/");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function defaultIdempotencyKey(input: Readonly<Record<string, unknown>>): string {
  const digest = createHash("sha256").update(stableStringify(input)).digest("hex").slice(0, 32);
  return `runtimeShowUi:${digest}`;
}

const DIAGNOSTIC_LINE = /^(.*?):(\d+):(\d+):\s*(?:error|warning)\s*:\s*(.*)$/i;

/**
 * The runtime's MarshalRuntimeApiError flattens every failure to {code,
 * message} (see runtime-api-error.ts) — no structured diagnostics array
 * reaches this tool. esbuild's own thrown message is normally formatted as
 * `file:line:col: ERROR: text` per error, so this recovers line/column on a
 * best-effort basis; a message that doesn't match that shape still yields
 * one diagnostic with just the text.
 */
function parseCompileDiagnostics(message: string): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (const line of message.split(/\r?\n/)) {
    const match = DIAGNOSTIC_LINE.exec(line.trim());
    if (match) {
      const [, , lineText, columnText, text] = match;
      diagnostics.push({
        message: text.trim() || line.trim(),
        line: Number(lineText),
        column: Number(columnText),
      });
    }
  }
  if (diagnostics.length === 0) {
    diagnostics.push({ message: message.trim() || "React UI compilation failed." });
  }
  return diagnostics;
}

function stageError(error: unknown): StageError {
  const source = isRecord(error) ? error : {};
  return {
    code: isJsonErrorCode(source.code) ? source.code : "operation-failed",
    message:
      typeof source.message === "string" && source.message
        ? source.message
        : "Marshal Runtime operation failed.",
    ...(source.approval !== undefined ? { approval: source.approval } : {}),
  };
}

/**
 * ui.application.open/update/etc. report success or failure through a
 * NESTED `{ok, value|error}` envelope inside the capability's own `output`
 * (RuntimeUiController.run(), see ui-controller.ts) — the outer
 * MarshalRuntimeApi.invoke() call itself reports `ok: true` as long as the
 * capability didn't throw. A caller that only checks the outer result would
 * misreport a denied/conflicting open as success.
 */
function unwrapUiCommandOutput(
  output: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: StageError } {
  const outer = isRecord(output) ? output : {};
  if (outer.ok === true && isRecord(outer.value)) return { ok: true, value: outer.value };
  if (outer.ok === false) {
    return { ok: false, error: stageError(isRecord(outer.error) ? outer.error : {}) };
  }
  return {
    ok: false,
    error: { code: "operation-failed", message: "Marshal Runtime UI response was malformed." },
  };
}

function extractComponentId(output: unknown): string | undefined {
  const component = isRecord(output) ? output.component : undefined;
  return isRecord(component) && typeof component.id === "string" ? component.id : undefined;
}

function extractRenderId(output: unknown): string | undefined {
  const render = isRecord(output) ? output.render : undefined;
  return isRecord(render) && typeof render.id === "string" ? render.id : undefined;
}

function extractInstance(
  value: Record<string, unknown>,
): { instanceId: string; surface?: string } | undefined {
  const instance = value.instance;
  if (!isRecord(instance) || typeof instance.instanceId !== "string") return undefined;
  return {
    instanceId: instance.instanceId,
    surface: typeof instance.surface === "string" ? instance.surface : undefined,
  };
}

const FILE_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 4_096,
  description:
    "Path to a .tsx/.ts/.jsx/.js entry file (absolute or relative to the session workspace). Its relative imports come with it.",
};

const VIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    tsx: { type: "string", minLength: 1, maxLength: MAX_TSX_BYTES },
    file: FILE_SCHEMA,
    component: { type: "string", enum: [...BUILTIN_UI_COMPONENT_NAMES] },
  },
};

export function createShowUiTool(options: ShowUiToolOptions): RuntimeTool {
  return {
    name: RUNTIME_SHOW_UI_TOOL_NAME,
    description:
      'Compile, render, and place a React UI in ONE call — the cheap alternative to chaining ui.compile/ui.render/ui.application.open by hand. Use it without being asked when a view serves the user better than chat text. Any table longer than 15 rows belongs here as a sortable data-table, with only the conclusion and top rows in chat. Also: data they will sort or filter, a live status board for minutes-long work, a change set to review, metrics to compare, or a custom visual that explains the answer. Small results stay markdown tables. Give each client its view with `views: {desktop?: {tsx}|{file}|{component}, mobile?: {tsx}|{file}|{component}}`, or pass one `tsx`/`file`/`component` with `viewports` (default: the client this turn came from). Prefer `file` over `tsx` for anything long or split across files: write the files with your file tools, then pass the entry file\'s path (absolute or relative to the session workspace; it must be in the workspace or a granted folder). Its relative imports are followed and copied with it, so several files need only the entry\'s path. Built-in components: data-table, key-value, checklist, diff-list. A view only renders on the viewports it was given. Placement: `placement` is chat-tab (a tab beside Chat), side, bottom, floating, card (default; a permanent card in the conversation), transient (floats above the chat, not saved; closes on close, dismiss, or `timeoutMs`), or fullscreen; host seats: overlay (click-through layer over the session frame; anchor, width, height, interactive, timeoutMs), tool-result (needs toolName; the view gets props {toolName, input, output, status, callId}), chat-header (needs label, mode popover|widget). Every call opens its own tab or card; nothing is overwritten. To put UI inside your own message, call this with `slot` (placement card) first, then write `<!--ui:<slot>-->` on its own line in your final reply, after your last tool call; the card stays hidden until the marker is on screen, and text written before a tool call may never reach the message; `afterMessageId` places a card after a given message instead. Pass `instanceId` (or reuse the same `slot`) to replace an open view in place: it keeps its id and exact placement, and omitted title, props, and views are kept from it, so `{instanceId, views: {mobile: {tsx}}}` adds a phone view and a fixed render lands where the broken one was. The result\'s `sources` are the absolute, live source files of each view: for a small change (a color, a label, a layout fix) Edit that file instead of resending the view; the open view recompiles as soon as the file is saved with no further call, and a broken edit keeps the last good version. A `file` view\'s `sources` entry is a copy taken at call time, so edits to your original need `{instanceId, file}` to show. `replaced` names the view a call refreshed in place. A view that throws, rejects, or fails to compile comes back as `{ok:false, stage:"runtime"|"compile", diagnostics, instanceId, next}`: fix the source and call again with that `instanceId` instead of opening a new view. A refresh whose new revision fails never replaces the working one (the previous revision is restored). `rollback` with `instanceId` restores an earlier revision; `ok` results carry a `next` line to follow. Every view receives a `marshal` prop: `marshal.sendMessage({role:"user", content:[{type:"text", text}]})` sends a message into this session (attributed to the view, ≤4 KB, rate-limited, untrusted), `marshal.updateModelContext({content:[{type:"text", text}]})` replaces the view\'s line in your per-turn view list, and `localStorage` persists per view; read it with the `ui.view.state.get {instanceId}` capability. Call `ui.surfaces.describe` first for unfamiliar UI work. ' +
      RUNTIME_UI_LIBRARIES_TOOL_NOTE,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 256 },
        views: {
          type: "object",
          additionalProperties: false,
          properties: { desktop: VIEW_SCHEMA, mobile: VIEW_SCHEMA },
        },
        tsx: { type: "string", minLength: 1, maxLength: MAX_TSX_BYTES },
        file: FILE_SCHEMA,
        component: { type: "string", enum: [...BUILTIN_UI_COMPONENT_NAMES] },
        viewports: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: ["desktop", "mobile"] },
        },
        props: { type: "object" },
        ...SHOW_UI_PLACEMENT_PARAMETERS,
        summary: { type: "string", minLength: 1, maxLength: 4_000 },
        instanceId: { type: "string", minLength: 1, maxLength: 128 },
        rollback: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description:
            'With instanceId: "previous" puts the view\'s earlier working revision back, a revision id like "r2" restores that one, "list" shows the revisions. No source needed.',
        },
        idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
      },
    },
    supportsAbortSignal: true,
    eagerLoad: true,
    handler: async (rawArgs, invocation) => {
      const result = await runShowUi(options, record(rawArgs), invocation);
      return JSON.stringify(result);
    },
  };
}

/** Imports each named file once, so one file serving both viewports stays one source. */
async function importFileViews(
  requested: ShowUiRequestedViews,
  access: ShowUiFileAccess,
  compileRoot: string,
): Promise<ShowUiViews> {
  const imported = new Map<string, string>();
  const views: ShowUiViews = {};
  for (const viewport of declaredViewports(requested)) {
    const spec = requested[viewport];
    if (spec?.kind !== "file-request") {
      views[viewport] = spec;
      continue;
    }
    let importedPath = imported.get(spec.file);
    if (importedPath === undefined) {
      // eslint-disable-next-line no-await-in-loop -- one file's copy finishes before the next starts
      importedPath = await importViewFile(spec.file, access, compileRoot);
      imported.set(spec.file, importedPath);
    }
    views[viewport] = { kind: "file", path: importedPath };
  }
  return views;
}

async function runShowUi(
  options: ShowUiToolOptions,
  args: Readonly<Record<string, unknown>>,
  invocation: RuntimeToolInvocation,
): Promise<ShowUiResult> {
  const instanceId = optionalString(args.instanceId);
  const slot = optionalString(args.slot);

  const scope = await options.resolveScope(invocation.sessionId, invocation.signal);
  if (!scope) throw new Error("Marshal Runtime session scope is unavailable.");

  if (!options.resolveWorkspacePath) {
    return {
      ok: false,
      stage: "compile",
      error: {
        code: "runtime-unavailable",
        message: "Runtime workspace path resolution is unavailable.",
      },
    };
  }
  let workspacePath: string;
  try {
    workspacePath = await options.resolveWorkspacePath(scope, invocation.signal);
  } catch (error) {
    return {
      ok: false,
      stage: "compile",
      error: {
        code: "runtime-unavailable",
        message: error instanceof Error ? error.message : "Runtime workspace is unavailable.",
      },
    };
  }

  // A refresh cannot use ui.application.update: update only touches an
  // instance owned by the SAME applicationId, and every new render gets a new
  // id. So a refresh opens the new render with replaceInstanceId, which swaps
  // it into the old view under the same id and placement.
  const previous = await findPriorAuthoredView(
    options.api,
    scope,
    instanceId ? { instanceId } : { slot },
    invocation.signal,
  );
  if (instanceId && !previous) {
    return {
      ok: false,
      stage: "update",
      error: { code: "not-found", message: `No open runtimeShowUi instance "${instanceId}".` },
    };
  }
  const prior = previous ? readShowUiRecord(workspacePath, previous.applicationId) : undefined;

  const rollback = optionalString(args.rollback);
  if (rollback) {
    return rollbackView(options, { scope, workspacePath, previous, rollback, args, invocation });
  }

  const title = optionalString(args.title) ?? prior?.title;
  if (!title) throw new Error("runtimeShowUi title is required.");
  const props = args.props === undefined ? (prior?.props ?? {}) : args.props;
  if (!isRecord(props)) throw new Error("runtimeShowUi props must be a JSON object.");
  const defaultViewport = options.resolveClientViewport?.(invocation.sessionId) ?? "desktop";
  let requested: ShowUiViews;
  try {
    requested = await importFileViews(
      parseViewsArgs(args, defaultViewport),
      options.resolveFileAccess?.(invocation.sessionId) ?? {
        workspaceDir: workspacePath,
        readGrants: [],
        writeGrants: [],
        allowedSensitivePaths: [],
      },
      workspacePath,
    );
  } catch (error) {
    if (!(error instanceof ShowUiFileError)) throw error;
    return { ok: false, stage: "source", error: { code: error.code, message: error.message } };
  }
  const views = {
    ...(prior ? viewsFromSourceFiles(workspacePath, prior) : {}),
    ...requested,
  };
  if (declaredViewports(views).length === 0) {
    throw new Error(
      prior || !instanceId
        ? "runtimeShowUi needs views, tsx, file, or component."
        : "runtimeShowUi cannot find the views of that instance; pass views again.",
    );
  }
  const propsError = validateViewProps(views, props);
  if (propsError) return { ok: false, stage: "props", error: propsError };

  const summary = optionalString(args.summary) ?? `${title} (generated UI)`;
  const idempotencyKey =
    optionalString(args.idempotencyKey) ??
    defaultIdempotencyKey({
      title,
      views,
      props,
      placement: placementDigestFields(args),
      instanceId: previous?.instanceId ?? null,
      epoch: previous
        ? (options.revisions?.list(scope.sessionId, previous.instanceId).at(-1)?.revisionId ?? "")
        : "",
    });

  let entryPath: string;
  let viewPaths: ShowUiViewPaths;
  try {
    const plan = planSourceFiles(views, contentAddressedEntryPath, title);
    viewPaths = plan.viewPaths;
    for (const file of plan.files) {
      secureAtomicWriteFileSync(
        path.join(workspacePath, ...file.relativePath.split("/")),
        file.source,
        {
          mode: 0o600,
        },
      );
    }
    entryPath = plan.entryPath;
  } catch (error) {
    return {
      ok: false,
      stage: "compile",
      error: {
        code: "operation-failed",
        message: `Failed to write UI source: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  const compileStartedAt = performance.now();
  const compileResponse = await options.api.invoke({
    ...scope,
    capability: "ui.compile",
    input: { entryPath, title },
    idempotencyKey: `${idempotencyKey}:compile`,
    signal: invocation.signal,
  });
  if (!compileResponse.ok) {
    if (compileResponse.error.code === "approval-required") {
      return { ok: false, stage: "compile", error: stageError(compileResponse.error) };
    }
    const diagnostics = parseCompileDiagnostics(compileResponse.error.message);
    if (previous) {
      options.revisions?.append(scope.sessionId, previous.instanceId, {
        status: "failed",
        title,
        failure: { stage: "compile", message: diagnostics[0]?.message ?? "compile failed" },
      });
    }
    return {
      ok: false,
      stage: "compile",
      diagnostics,
      ...(previous
        ? {
            instanceId: previous.instanceId,
            kept: "The previous working revision is still showing.",
          }
        : {}),
      next: nextAfterFailure(previous?.instanceId),
    };
  }
  const compileMs = Math.round(performance.now() - compileStartedAt);
  const componentId = extractComponentId(compileResponse.value.output);
  if (!componentId) {
    return {
      ok: false,
      stage: "compile",
      diagnostics: [{ message: "ui.compile returned no component id." }],
    };
  }

  const renderStartedAt = performance.now();
  const renderResponse = await options.api.invoke({
    ...scope,
    capability: "ui.render",
    input: {
      componentId,
      props: renderProps(props, views),
      fallback: { summary },
      application: SHOW_UI_DEFAULT_APPLICATION,
    },
    idempotencyKey: `${idempotencyKey}:render`,
    signal: invocation.signal,
  });
  if (!renderResponse.ok) {
    return { ok: false, stage: "render", error: stageError(renderResponse.error) };
  }
  const renderMs = Math.round(performance.now() - renderStartedAt);
  const renderId = extractRenderId(renderResponse.value.output);
  if (!renderId) {
    return {
      ok: false,
      stage: "render",
      error: { code: "operation-failed", message: "ui.render returned no render id." },
    };
  }

  try {
    writeShowUiRecord(workspacePath, renderId, { title, props, views, viewPaths });
  } catch {
    // Only a later refresh reads this record; showing the view does not depend on it.
  }

  const placeStage = previous ? ("update" as const) : ("open" as const);
  const openKey = `${idempotencyKey}:open`;
  const placeStartedAt = performance.now();
  const placeResponse = await options.api.invoke({
    ...scope,
    capability: "ui.application.open",
    input: {
      extensionId: RESERVED_AUTHORED_OWNER,
      applicationId: renderId,
      title,
      ...placementInput(args, previous),
      ...(previous ? { replaceInstanceId: previous.instanceId } : {}),
      idempotencyKey: openKey,
    },
    idempotencyKey: openKey,
    signal: invocation.signal,
  });
  if (!placeResponse.ok) {
    return { ok: false, stage: placeStage, error: stageError(placeResponse.error) };
  }
  const nested = unwrapUiCommandOutput(placeResponse.value.output);
  if (!nested.ok) {
    return { ok: false, stage: placeStage, error: nested.error };
  }
  const instance = extractInstance(nested.value);
  if (!instance) {
    return {
      ok: false,
      stage: placeStage,
      error: { code: "operation-failed", message: "ui.application.open returned no instance." },
    };
  }

  const placeMs = Math.round(performance.now() - placeStartedAt);
  const probeStartedAt = performance.now();
  const verdict = await probeVerdict(options, {
    scope,
    instanceId: instance.instanceId,
    renderId,
    viewport: views.desktop ? "desktop" : "mobile",
    signal: invocation.signal,
  });
  log.info(
    `runtimeShowUi stages compile=${compileMs}ms render=${renderMs}ms place=${placeMs}ms probe=${Math.round(performance.now() - probeStartedAt)}ms verdict=${verdict.status}`,
  );
  const ledger = options.revisions;
  if (verdict.status === "failing") {
    ledger?.append(scope.sessionId, instance.instanceId, {
      status: "failed",
      title,
      failure: { stage: verdict.phase, message: verdict.message },
    });
    const restored = previous
      ? await restoreWorkingRevision(options, {
          scope,
          previous,
          instanceId: instance.instanceId,
          fallbackTitle: prior?.title ?? title,
          idempotencyKey,
          signal: invocation.signal,
        })
      : undefined;
    return {
      ok: false,
      stage: "runtime",
      diagnostics: [
        {
          message: `${verdict.phase}: ${verdict.message}`,
          ...(verdict.stack ? { stack: verdict.stack } : {}),
        },
      ],
      instanceId: instance.instanceId,
      ...(restored ? { restored } : {}),
      next: nextAfterFailure(instance.instanceId),
    };
  }
  const revision = ledger?.append(scope.sessionId, instance.instanceId, {
    status: "live",
    title,
    renderId,
  });

  const sources = Object.fromEntries(
    Object.entries(viewPaths).map(([viewport, relativePath]) => [
      viewport,
      path.join(workspacePath, ...relativePath.split("/")),
    ]),
  );
  options.onSourcesLive?.(instance.instanceId, Object.values(sources));
  return {
    ok: true,
    instanceId: instance.instanceId,
    renderId,
    componentId,
    ...(revision ? { revision: revision.revisionId } : {}),
    painted: verdict.status === "ok" ? true : "unverified",
    next: previous ? NEXT_AFTER_UPDATED : NEXT_AFTER_SHOWN,
    surface: instance.surface ?? previous?.surface ?? "inline-card",
    sources,
    viewports: declaredViewports(views),
    ...(previous ? { replaced: previous.instanceId } : {}),
  };
}

async function probeVerdict(
  options: ShowUiToolOptions,
  request: {
    readonly scope: MarshalRuntimeScope;
    readonly instanceId: string;
    readonly renderId: string;
    readonly viewport: MarshalUiViewport;
    readonly signal?: AbortSignal;
  },
): Promise<ShowUiRenderVerdict> {
  if (!options.probeRender) return { status: "unverified" };
  try {
    return await options.probeRender({
      scope: request.scope,
      instanceId: request.instanceId,
      applicationId: request.renderId,
      viewport: request.viewport,
      signal: request.signal,
    });
  } catch {
    return { status: "unverified" };
  }
}

/**
 * Puts the earlier working render back into a view whose refresh candidate
 * failed. Returns the restored revision id (or "previous render" when the view
 * predates the ledger), or undefined when it could not be restored.
 */
async function restoreWorkingRevision(
  options: ShowUiToolOptions,
  request: {
    readonly scope: MarshalRuntimeScope;
    readonly previous: { readonly applicationId: string; readonly surface: string };
    readonly instanceId: string;
    readonly fallbackTitle: string;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  },
): Promise<string | undefined> {
  const live = options.revisions?.live(request.scope.sessionId, request.instanceId);
  const renderId = live?.renderId ?? request.previous.applicationId;
  const key = `${request.idempotencyKey}:restore`;
  const response = await options.api.invoke({
    ...request.scope,
    capability: "ui.application.open",
    input: {
      extensionId: RESERVED_AUTHORED_OWNER,
      applicationId: renderId,
      title: live?.title ?? request.fallbackTitle,
      surface: request.previous.surface,
      replaceInstanceId: request.instanceId,
      idempotencyKey: key,
    },
    idempotencyKey: key,
    signal: request.signal,
  });
  if (!response.ok || !unwrapUiCommandOutput(response.value.output).ok) return undefined;
  return live?.revisionId ?? "previous render";
}

async function rollbackView(
  options: ShowUiToolOptions,
  request: {
    readonly scope: MarshalRuntimeScope;
    readonly workspacePath: string;
    readonly previous: { readonly instanceId: string; readonly surface: string } | undefined;
    readonly rollback: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly invocation: RuntimeToolInvocation;
  },
): Promise<ShowUiResult> {
  const { previous, scope, rollback } = request;
  const ledger = options.revisions;
  if (!previous || !ledger) {
    return {
      ok: false,
      stage: "update",
      error: {
        code: "invalid-request",
        message: "rollback needs the instanceId of an open runtimeShowUi view.",
      },
    };
  }
  const revisions = ledger.list(scope.sessionId, previous.instanceId);
  if (rollback === "list") {
    return {
      ok: true,
      instanceId: previous.instanceId,
      revisions: revisionSummary(revisions),
      next: 'Call runtimeShowUi with {instanceId, rollback: "previous"} or a revision id to restore one.',
    };
  }
  const target = resolveRollbackTarget(revisions, rollback);
  if ("error" in target) {
    return { ok: false, stage: "update", error: { code: "not-found", message: target.error } };
  }
  const renderId = target.revision.renderId;
  if (!renderId) {
    return {
      ok: false,
      stage: "update",
      error: { code: "not-found", message: "That revision has no render to restore." },
    };
  }
  const key =
    optionalString(request.args.idempotencyKey) ?? `runtimeShowUi:rollback:${randomUUID()}`;
  const response = await options.api.invoke({
    ...scope,
    capability: "ui.application.open",
    input: {
      extensionId: RESERVED_AUTHORED_OWNER,
      applicationId: renderId,
      title: target.revision.title,
      surface: previous.surface,
      replaceInstanceId: previous.instanceId,
      idempotencyKey: `${key}:open`,
    },
    idempotencyKey: `${key}:open`,
    signal: request.invocation.signal,
  });
  if (!response.ok) {
    return { ok: false, stage: "update", error: stageError(response.error) };
  }
  const nested = unwrapUiCommandOutput(response.value.output);
  if (!nested.ok) return { ok: false, stage: "update", error: nested.error };
  ledger.markLive(scope.sessionId, previous.instanceId, target.revision.revisionId);
  const restoredRecord = readShowUiRecord(request.workspacePath, renderId);
  const sources = restoredRecord?.viewPaths
    ? Object.fromEntries(
        Object.entries(restoredRecord.viewPaths).map(([viewport, relativePath]) => [
          viewport,
          path.join(request.workspacePath, ...relativePath.split("/")),
        ]),
      )
    : undefined;
  return {
    ok: true,
    instanceId: previous.instanceId,
    renderId,
    surface: previous.surface,
    ...(sources ? { sources } : {}),
    rolledBackTo: target.revision.revisionId,
    revisions: revisionSummary(ledger.list(scope.sessionId, previous.instanceId)),
    next: "Restored. Mention it in one sentence; edits now apply to this revision.",
  };
}
