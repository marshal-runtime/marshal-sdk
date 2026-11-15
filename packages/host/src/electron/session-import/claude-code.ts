import fs from "node:fs";
import path from "node:path";

import type { SessionMessage } from "../../common/marshal-ipc-contract";
import { MAX_NATIVE_STATE_BYTES } from "../backend/claude/native-state";
import {
  SYSTEM_REMINDER,
  claudeJsonlToDisplayMessages,
} from "../backend/claude/native-state-history";
import {
  isRecord,
  parseJsonRecord,
  stringField,
  type ImportCandidate,
  type ImportedSubagent,
  type ImportSourceScan,
  type LoadedConversation,
  type SessionImportPaths,
  type SessionImportSource,
} from "./sources";
import { titleFromPrompt, toIsoTimestamp } from "./transcript-builder";

const HEAD_BYTES = 256 * 1024;
const SESSION_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.jsonl$/;
const SUBAGENT_FILE = /^agent-([A-Za-z0-9_-]{1,64})\.jsonl$/;

interface DesktopSessionInfo {
  title?: string;
  cwd?: string;
}

interface SessionHead {
  sessionId?: string;
  entrypoint?: string;
  cwd?: string;
  createdAt?: string;
  summary?: string;
  firstPrompt?: string;
}

function promptText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const content = message["content"];
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(isRecord)
            .map((block) => (block["type"] === "text" ? stringField(block, "text") : undefined))
            .filter(Boolean)
            .join("\n")
        : undefined;
  const trimmed = text?.replace(SYSTEM_REMINDER, "").trim();
  if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("Caveat:")) return undefined;
  return trimmed;
}

/** `sidechain`: read a subagent's own file, where every entry is a side chain. */
function readHead(text: string, sidechain = false): SessionHead {
  const head: SessionHead = {};
  for (const line of text.split("\n")) {
    const entry = parseJsonRecord(line.trim() || undefined);
    if (!entry) continue;
    if (entry["type"] === "summary" && !head.summary) head.summary = stringField(entry, "summary");
    if ((entry["isSidechain"] === true) !== sidechain) continue;
    head.sessionId ??= stringField(entry, "sessionId");
    head.entrypoint ??= stringField(entry, "entrypoint");
    head.cwd ??= stringField(entry, "cwd");
    head.createdAt ??= toIsoTimestamp(entry["timestamp"]);
    if (!head.firstPrompt && entry["type"] === "user" && entry["isMeta"] !== true) {
      head.firstPrompt = promptText(entry["message"]);
    }
  }
  return head;
}

function transcript(bytes: Uint8Array, sidechain = false): SessionMessage[] {
  return claudeJsonlToDisplayMessages(bytes, { sidechain });
}

async function readFileHead(file: string): Promise<string> {
  const handle = await fs.promises.open(file, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    // Drop a line cut off at the read boundary.
    return bytesRead === HEAD_BYTES ? text.slice(0, text.lastIndexOf("\n")) : text;
  } finally {
    await handle.close();
  }
}

function appLabel(entrypoint: string | undefined, fromDesktop: boolean): string {
  if (fromDesktop || entrypoint === "claude-desktop") return "Claude app";
  if (entrypoint?.includes("vscode")) return "Claude Code (VS Code)";
  if (entrypoint?.includes("jetbrains")) return "Claude Code (JetBrains)";
  return "Claude Code CLI";
}

/** Sessions an SDK program started (automation, CI); they were never a person's chat. */
function isAutomated(entrypoint: string | undefined): boolean {
  return !!entrypoint && entrypoint.startsWith("sdk-");
}

/**
 * Claude Code: the CLI, the IDE extensions and the Claude desktop app all write the same JSONL
 * session files under `~/.claude/projects/<folder>/<session>.jsonl`. The desktop app also keeps
 * a small record per session (title, folder) that names the file by `cliSessionId`.
 */
export class ClaudeCodeImportSource implements SessionImportSource {
  readonly id = "claude-code" as const;

  constructor(private readonly paths: SessionImportPaths) {}

  private get projectsDir(): string {
    return path.join(this.paths.claudeConfigDir, "projects");
  }

