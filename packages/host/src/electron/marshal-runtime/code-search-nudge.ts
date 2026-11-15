/**
 * Steers concept-style code searches to the workspace knowledge index. A
 * concept search guesses vocabulary: two or more alternatives in plain words,
 * at least one of them a topic phrase (`"unit cost|cogs|margin"`). Exact lookups
 * are never touched: identifiers, kebab-case, CONSTANTS, numbers, regex groups,
 * messages (`"Not found|Permission denied"`: sentence case, punctuation or a
 * word like "not" or "failed"), fixed-string or word searches (`-F`, `-w`), a
 * list of `-e` strings, a single phrase, and searches aimed at named files or
 * globs. When the session can reach `knowledge.search` and the agent has not
 * used the index yet, the first standalone concept search is denied once with
 * a ready-to-run call; a search inside a compound command (`;`, `&&`, `||`,
 * `&`) is never denied (that would cancel the whole command) and gets an
 * advisory note instead, as does every later one. An actual index call counts
 * as having searched: a runtimeInvoke of a `knowledge.*` capability, or
 * scripting-tool TypeScript that calls `runtime.invoke("knowledge.…")` outside
 * a comment. Subagents get the same rule when they start.
 *
 * The predicate was tuned on a replay of 240 real blocks and 18 hand-labelled
 * concept searches (replayed in `code-search-nudge.test.ts`).
 */
import type { RuntimeSubagentStartContext, RuntimeToolCallHint } from "../backend/runtime-contract";
import type { MarshalRuntimeApi, MarshalRuntimeScope } from "./contracts";
import { createKnowledgeAvailability } from "./knowledge-availability";

