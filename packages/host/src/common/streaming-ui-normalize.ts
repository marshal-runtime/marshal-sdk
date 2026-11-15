/**
 * Tolerant completion of half-typed TSX for streaming `marshal-ui` blocks.
 *
 * A streamed prefix such as `<div style={{ color: "re` is rarely valid TSX.
 * `streamingUiCandidates` returns an ordered list of completions (open
 * strings, templates, comments, brackets and JSX tags closed, the half-typed
 * tail cut) for the host to compile in order; the first that compiles wins.
 * The heuristics are deliberately imperfect (no regex-literal or full type
 * grammar handling): the compiler is the judge, so a wrong guess only costs a
 * fallback to the next, earlier cut.
 */

type Frame =
  | { readonly kind: "paren" | "bracket" | "brace" | "tplExpr" }
  | { readonly kind: "string"; readonly quote: string; readonly start: number }
  | { readonly kind: "template"; readonly start: number }
  | { readonly kind: "lineComment" | "blockComment" }
  | { readonly kind: "jsxOpen"; readonly name: string; selfClosing: boolean }
  | { readonly kind: "jsxChildren"; readonly name: string };

const MAX_CANDIDATES = 8;
const MAX_LINE_CUTS = 3;

const EXPRESSION_KEYWORDS = new Set([
  "return",
  "case",
  "default",
  "yield",
  "await",
  "else",
  "do",
  "in",
  "of",
  "typeof",
  "void",
  "delete",
  "throw",
  "new",
]);

const NAME_CHAR = /[A-Za-z0-9_$.:-]/;
const IDENT_START = /[A-Za-z_$]/;
const IDENT_CHAR = /[A-Za-z0-9_$]/;

interface ScanResult {
  readonly stack: readonly Frame[];
}

function top(stack: readonly Frame[]): Frame | undefined {
  return stack[stack.length - 1];
}

function isCodeFrame(frame: Frame | undefined): boolean {
  return (
    frame === undefined ||
    frame.kind === "paren" ||
    frame.kind === "bracket" ||
    frame.kind === "brace" ||
    frame.kind === "tplExpr"
  );
}

function popUntil(stack: Frame[], kind: Frame["kind"]): void {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index].kind === kind) {
      stack.length = index;
      return;
    }
  }
}

/** True when `<` at `index` opens a JSX element rather than a comparison or generic. */
function opensJsx(source: string, index: number, previousToken: string): boolean {
  const next = source[index + 1];
  if (next === undefined) return true;
  if (next !== ">" && !IDENT_START.test(next)) return false;
  if (previousToken !== "") {
    if (IDENT_START.test(previousToken[0])) {
      if (!EXPRESSION_KEYWORDS.has(previousToken)) return false;
    } else if (previousToken === ">") {
      return false;
    } else if (previousToken === ")" || previousToken === "]" || /^\d/.test(previousToken)) {
      return false;
    }
  }
  let cursor = index + 1;
  while (cursor < source.length && NAME_CHAR.test(source[cursor])) cursor += 1;
  const rest = source.slice(cursor, cursor + 12);
  // `<T,>(x) =>` and `<T extends U>(x) =>` are generic arrow functions.
  if (/^\s*,/.test(rest) || /^\s+extends\b/.test(rest)) return false;
  return true;
}

