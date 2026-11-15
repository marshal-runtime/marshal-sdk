import { RUNTIME_PROTOCOL_VERSION, type CapabilityProvider, type InvocationContext } from "@marshal/runtime";

/** Runs another capability for the caller, as the caller: same principal, scope and permission checks. */
export type CapabilityCall = (target: string, input: unknown, context: InvocationContext) => Promise<unknown>;

export interface KitOperation {
  title: string;
  description: string;
  permission: string;
  risk: "low" | "medium" | "high";
  input: object;
  output: object;
  run(input: Record<string, any>, context: InvocationContext): Promise<unknown>;
}

/** A kernel-like runner: the host binds it once the runtime exists. */
export interface KernelLike {
  runtimeExec(
    request: { protocolVersion: string; target: string; input?: unknown },
    context: InvocationContext,
  ): Promise<{ status: string; result?: { output?: unknown }; error?: { code?: string; message?: string } }>;
}

export function kernelCall(kernel: () => KernelLike | undefined): CapabilityCall {
  return async (target, input, context) => {
    const runner = kernel();
    if (!runner) throw new Error("The runtime is not ready yet.");
    const { executionId: _parent, approval: _approval, ...caller } = context as InvocationContext & {
      executionId?: string;
      approval?: unknown;
    };
    const response = await runner.runtimeExec({ protocolVersion: RUNTIME_PROTOCOL_VERSION, target, input }, caller as InvocationContext);
    if (response.status !== "success") {
      throw Object.assign(new Error(`${target}: ${response.error?.message ?? response.status}`), {
        code: response.error?.code ?? response.status,
      });
    }
    return response.result?.output;
  };
}

export function kitProvider(id: string, operations: Record<string, KitOperation>): CapabilityProvider {
  const descriptors = Object.entries(operations).map(([name, operation]) => ({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name,
    version: "1.0.0",
    title: operation.title,
    description: operation.description,
    tags: ["marshal-sdk", "kit"],
    inputSchema: operation.input,
    outputSchema: operation.output,
    permissions: [{ permission: operation.permission, risk: operation.risk }],
  }));
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  return {
    id,
    version: "1.0.0",
    list: () => descriptors,
    get: (name: string) => byName.get(name),
    invoke: async (name: string, value: unknown, context: InvocationContext) => {
      const operation = operations[name];
      if (!operation) throw Object.assign(new Error(`Unknown capability ${name}.`), { code: "not_found" });
      return { output: await operation.run((value ?? {}) as Record<string, any>, context) };
    },
  } as unknown as CapabilityProvider;
}

export function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw Object.assign(new Error(`${field} must be a non-empty string of at most ${max} characters.`), {
      code: "invalid_request",
    });
  }
  return value.trim();
}

export function boundedLimit(value: unknown, fallback: number, max: number): number {
  return Number.isInteger(value) && (value as number) >= 1 ? Math.min(value as number, max) : fallback;
}

/** External text going into a model's context: marked as data, with any closing tag inside escaped. */
export function untrusted(tag: string, text: string): string {
  return `<${tag}>${text.replaceAll(`</${tag}`, `<\\/${tag}`)}</${tag}>`;
}