const AVAILABILITY_TTL_MS = 60_000;
const AVAILABILITY_TIMEOUT_MS = 500;
const MAX_TRACKED_AGENTS = 2_000;
const SEARCH_COMMAND = /(^|[\s|;&(])(grep|egrep|rg|ag|git\s+grep)\s/;
/** `&&`, `||`, `;`, a newline, or a lone backgrounding `&` (not `2>&1`, `&>` or `|&`). */
const SEGMENT_SEPARATOR = /&&|\|\||;|\n|(?<![<>&|])&(?![>&])/;
/** Characters a regex `.` does not match. */
const LINE_BREAK = /[\n\r\u2028\u2029]/;
/** `runtime.invoke("knowledge.…")` in TypeScript source: an actual call of the index. */
const KNOWLEDGE_INVOKE = /\bruntime\s*\.\s*invoke\s*\(\s*["'`]knowledge\.[A-Za-z]/g;
const KNOWLEDGE_CAPABILITY = /^knowledge\.[A-Za-z]/;
const RUNTIME_INVOKE_TOOL = /(?:^|__)runtimeInvoke$/;
const TYPESCRIPT_TOOL = /(?:^|__)runtimeExecuteTypeScript$/;
/** Words after which a `/` starts a regex literal, not a division. */
const KEYWORDS_BEFORE_EXPRESSION = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);
const REGEX_SYNTAX = /\\[|bBsSwWdD]|[|()[\]{}^$*+?.\\]/g;
const DEFAULT_QUERY = "what you are looking for, in words";

/** A shell glob of files (`src/*.ts`) scopes the search to code the agent already found, like a file name does. */
const FILE_OR_GLOB = /^[\w.~/*?-]*\.[A-Za-z0-9]{1,6}$/;
/** A bundle of short flags (`-rnw`). Tested per token: one regex over the whole stage backtracked polynomially. */
const SHORT_FLAGS = /^-[A-Za-z]+$/;
/** A lowercase or Capitalized word: no `_ - . / :`, digits, camelCase or ALLCAPS. */
const NATURAL_WORD = /^(?:[a-z]+|[A-Z][a-z]+)$/;
/** A phrase that starts with a code or SQL keyword is a signature or statement the agent already knows. */
const CODE_LEAD =
  /^(export|import|from|const|let|var|function|class|interface|type|async|await|def|return|new|create|alter|drop|select|insert|update|delete|set|grant)\b/i;
/** A word that makes a phrase read like an error or status message rather than a topic. */
const MESSAGE_WORD =
  /^(?:not|cannot|never|no|failed|fails|failure|denied|invalid|refused|unable|missing|unknown|unexpected|expected|exceeded|error|errors|timeout)$/i;

/** Alternatives split at `|` or `\|` outside any group, so `(a|b)` stays inside its alternative. */
function topLevelAlternatives(pattern: string): string[] {
  const alternatives: string[] = [];
  let depth = 0;
  let current = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "\\" && index + 1 < pattern.length) {
      const next = pattern[index + 1];
      index++;
      if (next === "|" && depth === 0) {
        alternatives.push(current);
        current = "";
        continue;
      }
      if (next === "(") depth++;
      else if (next === ")") depth = Math.max(0, depth - 1);
      current += char + next;
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "|" && depth === 0) {
      alternatives.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  alternatives.push(current);
  return alternatives.map((alternative) => alternative.trim()).filter(Boolean);
}

/** Drops regex operators that do not change the words: `\b`, `\s*`, `.?`, `.*`, `^`, `$`, groups. */
function regexWords(alternative: string): string {
  return alternative
    .replace(/\\[bBsSwWdD][*+?]?/g, " ")
    .replace(/\.[*+?]/g, " ")
    .replace(/\\?[()|]/g, " ")
    .replace(/[\^$?*+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNaturalLanguage(alternative: string): boolean {
  const words = regexWords(alternative);
  if (!words || (CODE_LEAD.test(words) && words.includes(" "))) return false;
  return words.split(" ").every((word) => NATURAL_WORD.test(word));
}

/**
 * Text the program prints, copied from a log or the UI: a phrase in sentence
 * case (`Permission denied`) or with a word like "not". Punctuated text
 * (`Error: x`, `can't`, `Done!`, `wait...`) never gets here: a word with
 * punctuation is not a {@link NATURAL_WORD}, so {@link isNaturalLanguage}
 * already left it out.
 */
function isMessageShaped(alternative: string): boolean {
  const words = regexWords(alternative).split(" ");
  return (
    words.length >= 2 &&
    (/^[A-Z][a-z]/.test(words[0]) || words.some((word) => MESSAGE_WORD.test(word)))
  );
}

/**
 * Two or more plain-language alternatives, at least one of them a topic phrase
 * (not a message): the agent is guessing vocabulary. Messages joined with `|`
 * (`"Not found|Permission denied"`) are exact lookups.
 */
export function isConceptPattern(pattern: string): boolean {
  const natural = topLevelAlternatives(pattern).filter(isNaturalLanguage);
  return (
    natural.length >= 2 &&
    natural.some(
      (alternative) => regexWords(alternative).includes(" ") && !isMessageShaped(alternative),
    )
  );
}

interface SearchStage {
  readonly masked: string;
  readonly quoted: readonly string[];
}

/**
 * Replaces each `"…"` (with `\` escapes) and `'…'` argument by `''` and
 * returns their contents in order. A linear scan: the regex it replaces,
 * `/"((?:[^"\\]|\\.)*)"|'([^']*)'/g`, retried every `"` of an unclosed string
 * and took minutes on a long run of `\"`. Results match that regex: a `"`
 * whose string fails (no closing quote, or `\` before a line break) is kept
 * as text, and so is every `"` its failed scan passed over.
 */
export function maskQuoted(command: string): { masked: string; quoted: string[] } {
  const quoted: string[] = [];
  let masked = "";
  let doubleFailsBefore = 0;
  let index = 0;
  while (index < command.length) {
    const char = command[index];
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end !== -1) {
        quoted.push(command.slice(index + 1, end));
        masked += "''";
        index = end + 1;
        continue;
      }
    } else if (char === '"' && index >= doubleFailsBefore) {
      let end = index + 1;
      while (end < command.length && command[end] !== '"') {
        if (command[end] !== "\\") end++;
        else if (end + 1 < command.length && !LINE_BREAK.test(command[end + 1])) end += 2;
        else break;
      }
      if (command[end] === '"') {
        quoted.push(command.slice(index + 1, end));
        masked += "''";
        index = end + 1;
        continue;
      }
      // Every `"` up to here was escaped inside this failed scan, so a scan from it fails the same way.
      doubleFailsBefore = end;
    }
    masked += char;
    index++;
  }
  return { masked, quoted };
}

/**
 * Searches that lead a pipeline, with quoted arguments masked. A grep after
 * `|` filters another command's output, so it is not a code search.
 */
function leadingSearches(command: string): SearchStage[] {
  const { masked, quoted } = maskQuoted(command);
  let next = 0;
  return masked.split(SEGMENT_SEPARATOR).flatMap((segment) => {
    const stages = segment.split("|");
    const counts = stages.map((stage) => (stage.match(/''/g) ?? []).length);
    const first = { masked: stages[0], quoted: quoted.slice(next, next + counts[0]) };
    next += counts.reduce((sum, count) => sum + count, 0);
    return SEARCH_COMMAND.test(` ${first.masked}`) ? [first] : [];
  });
}

/** A search aimed at named files or globs is a lookup inside code the agent already found. */
function namesFiles(maskedStage: string): boolean {
  return maskedStage
    .trim()
    .split(/\s+/)
    .some((token) => !token.startsWith("-") && FILE_OR_GLOB.test(token));
}

/** Fixed-string or whole-word search (`-F`, `-w`, `-rnw`, the long forms): the agent knows the exact text. */
function searchesFixedStrings(tokens: readonly string[]): boolean {
  return tokens.some(
    (token) =>
      token === "--fixed-strings" ||
      token === "--word-regexp" ||
      (SHORT_FLAGS.test(token) && /[Fw]/.test(token)),
  );
}

/** The stage's patterns: each quoted argument, and every `-e` pattern pooled as alternatives of one search. */
function stagePatterns({ masked, quoted }: SearchStage): string[] {
  const tokens = masked.trim().split(/\s+/);
  if (namesFiles(masked) || searchesFixedStrings(tokens)) return [];
  const expressions: string[] = [];
  let seen = 0;
  tokens.forEach((token, index) => {
    if (tokens[index - 1] === "-e") expressions.push(token === "''" ? (quoted[seen] ?? "") : token);
    seen += (token.match(/''/g) ?? []).length;
  });
  return expressions.length > 0 ? [...quoted, expressions.join("|")] : [...quoted];
}

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value: unknown = Reflect.get(input, key);
  return typeof value === "string" ? value : undefined;
}

function conceptPatterns(toolName: string, toolInput: unknown): string[] {
  const name = toolName.toLowerCase();
  if (name === "grep") {
    const pattern = field(toolInput, "pattern");
    const searchPath = field(toolInput, "path");
    if (pattern === undefined || (searchPath !== undefined && FILE_OR_GLOB.test(searchPath))) {
      return [];
    }
    return isConceptPattern(pattern) ? [pattern] : [];
  }
  if (name !== "bash") return [];
  const command = field(toolInput, "command");
  if (!command) return [];
  return leadingSearches(command).flatMap(stagePatterns).filter(isConceptPattern);
}

/** True when a Grep call or a shell grep/rg guesses vocabulary with several plain-language alternatives. */
export function isConceptCodeSearch(toolName: string, toolInput: unknown): boolean {
  return conceptPatterns(toolName, toolInput).length > 0;
}

/**
 * True when denying the call cancels only the search: a Grep call, or a shell
 * command that is one search (its own pipes allowed). A search chained with
 * `;`, `&&`, `||` or a backgrounding `&` must never be denied, since that
 * would cancel the rest.
 */
export function isStandaloneSearch(toolName: string, toolInput: unknown): boolean {
  const name = toolName.toLowerCase();
  if (name === "grep") return true;
  if (name !== "bash") return false;
  const command = field(toolInput, "command") ?? "";
  const segments = maskQuoted(command)
    .masked.split(SEGMENT_SEPARATOR)
    .filter((segment) => segment.trim());
  return segments.length === 1 && leadingSearches(command).length === 1;
}

function isIdentifierChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 36 ||
    code === 95 ||
    code > 127
  );
}

/**
 * The end of a `/…/flags` regex literal starting at `start`: the index just
 * past its flags (`closed`), or where its line ends without closing it.
 */
function regexLiteralEnd(source: string, start: number): { end: number; closed: boolean } {
  let inClass = false;
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index];
    if (char === "\\") index++;
    else if (LINE_BREAK.test(char)) return { end: index, closed: false };
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      let end = index + 1;
      while (end < source.length && isIdentifierChar(source.charCodeAt(end))) end++;
      return { end, closed: true };
    }
  }
  return { end: source.length, closed: false };
}

