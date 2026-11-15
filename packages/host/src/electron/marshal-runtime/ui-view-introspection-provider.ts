import { randomUUID } from "node:crypto";

import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type InvocationContext,
} from "@marshal/runtime";

import type { RuntimeUiScope } from "../../common/runtime-ui";
import {
  RUNTIME_UI_PLACEMENT_NAMES,
  surfaceForPlacement,
  type RuntimeUiLayoutView,
} from "../../common/runtime-ui-layout";
import { describePlacementCatalog } from "../../common/runtime-ui-placement-catalog";
import {
  AUTHORED_UI_COMPONENT_CONTRACT,
  listRuntimeUiSeats,
  RUNTIME_UI_PLACEMENT_SEMANTICS,
  RUNTIME_UI_THEME_TOKENS,
  UI_VIEW_STATE_MAX_BYTES,
} from "../../common/runtime-ui-surfaces";
import {
  MARSHAL_UI_STANDARD_ALIASES,
  MARSHAL_UI_STATIC_TOKENS,
} from "../../common/runtime-ui-theme";
import type { RuntimeApplicationAuthority } from "./application-authority";
import { MARSHAL_RUNTIME_PERMISSION, type MarshalRuntimeApi } from "./contracts";
import { invalidRuntimeRequest } from "./runtime-provider-error";
import {
  BUILTIN_UI_COMPONENT_NAMES,
  BUILTIN_UI_COMPONENT_PROP_SCHEMAS,
} from "./show-ui-components";
import type { MarshalRuntimeUiController } from "./ui-controller";
import type { RuntimeUiViewPersistence } from "./ui-view-persistence";
import type { UiViewTalkBack } from "./ui-view-talk-back";

const PROVIDER_ID = "marshal.runtime-ui-introspection";
export const UI_VIEW_STATE_GET_CAPABILITY = "ui.view.state.get";
export const UI_SURFACES_DESCRIBE_CAPABILITY = "ui.surfaces.describe";
const WORKSPACE_METADATA_KEY = "marshalWorkspaceName";
const AUTHORED_OWNER = "marshal.react-ui";
const PAYLOAD_TOOL = "marshal_get_react_payload";

export interface UiViewHealthSummary {
  readonly status: "ok" | "failing" | "unknown";
  readonly phase?: string;
  readonly message?: string;
}

export interface UiIntrospectionDeps {
  readonly controller: MarshalRuntimeUiController;
  readonly persistence: Pick<RuntimeUiViewPersistence, "report">;
  readonly applications: Pick<RuntimeApplicationAuthority, "resolve">;
  readonly talkBack: Pick<UiViewTalkBack, "getContext">;
  readonly getApi: () => MarshalRuntimeApi | undefined;
  /** Wired to the view-health store when it exists; views read as `unknown` without it. */
  readonly viewHealth?: (
    instanceId: string,
    applicationId: string,
  ) => UiViewHealthSummary | undefined;
  /** The packages the authoring profile lets a view import. */
  readonly allowedPackages?: () => readonly string[];
}

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    value: { type: "object" },
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message"],
      properties: { code: { type: "string" }, message: { type: "string" } },
    },
  },
} as const;

const DESCRIPTORS: readonly CapabilityDescriptor[] = [
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: UI_SURFACES_DESCRIBE_CAPABILITY,
    version: "1.0.0",
    title: "Describe every UI surface, component contract, built-in, theme token and your views",
    description:
      "Call this first before unfamiliar UI work. Returns, generated from the host's own code: placements and what each means, every seat a view can occupy (and whether session views can use it), the authored component contract (props, the `marshal` client methods, persisted localStorage), the built-in components with their prop schemas, theme tokens with light and dark values, the packages a view may import, and this session's open views with placement and health.",
    tags: ["marshal", "ui", "introspection"],
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: RESULT_SCHEMA,
    permissions: [{ permission: MARSHAL_RUNTIME_PERMISSION.uiApplicationList, risk: "low" }],
  },
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: UI_VIEW_STATE_GET_CAPABILITY,
    version: "1.0.0",
    title: "Read what a view saved: its persisted state and its model context",
    description:
      "Returns the key/value storage the view persisted (its localStorage shim) and the model context it last published, for a runtimeShowUi view this session owns. Read-only and silent: use it to learn the user's selections without asking, and do not narrate the call.",
    tags: ["marshal", "ui", "state"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["instanceId"],
      properties: { instanceId: { type: "string", minLength: 1, maxLength: 128 } },
    },
    outputSchema: RESULT_SCHEMA,
    permissions: [{ permission: MARSHAL_RUNTIME_PERMISSION.uiApplicationList, risk: "low" }],
  },
];

export function createRuntimeUiIntrospectionProvider(
  deps: UiIntrospectionDeps,
): CapabilityProvider {
  return {
    id: PROVIDER_ID,
    version: "1.0.0",
    list: () => DESCRIPTORS,
    get: (name) => DESCRIPTORS.find((descriptor) => descriptor.name === name),
    async invoke(name, input, context) {
      if (deps.applications.resolve(context)) {
        throw Object.assign(new Error("Applications cannot introspect the session's views."), {
          code: "permission_denied",
        });
      }
      const scope = sessionScope(context);
      if (name === UI_SURFACES_DESCRIBE_CAPABILITY) {
        const listed = await deps.controller.list(scope, signalOf(context));
        if (!listed.ok) return { output: listed };
        return { output: { ok: true, value: describeSurfaces(deps, scope) } };
      }
      if (name === UI_VIEW_STATE_GET_CAPABILITY) {
        return { output: await readViewState(deps, scope, input, context) };
      }
      throw Object.assign(new Error(`Runtime UI introspection capability not found: ${name}.`), {
        code: "not_found",
      });
    },
  };
}

