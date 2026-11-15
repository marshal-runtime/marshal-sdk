// Copied from the Marshal desktop (OmerMachluf/marshal 36452cec2, electron/marshal-runtime/typescript-agent-source.ts)
// so a TypeScript block reads the same in both shells.
/**
 * Agent-authoring conveniences for `runtimeExecuteTypeScript` source.
 *
 * Every injected statement goes on line 1 so compiler diagnostics keep the
 * agent's own line numbers. Anything that cannot be rewritten safely by line
 * (multi-line imports, other exports, a shebang) is passed through unchanged
 * and the compiler reports the problem as usual.
 */

export interface AgentTypeScriptSourceOptions {
  /** Full-Node execution: the worker is a fresh process per call, so chdir is call-local. */
  readonly trusted: boolean;
  /** The session workspace; trusted code starts with it as the working directory. */
  readonly workspacePath?: string;
}

const ANY_EXPORT = /^\s*export\s/m;
const TOP_LEVEL_IMPORT = /^import[\s{*"']/;
const SINGLE_LINE_IMPORT = /^import\s+(?:[^;]*?\s+from\s+)?["'][^"']+["']\s*;?\s*$/;
const PROCESS_USE = /\bprocess\s*[.[]/;
const BUFFER_USE = /\bBuffer\b/;

function hasBinding(source: string, name: string): boolean {
  const importBinding = new RegExp(`\\bimport\\b[^;\\n]*\\b${name}\\b[^;\\n]*\\bfrom\\b`);
  const declaration = new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`);
  return importBinding.test(source) || declaration.test(source);
}

function preludeFor(source: string, options: AgentTypeScriptSourceOptions): string {
  if (!options.trusted) return "";
  const statements: string[] = [];
  if (PROCESS_USE.test(source) && !hasBinding(source, "process")) {
    statements.push('import process from "node:process";');
  }
  if (BUFFER_USE.test(source) && !hasBinding(source, "Buffer")) {
    statements.push('import { Buffer } from "node:buffer";');
  }
  if (options.workspacePath) {
    statements.push(
      'import __marshalWorkspaceProcess from "node:process";',
      `try { __marshalWorkspaceProcess.chdir(${JSON.stringify(options.workspacePath)}); } catch {}`,
    );
  }
  return statements.length > 0 ? `${statements.join(" ")} ` : "";
}

/**
 * Splits a body-only snippet into hoisted import lines and the remaining
 * body, blanking each hoisted line in place. Returns undefined when the
 * snippet cannot be wrapped as a function body by line.
 */
function splitBodyOnly(lines: string[]): { imports: string[]; body: string[] } | undefined {
  const imports: string[] = [];
  const body = [...lines];
  for (let index = 0; index < body.length; index++) {
    const line = body[index] ?? "";
    if (!TOP_LEVEL_IMPORT.test(line)) continue;
    if (!SINGLE_LINE_IMPORT.test(line)) return undefined;
    imports.push(line.trim().endsWith(";") ? line.trim() : `${line.trim()};`);
    body[index] = "";
  }
  return { imports, body };
}

export function prepareAgentTypeScriptSource(
  source: string,
  options: AgentTypeScriptSourceOptions,
): string {
  if (source.startsWith("#!")) return source;
  const prelude = preludeFor(source, options);
  const lines = source.split("\n");

  if (!ANY_EXPORT.test(source)) {
    const split = splitBodyOnly(lines);
    if (split) {
      const header = `${prelude}${split.imports.map((line) => `${line} `).join("")}export default async (input, context) => { `;
      const [first = "", ...rest] = split.body;
      return [`${header}${first}`, ...rest].join("\n") + "\n};";
    }
  }

  if (!prelude) return source;
  const [first = "", ...rest] = lines;
  return [`${prelude}${first}`, ...rest].join("\n");
}

// From electron/marshal-runtime/typescript-tool-result.ts (same commit), over the runtime's raw envelope.
interface CompactDiagnostic {
  readonly line?: number;
  readonly column?: number;
  readonly code?: string;
  readonly message: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compactDiagnostics(value: unknown): CompactDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const compact: CompactDiagnostic[] = [];
  for (const entry of value) {
    const diagnostic = asRecord(entry);
    const message = nonEmptyText(diagnostic?.message);
    if (!diagnostic || !message) continue;
    // Execute-stage locations point into the compiled bundle, not the agent's
    // source, so only compile-stage positions are reported.
    const location = diagnostic.stage === "compile" ? asRecord(diagnostic.location) : undefined;
    compact.push({
      ...(typeof location?.line === "number" ? { line: location.line } : {}),
      ...(typeof location?.column === "number" ? { column: location.column } : {}),
      ...(typeof diagnostic.code === "string" ? { code: diagnostic.code } : {}),
      message,
    });
  }
  return compact;
}

export function compactTypeScriptExecutionResult(output: unknown): Record<string, unknown> {
  const execution = asRecord(output);
  if (!execution || typeof execution.status !== "string") return { ok: true, value: output };
  const streams = {
    ...(nonEmptyText(execution.stdout) ? { stdout: execution.stdout } : {}),
    ...(nonEmptyText(execution.stderr) ? { stderr: execution.stderr } : {}),
  };
  if (execution.status === "succeeded") return { ok: true, value: execution.value ?? null, ...streams };
  const error = asRecord(execution.error);
  const diagnostics = compactDiagnostics(execution.diagnostics);
  return {
    ok: false,
    status: execution.status,
    ...(error
      ? { error: { ...(typeof error.code === "string" ? { code: error.code } : {}), message: nonEmptyText(error.message) ?? "TypeScript execution failed." } }
      : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...streams,
  };
}