/**
 * Marks which characters of TypeScript `source` are code: not inside a
 * comment, a string, a template's text or (best effort) a regex literal. One
 * pass, each character read a bounded number of times.
 */
function codeMask(source: string): Uint8Array {
  const mask = new Uint8Array(source.length);
  /** For each open `${`, the brace depth its `}` closes. */
  const templateDepths: number[] = [];
  let depth = 0;
  let regexAllowed = true;
  /** A regex scan that ran to the end of its line marks the rest of that line as holding none, so no line is rescanned. */
  let noRegexBefore = 0;
  let index = 0;
  /** Skips template text from `index` to the closing backtick or into a `${` expression. */
  const scanTemplate = (): void => {
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") index += 2;
      else if (char === "`") {
        index++;
        regexAllowed = false;
        return;
      } else if (char === "$" && source[index + 1] === "{") {
        index += 2;
        templateDepths.push(depth);
        depth++;
        regexAllowed = true;
        return;
      } else index++;
    }
  };
  while (index < source.length) {
    const char = source[index];
    const code = source.charCodeAt(index);
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
    } else if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (char === "/" && regexAllowed && index >= noRegexBefore) {
      const literal = regexLiteralEnd(source, index);
      if (literal.closed) {
        index = literal.end;
        regexAllowed = false;
      } else {
        // A division after all (or an unclosed literal): read it as an operator.
        noRegexBefore = literal.end;
        mask[index++] = 1;
        regexAllowed = true;
      }
    } else if (char === "'" || char === '"') {
      index++;
      while (index < source.length && source[index] !== char && !LINE_BREAK.test(source[index])) {
        index += source[index] === "\\" ? 2 : 1;
      }
      index++;
      regexAllowed = false;
    } else if (char === "`") {
      index++;
      scanTemplate();
    } else if (isIdentifierChar(code)) {
      const start = index;
      while (index < source.length && isIdentifierChar(source.charCodeAt(index))) {
        mask[index++] = 1;
      }
      regexAllowed =
        index - start <= 10 && KEYWORDS_BEFORE_EXPRESSION.has(source.slice(start, index));
    } else {
      mask[index++] = 1;
      if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === depth) {
          templateDepths.pop();
          scanTemplate();
          continue;
        }
      }
      if (!/\s/.test(char)) regexAllowed = !(char === ")" || char === "]" || char === "}");
    }
  }
  return mask;
}