function describeSurfaces(deps: UiIntrospectionDeps, scope: RuntimeUiScope) {
  const report = deps.persistence.report(scope);
  return {
    generatedFrom: "host code constants",
    placements: RUNTIME_UI_PLACEMENT_NAMES.map((placement) => ({
      placement,
      surface: surfaceForPlacement(placement),
      ...RUNTIME_UI_PLACEMENT_SEMANTICS[placement],
    })),
    seats: listRuntimeUiSeats(),
    placementCatalog: describePlacementCatalog(),
    authoredComponent: AUTHORED_UI_COMPONENT_CONTRACT,
    builtInComponents: BUILTIN_UI_COMPONENT_NAMES.map((name) => ({
      name,
      propsSchema: BUILTIN_UI_COMPONENT_PROP_SCHEMAS[name],
    })),
    theme: {
      note: "Marshal theme tokens stamped on the view document for the current theme and updated live on theme change; use var(--name). The standard MCP-Apps names are aliases of these.",
      tokens: RUNTIME_UI_THEME_TOKENS,
      aliases: MARSHAL_UI_STANDARD_ALIASES.map(([alias, token]) => ({ alias, token })),
      static: MARSHAL_UI_STATIC_TOKENS,
    },
    allowedPackages: [...(deps.allowedPackages?.() ?? [])],
    views: report.views.map((view) => viewSummary(deps, view)),
    layoutUnreported: report.layoutUnreported,
  };
}

function viewSummary(deps: UiIntrospectionDeps, view: RuntimeUiLayoutView) {
  const health = deps.viewHealth?.(view.instanceId, view.applicationId);
  return {
    instanceId: view.instanceId,
    title: view.title,
    placement: view.placement,
    ...(view.anchor?.slot ? { slot: view.anchor.slot } : {}),
    health: health ?? { status: "unknown" as const },
    hasModelContext: deps.talkBack.getContext(view.instanceId) !== undefined,
  };
}

async function readViewState(
  deps: UiIntrospectionDeps,
  scope: RuntimeUiScope & { sessionId: string },
  input: unknown,
  context: InvocationContext,
): Promise<unknown> {
  const instanceId = inputRecord(input).instanceId;
  if (typeof instanceId !== "string" || !instanceId) {
    throw invalidRuntimeRequest(new TypeError("instanceId is required."));
  }
  const instance = deps.controller
    .scopeInstances(scope)
    .find((candidate) => candidate.instanceId === instanceId);
  if (
    !instance ||
    instance.content.kind !== "application" ||
    instance.owner.extensionId !== AUTHORED_OWNER
  ) {
    return {
      ok: false,
      error: {
        code: "not-found",
        message: `No open runtimeShowUi view "${instanceId}" in this session.`,
      },
    };
  }
  const api = deps.getApi();
  if (!api) {
    return {
      ok: false,
      error: { code: "runtime-unavailable", message: "The runtime API is not ready." },
    };
  }
  const payload = await api.invokeRenderTool({
    sessionId: scope.sessionId,
    workspaceName: scope.workspaceName,
    name: PAYLOAD_TOOL,
    input: { renderId: instance.content.renderId },
    idempotencyKey: `ui.view.state.get:${randomUUID()}`,
    signal: signalOf(context),
  });
  if (!payload.ok) {
    return { ok: false, error: { code: payload.error.code, message: payload.error.message } };
  }
  const marshal = asRecord(asRecord(asRecord(payload.value).structuredContent).marshal);
  const local = asRecord(asRecord(marshal.state).local);
  const { storage, truncated } = boundedStorage(marshal.storage);
  const modelContext = deps.talkBack.getContext(instanceId);
  return {
    ok: true,
    value: {
      instanceId,
      storage,
      ...(truncated ? { truncated: true } : {}),
      ...(typeof local.version === "number" ? { stateVersion: local.version } : {}),
      ...(typeof local.updatedAt === "string" ? { updatedAt: local.updatedAt } : {}),
      modelContext: modelContext ?? null,
    },
  };
}

export function boundedStorage(value: unknown): {
  readonly storage: Record<string, string>;
  readonly truncated: boolean;
} {
  const storage: Record<string, string> = {};
  let used = 0;
  let truncated = false;
  for (const [key, entry] of Object.entries(asRecord(value))) {
    if (typeof entry !== "string") continue;
    const size = Buffer.byteLength(key, "utf8") + Buffer.byteLength(entry, "utf8");
    if (used + size > UI_VIEW_STATE_MAX_BYTES) {
      truncated = true;
      continue;
    }
    used += size;
    storage[key] = entry;
  }
  return { storage, truncated };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function sessionScope(context: InvocationContext): RuntimeUiScope & { sessionId: string } {
  const sessionId = context.scope?.sessionId?.trim();
  const workspaceName = context.metadata?.[WORKSPACE_METADATA_KEY];
  if (!sessionId || typeof workspaceName !== "string" || !workspaceName.trim()) {
    throw invalidRuntimeRequest(
      new TypeError("UI introspection is only available to a session-scoped invocation."),
    );
  }
  return { sessionId, workspaceName: workspaceName.trim() };
}

function signalOf(context: InvocationContext): AbortSignal | undefined {
  return context.signal instanceof AbortSignal ? context.signal : undefined;
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRuntimeRequest(new TypeError("Introspection capability input must be an object."));
  }
  return Object.fromEntries(Object.entries(input));
}