function scan(source: string): ScanResult {
  const stack: Frame[] = [];
  let previousToken = "";
  let index = 0;
  const length = source.length;
  while (index < length) {
    const frame = top(stack);
    const char = source[index];
    if (frame?.kind === "lineComment") {
      if (char === "\n") stack.pop();
      index += 1;
      continue;
    }
    if (frame?.kind === "blockComment") {
      if (char === "*" && source[index + 1] === "/") {
        stack.pop();
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (frame?.kind === "string") {
      if (char === "\\") index += 2;
      else {
        if (char === frame.quote || char === "\n") {
          stack.pop();
          previousToken = '"';
        }
        index += 1;
      }
      continue;
    }
    if (frame?.kind === "template") {
      if (char === "\\") index += 2;
      else if (char === "`") {
        stack.pop();
        previousToken = "`";
        index += 1;
      } else if (char === "$" && source[index + 1] === "{") {
        stack.push({ kind: "tplExpr" });
        previousToken = "{";
        index += 2;
      } else index += 1;
      continue;
    }
    if (frame?.kind === "jsxChildren") {
      if (char === "{") {
        stack.push({ kind: "brace" });
        previousToken = "{";
        index += 1;
      } else if (char === "<") {
        if (source[index + 1] === "/") {
          let cursor = index + 2;
          while (cursor < length && source[cursor] !== ">") cursor += 1;
          if (cursor >= length) return { stack };
          stack.pop();
          previousToken = ">";
          index = cursor + 1;
        } else {
          let cursor = index + 1;
          while (cursor < length && NAME_CHAR.test(source[cursor])) cursor += 1;
          if (cursor >= length && source[index + 1] === undefined) {
            stack.push({ kind: "jsxOpen", name: "", selfClosing: false });
            return { stack };
          }
          stack.push({
            kind: "jsxOpen",
            name: source.slice(index + 1, cursor),
            selfClosing: false,
          });
          index = cursor;
        }
      } else index += 1;
      continue;
    }
    if (frame?.kind === "jsxOpen") {
      if (/\s/.test(char)) {
        index += 1;
      } else if (char === '"' || char === "'") {
        stack.push({ kind: "string", quote: char, start: index });
        index += 1;
      } else if (char === "{") {
        stack.push({ kind: "brace" });
        previousToken = "{";
        index += 1;
      } else if (char === "/") {
        frame.selfClosing = true;
        index += 1;
      } else if (char === ">") {
        stack.pop();
        if (frame.selfClosing) previousToken = ">";
        else stack.push({ kind: "jsxChildren", name: frame.name });
        previousToken = ">";
        index += 1;
      } else {
        frame.selfClosing = false;
        index += 1;
      }
      continue;
    }
    // Code state.
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === "/" && source[index + 1] === "/") {
      stack.push({ kind: "lineComment" });
      index += 2;
    } else if (char === "/" && source[index + 1] === "*") {
      stack.push({ kind: "blockComment" });
      index += 2;
    } else if (char === '"' || char === "'") {
      stack.push({ kind: "string", quote: char, start: index });
      index += 1;
    } else if (char === "`") {
      stack.push({ kind: "template", start: index });
      index += 1;
    } else if (char === "(") {
      stack.push({ kind: "paren" });
      previousToken = "(";
      index += 1;
    } else if (char === "[") {
      stack.push({ kind: "bracket" });
      previousToken = "[";
      index += 1;
    } else if (char === "{") {
      stack.push({ kind: "brace" });
      previousToken = "{";
      index += 1;
    } else if (char === ")") {
      popUntil(stack, "paren");
      previousToken = ")";
      index += 1;
    } else if (char === "]") {
      popUntil(stack, "bracket");
      previousToken = "]";
      index += 1;
    } else if (char === "}") {
      if (frame?.kind === "tplExpr") stack.pop();
      else popUntil(stack, "brace");
      previousToken = "}";
      index += 1;
    } else if (char === "<") {
      if (opensJsx(source, index, previousToken)) {
        if (source[index + 1] === ">") {
          stack.push({ kind: "jsxChildren", name: "" });
          index += 2;
        } else {
          let cursor = index + 1;
          while (cursor < length && NAME_CHAR.test(source[cursor])) cursor += 1;
          stack.push({
            kind: "jsxOpen",
            name: source.slice(index + 1, cursor),
            selfClosing: false,
          });
          index = cursor;
        }
        previousToken = "<";
      } else {
        previousToken = "<";
        index += 1;
      }
    } else if (IDENT_START.test(char)) {
      let cursor = index + 1;
      while (cursor < length && IDENT_CHAR.test(source[cursor])) cursor += 1;
      previousToken = source.slice(index, cursor);
      index = cursor;
    } else if (/\d/.test(char)) {
      let cursor = index + 1;
      while (cursor < length && /[\w.]/.test(source[cursor])) cursor += 1;
      previousToken = source.slice(index, cursor);
      index = cursor;
    } else if (char === ">" && source[index - 1] === "=") {
      previousToken = "=>";
      index += 1;
    } else {
      previousToken = char;
      index += 1;
    }
  }
  return { stack };
}

function closer(stack: readonly Frame[]): string {
  let result = "";
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const frame = stack[index];
    switch (frame.kind) {
      case "paren":
        result += ")";
        break;
      case "bracket":
        result += "]";
        break;
      case "brace":
      case "tplExpr":
        result += "}";
        break;
      case "string":
        result += frame.quote;
        break;
      case "template":
        result += "`";
        break;
      case "lineComment":
        result += "\n";
        break;
      case "blockComment":
        result += "*/";
        break;
      case "jsxOpen":
        result += frame.name === "" ? "" : "/>";
        break;
      case "jsxChildren":
        result += `</${frame.name}>`;
        break;
    }
  }
  return result;
}