/**
 * True when the call used the knowledge index: the runtimeInvoke tool with a
 * `knowledge.*` capability, or the scripting tool's TypeScript calling
 * `runtime.invoke("knowledge.…")` as code, outside a comment, string, template
 * text or regex literal. A string that merely names a capability (a search
 * query, a grep, another tool's input) does not.
 */
export function usesKnowledgeIndex(
  toolName: string,
  toolInput: unknown,
  scriptingToolName?: string,
): boolean {
  if (RUNTIME_INVOKE_TOOL.test(toolName)) {
    return KNOWLEDGE_CAPABILITY.test(field(toolInput, "capability") ?? "");
  }
  if (toolName !== scriptingToolName && !TYPESCRIPT_TOOL.test(toolName)) return false;
  const source = field(toolInput, "source") ?? "";
  let mask: Uint8Array | undefined;
  for (const match of source.matchAll(KNOWLEDGE_INVOKE)) {
    mask ??= codeMask(source);
    if (mask[match.index] === 1) return true;
  }
  return false;
}

/** The words of a concept search, as a knowledge.search query. */
export function conceptQuery(toolName: string, toolInput: unknown): string {
  const patterns =
    toolName.toLowerCase() === "grep"
      ? [field(toolInput, "pattern") ?? ""]
      : conceptPatterns(toolName, toolInput);
  const words = patterns.join(" ").replace(REGEX_SYNTAX, " ").replace(/\s+/g, " ").trim();
  return words || DEFAULT_QUERY;
}

