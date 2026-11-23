import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Mail, Drive and calendar content that a Google Workspace read tool returned to the model (docs/design/google-workspace.md). The server keeps a copy
 * of each chat transcript indefinitely and the inspector shows it behind one shared operator password, so the stored copy keeps the
 * conversation and the model's own answers but not the raw tool results. The brand VM's own copy is untouched.
 */
export const WORKSPACE_REDACTION_NOTICE = "[Google Workspace content removed from the stored transcript]";
/** The same for what the owner's browser returned (browser.* on their own Chrome: page text, titles and urls of their signed-in sessions; D91). */
export const BROWSER_REDACTION_NOTICE = "[Owner's browser content removed from the stored transcript]";

// A call reaches a read tool either directly or as a capability named inside a runtime script, so the call's input is what is matched.
const WORKSPACE_READ_CALL = /zs\.workspace\.(?:gmail|drive|calendar)_/;
// A browser.* call on the owner's own Chrome: one that asks for it (`on: "user"`, in JSON or in a runtime script, quoted or escaped) or names a session
// or task the VM provider named `owner-<id>` (zs-marshal-browser.mjs). Also any call that names a file under the chat's work/browser folder, where the
// browser keeps its screenshots and end pictures (a Read of one puts the page into the transcript as an image): the server cannot tell an owner's
// picture from a public page's there, so every one goes. Not Playwright's own browser_* tools, and not a public-page browser.* call.
/**
 * What zs-marshal-browser.mjs puts first in every answer from the owner's Chrome (OWNER_MARK). The provider sets it from the backend that actually ran the
 * call (the bundle's typed `backend`), so it is the authority: a result carrying it goes, whatever the call said. The call-text match below is an extra net
 * for a result whose mark a runtime script dropped (it returned one field of the answer).
 */
const OWNER_BROWSER_RESULT = /zsOwnerBrowser\\*"\s*:\s*true/;
/** Whether a tool result (its content, or the entry's toolUseResult) carries the owner's-Chrome mark. */
export const ownerBrowserResult = (content: unknown): boolean =>
  content !== undefined && OWNER_BROWSER_RESULT.test(typeof content === "string" ? content : JSON.stringify(content ?? null));
const BROWSER_CALL = /(?:^|[^A-Za-z0-9_$])on(?:\\?["'])?\s*:\s*\\?["']user\\?["']|\\?["']owner-[A-Za-z0-9_-]{4,}|work\/browser\//;

/** What a routine kept (zs.state.read, or a file read under ~/state/<routine>/; D121): a money key is one person's figures, and the server cannot tell the plain ones apart here, so every result goes. */
export const STATE_REDACTION_NOTICE = "[Routine state content removed from the stored transcript]";
const STATE_READ_CALL = /zs\.state\.read|\/state\/[a-z][a-z0-9_-]*\/[^"\\]*\.json/;

type Json = Record<string, unknown>;
const object = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);
const blocks = (entry: Json): Json[] => {
  const content = object(entry.message)?.content;
  return Array.isArray(content) ? content.map(object).filter((block): block is Json => block !== null) : [];
};

/** The tool-call ids of Workspace read calls and browser calls in one transcript file, with the notice each result gets. */
export function redactedCallIds(text: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.includes("zs.workspace.") && !line.includes("browser") && !line.includes("state")) continue;
    let entry: Json | null;
    try { entry = object(JSON.parse(line)); } catch { continue; }
    if (!entry) continue;
    for (const block of blocks(entry)) {
      if (block.type !== "tool_use" || typeof block.id !== "string") continue;
      const call = `${typeof block.name === "string" ? JSON.stringify(block.name) : ""}${JSON.stringify(block.input ?? null)}`;
      if (BROWSER_CALL.test(call)) ids.set(block.id, BROWSER_REDACTION_NOTICE);
      else if (STATE_READ_CALL.test(call)) ids.set(block.id, STATE_REDACTION_NOTICE);
      else if (WORKSPACE_READ_CALL.test(call)) ids.set(block.id, WORKSPACE_REDACTION_NOTICE);
    }
  }
  return ids;
}

/** The tool-call ids of Workspace read calls in one transcript file. */
export const workspaceCallIds = (text: string): Set<string> => new Set(redactedCallIds(text).keys());

/** One transcript's text with the results of its Workspace read calls replaced by a notice. Everything else is returned byte for byte. */
export function redactWorkspaceResults(text: string): { text: string; redacted: number; ids: Set<string> } {
  const notices = redactedCallIds(text);
  const ids = new Set(notices.keys());
  if (ids.size === 0 && !OWNER_BROWSER_RESULT.test(text)) return { text, redacted: 0, ids };
  let redacted = 0;
  const lines = text.split("\n").map((line) => {
    if (!line.includes("tool_use_id")) return line;
    let entry: Json | null;
    try { entry = object(JSON.parse(line)); } catch { return line; }
    if (!entry) return line;
    let notice: string | undefined;
    for (const block of blocks(entry)) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      if (!notices.has(block.tool_use_id) && (ownerBrowserResult(block.content) || ownerBrowserResult(entry.toolUseResult))) {
        notices.set(block.tool_use_id, BROWSER_REDACTION_NOTICE);
        ids.add(block.tool_use_id);
      }
      if (notices.has(block.tool_use_id)) {
        notice = notices.get(block.tool_use_id)!;
        block.content = notice;
      }
    }
    if (!notice) return line;
    if ("toolUseResult" in entry) entry.toolUseResult = notice;
    redacted += 1;
    return JSON.stringify(entry);
  });
  return { text: lines.join("\n"), redacted, ids };
}

/**
 * Redacts every `*.jsonl` under `root` in place (the session transcript and its subagent transcripts) and deletes the large results that Claude Code
 * persisted for a redacted call (`tool-results/<tool call id>.*`). A persisted result that cannot be read is deleted too (it may be the owner's; the check
 * fails closed) and reported to `onUnreadable`. Returns the number of results redacted.
 */
export function redactWorkspaceResultsIn(root: string, onUnreadable: (file: string, error: unknown) => void = () => undefined): number {
  let total = 0;
  const ids = new Set<string>();
  const resultDirs: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) {
        if (name === "tool-results") resultDirs.push(file); else walk(file);
        continue;
      }
      if (!stat.isFile() || !name.endsWith(".jsonl")) continue;
      const result = redactWorkspaceResults(fs.readFileSync(file, "utf8"));
      for (const id of result.ids) ids.add(id);
      if (result.redacted > 0) { fs.writeFileSync(file, result.text); total += result.redacted; }
    }
  };
  walk(root);
  for (const dir of resultDirs) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const owner = (() => {
        try { const stat = fs.lstatSync(file); return stat.isFile() && OWNER_BROWSER_RESULT.test(fs.readFileSync(file, "utf8")); }
        catch (error) { onUnreadable(file, error); return true; }
      })();
      if (owner || [...ids].some((id) => name === id || name.startsWith(`${id}.`))) fs.rmSync(file, { recursive: true, force: true });
    }
  }
  return total;
}