function openLiteralStart(prefix: string): number | undefined {
  const frame = top(scan(prefix).stack);
  return frame?.kind === "string" || frame?.kind === "template" ? frame.start : undefined;
}

function complete(prefix: string): string | undefined {
  const { stack } = scan(prefix);
  const innermost = top(stack);
  // A bare `<` with no name cannot be closed; the caller cuts it first.
  if (innermost?.kind === "jsxOpen" && innermost.name === "") return undefined;
  if (stack.some((frame) => frame.kind === "jsxOpen" && frame.name === "")) return undefined;
  return prefix + closer(stack);
}

/**
 * Removes the half-typed tail: a partial closing tag, dangling operators and
 * attribute `=`, and with `dropWord` a trailing partial identifier (outside
 * strings and JSX text).
 */
function stripTail(prefix: string, dropWord: boolean): string {
  let text = prefix;
  for (let guard = 0; guard < 12; guard += 1) {
    const before = text;
    text = text.replace(/\s+$/, "").replace(/<\/[\w.:-]*$/, "");
    const frame = top(scan(text).stack);
    const editable = frame === undefined || isCodeFrame(frame) || frame.kind === "jsxOpen";
    if (!editable) break;
    text = text.replace(/=>$/, "").replace(/[=:,.?<&|+*!-]+$/, "");
    if (frame?.kind === "jsxOpen") text = text.replace(/\/$/, "");
    if (text === before.replace(/\s+$/, "") && dropWord) {
      const word = /(^|[\s{(,;<])([A-Za-z_$][\w$.:-]*)$/.exec(text);
      if (word) {
        text = text.slice(0, text.length - word[2].length);
        if (frame?.kind === "jsxOpen" && text.endsWith("<")) text = text.slice(0, -1);
        dropWord = false;
        continue;
      }
    }
    if (text === before) break;
  }
  return text.replace(/\s+$/, "");
}

function cutLines(source: string, count: number): string {
  let text = source;
  for (let cut = 0; cut < count; cut += 1) {
    const newline = text.lastIndexOf("\n");
    if (newline < 0) return "";
    text = text.slice(0, newline);
  }
  return text;
}

/**
 * Ordered completions of a streamed TSX prefix, best first, without duplicates.
 * Callers compile them in order and keep the first that succeeds.
 */
export function streamingUiCandidates(source: string): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  const push = (value: string | undefined) => {
    if (value === undefined || value.trim() === "" || seen.has(value)) return;
    seen.add(value);
    output.push(value);
  };
  push(complete(source));
  const literalStart = openLiteralStart(source);
  if (literalStart !== undefined) {
    push(complete(stripTail(source.slice(0, literalStart), false)));
  }
  push(complete(stripTail(source, false)));
  push(complete(stripTail(source, true)));
  for (let cut = 1; cut <= MAX_LINE_CUTS; cut += 1) {
    const prefix = cutLines(source, cut);
    if (prefix === "") break;
    push(complete(stripTail(prefix, false)));
    push(complete(stripTail(prefix, true)));
  }
  return output.slice(0, MAX_CANDIDATES);
}