  async scan(): Promise<ImportSourceScan> {
    const location = this.projectsDir;
    const summary = {
      id: this.id,
      label: "Claude Code",
      available: false,
      location,
      sessionCount: 0,
    };
    const files = await this.listSessionFiles();
    if (!files) return { summary, candidates: [] };
    const desktop = await this.readDesktopSessions();
    const candidates: ImportCandidate[] = [];
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop -- sequential reads keep file handles bounded
      const candidate = await this.describe(file, desktop).catch(() => null);
      if (candidate) candidates.push(candidate);
    }
    candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      summary: { ...summary, available: true, sessionCount: candidates.length },
      candidates,
    };
  }

  async load(externalId: string): Promise<LoadedConversation | null> {
    const file = await this.findFile(externalId);
    if (!file) return null;
    const stat = await fs.promises.stat(file);
    if (stat.size > MAX_NATIVE_STATE_BYTES)
      throw new Error("The session file is too large to import");
    const bytes = new Uint8Array(await fs.promises.readFile(file));
    const head = readHead(Buffer.from(bytes).toString("utf8"));
    const desktop = (await this.readDesktopSessions()).get(externalId);
    const updatedAt = stat.mtime.toISOString();
    const subagents = await this.loadSubagents(path.join(path.dirname(file), externalId));
    return {
      title:
        desktop?.title ?? head.summary ?? titleFromPrompt(head.firstPrompt, "Claude Code session"),
      cwd: desktop?.cwd ?? head.cwd,
      createdAt: head.createdAt ?? updatedAt,
      updatedAt,
      messages: transcript(bytes),
      claudeJsonl: bytes,
      ...(subagents.length ? { subagents } : {}),
    };
  }

  /**
   * `<session>/subagents/agent-<id>.jsonl`, with `agent-<id>.meta.json` holding the agent type and
   * the description the parent gave it. A subagent that cannot be read is left out.
   */
  private async listSubagentIds(sessionDir: string): Promise<string[]> {
    const names = await fs.promises
      .readdir(path.join(sessionDir, "subagents"))
      .catch(() => [] as string[]);
    return names.flatMap((name) => SUBAGENT_FILE.exec(name)?.[1] ?? []);
  }

  private async loadSubagents(sessionDir: string): Promise<ImportedSubagent[]> {
    const dir = path.join(sessionDir, "subagents");
    const subagents: ImportedSubagent[] = [];
    for (const agentId of await this.listSubagentIds(sessionDir)) {
      // eslint-disable-next-line no-await-in-loop -- one transcript in memory at a time
      const subagent = await this.loadSubagent(dir, agentId).catch(() => null);
      if (subagent) subagents.push(subagent);
    }
    return subagents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async loadSubagent(dir: string, agentId: string): Promise<ImportedSubagent | null> {
    const file = path.join(dir, `agent-${agentId}.jsonl`);
    const stat = await fs.promises.stat(file);
    if (stat.size > MAX_NATIVE_STATE_BYTES) return null;
    const bytes = new Uint8Array(await fs.promises.readFile(file));
    const messages = transcript(bytes, true);
    if (!messages.length) return null;
    const meta = parseJsonRecord(
      await fs.promises
        .readFile(path.join(dir, `agent-${agentId}.meta.json`), "utf8")
        .catch(() => ""),
    );
    const head = readHead(Buffer.from(bytes).toString("utf8"), true);
    const description = meta ? stringField(meta, "description") : undefined;
    const agentType = meta ? stringField(meta, "agentType") : undefined;
    const updatedAt = stat.mtime.toISOString();
    return {
      agentId,
      title: description?.trim() || titleFromPrompt(head.firstPrompt, "Claude Code subagent"),
      ...(agentType ? { agentType } : {}),
      ...(head.cwd ? { cwd: head.cwd } : {}),
      createdAt: head.createdAt ?? updatedAt,
      updatedAt,
      messages,
    };
  }

  private async describe(
    file: string,
    desktop: Map<string, DesktopSessionInfo>,
  ): Promise<ImportCandidate | null> {
    const externalId = path.basename(file, ".jsonl");
    const head = readHead(await readFileHead(file));
    const desktopInfo = desktop.get(externalId);
    if (!desktopInfo && isAutomated(head.entrypoint)) return null;
    if (!head.firstPrompt && !desktopInfo?.title) return null;
    const updatedAt = (await fs.promises.stat(file)).mtime.toISOString();
    const subagentIds = await this.listSubagentIds(path.join(path.dirname(file), externalId));
    return {
      source: this.id,
      externalId,
      ...(subagentIds.length ? { subagentIds } : {}),
      title:
        desktopInfo?.title ??
        head.summary ??
        titleFromPrompt(head.firstPrompt, "Claude Code session"),
      app: appLabel(head.entrypoint, !!desktopInfo),
      ...((desktopInfo?.cwd ?? head.cwd) ? { cwd: desktopInfo?.cwd ?? head.cwd } : {}),
      createdAt: head.createdAt ?? updatedAt,
      updatedAt,
    };
  }

  private async listSessionFiles(): Promise<string[] | null> {
    const projects = await fs.promises
      .readdir(this.projectsDir, { withFileTypes: true })
      .catch(() => null);
    if (!projects) return null;
    const files: string[] = [];
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = path.join(this.projectsDir, project.name);
      // eslint-disable-next-line no-await-in-loop -- one directory listing at a time
      const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isFile() && SESSION_FILE.test(entry.name)) files.push(path.join(dir, entry.name));
      }
    }
    return files;
  }

  private async findFile(externalId: string): Promise<string | null> {
    if (!SESSION_FILE.test(`${externalId}.jsonl`)) return null;
    const files = await this.listSessionFiles();
    return files?.find((file) => path.basename(file, ".jsonl") === externalId) ?? null;
  }

  /** `<app>/claude-code-sessions/<account>/<org>/local_<id>.json`, keyed by the CLI session id. */
  private async readDesktopSessions(): Promise<Map<string, DesktopSessionInfo>> {
    const sessions = new Map<string, DesktopSessionInfo>();
    const root = path.join(this.paths.claudeAppDir, "claude-code-sessions");
    const accounts = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const account of accounts) {
      if (!account.isDirectory()) continue;
      // eslint-disable-next-line no-await-in-loop -- shallow, bounded tree
      const orgs = await fs.promises
        .readdir(path.join(root, account.name), { withFileTypes: true })
        .catch(() => []);
      for (const org of orgs) {
        if (!org.isDirectory()) continue;
        const dir = path.join(root, account.name, org.name);
        // eslint-disable-next-line no-await-in-loop -- shallow, bounded tree
        const entries = await fs.promises.readdir(dir).catch(() => []);
        for (const name of entries) {
          if (!name.startsWith("local_") || !name.endsWith(".json")) continue;
          // eslint-disable-next-line no-await-in-loop -- small metadata files
          const text = await fs.promises
            .readFile(path.join(dir, name), "utf8")
            .catch(() => undefined);
          const record = parseJsonRecord(text);
          const cliSessionId = record ? stringField(record, "cliSessionId") : undefined;
          if (!record || !cliSessionId) continue;
          sessions.set(cliSessionId, {
            title: stringField(record, "title")?.trim() || undefined,
            cwd: stringField(record, "cwd") ?? stringField(record, "originCwd"),
          });
        }
      }
    }
    return sessions;
  }
}