/** A knowledge.search call that returns each hit's name, file path, line and node id. */
export function knowledgeSearchCall(query: string = DEFAULT_QUERY): string {
  return (
    `return (await context.runtime.invoke('knowledge.search', {query: ${JSON.stringify(query)}, limit: 10}))` +
    ".hits.map((hit) => [hit.node.name, hit.node.path ?? hit.location, hit.line, hit.node.id]);"
  );
}

export function codeSearchNudgeText(
  scriptingToolName: string,
  query: string = DEFAULT_QUERY,
): string {
  return (
    "This looks like a concept search. The workspace knowledge index answers where/how/who-calls " +
    `questions in one ranked call across code and memories. Run it in ${scriptingToolName}: ` +
    `\`${knowledgeSearchCall(query)}\` Grep stays right for an exact string you already know. ` +
    "The search is running as sent."
  );
}

export function codeSearchGateText(scriptingToolName: string, query: string): string {
  return (
    "Blocked once: this is a concept search, and this session has not searched the knowledge index yet. " +
    `Search the index first, in ${scriptingToolName}: \`${knowledgeSearchCall(query)}\` Then open the top hits. ` +
    "After that every grep runs: send this one again if the index did not answer it. " +
    "Only a search that guesses wording with several plain-language alternatives is blocked; " +
    "a name, a constant, a message, an -F, -w or -e search, or a search of named files never is."
  );
}

export function brainFirstSubagentText(scriptingToolName: string): string {
  return (
    "Code questions: this workspace has a code knowledge index. Your first code lookup is knowledge.search " +
    `through ${scriptingToolName}, before Grep, Glob or a shell grep: \`${knowledgeSearchCall()}\` ` +
    "Write the query as the question in words, then open the files of the top hits. " +
    "Grep stays right for an exact string you already know."
  );
}

export interface CodeSearchNudgeOptions {
  readonly api: Pick<MarshalRuntimeApi, "search">;
  readonly resolveScope: (sessionId: string) => Promise<MarshalRuntimeScope | null>;
}

export interface CodeSearchGuide {
  readonly toolCallHint: RuntimeToolCallHint;
  readonly subagentStartContext: RuntimeSubagentStartContext;
}

export function createCodeSearchGuide(options: CodeSearchNudgeOptions): CodeSearchGuide {
  const availability = createKnowledgeAvailability({
    api: options.api,
    resolveScope: options.resolveScope,
    ttlMs: AVAILABILITY_TTL_MS,
    timeoutMs: AVAILABILITY_TIMEOUT_MS,
  });
  const searchedIndex = new Set<string>();
  const gated = new Set<string>();

  const isAvailable = (sessionId: string): Promise<boolean> => availability.check(sessionId);

  const track = (keys: Set<string>, key: string): void => {
    if (keys.size >= MAX_TRACKED_AGENTS) keys.clear();
    keys.add(key);
  };

  const toolCallHint: RuntimeToolCallHint = async ({
    toolName,
    toolInput,
    sessionId,
    agentId,
    scriptingToolName,
  }) => {
    const agentKey = `${sessionId}\u0000${agentId ?? ""}`;
    if (usesKnowledgeIndex(toolName, toolInput, scriptingToolName)) {
      track(searchedIndex, agentKey);
      return undefined;
    }
    if (!isConceptCodeSearch(toolName, toolInput)) return undefined;
    if (!(await isAvailable(sessionId))) return undefined;
    const query = conceptQuery(toolName, toolInput);
    if (
      searchedIndex.has(agentKey) ||
      gated.has(agentKey) ||
      !isStandaloneSearch(toolName, toolInput)
    ) {
      return codeSearchNudgeText(scriptingToolName, query);
    }
    track(gated, agentKey);
    return { denyReason: codeSearchGateText(scriptingToolName, query) };
  };

  const subagentStartContext: RuntimeSubagentStartContext = async ({
    sessionId,
    scriptingToolName,
  }) => ((await isAvailable(sessionId)) ? brainFirstSubagentText(scriptingToolName) : undefined);

  return { toolCallHint, subagentStartContext };
}
