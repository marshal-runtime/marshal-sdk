import fs from "node:fs";
import path from "node:path";

/**
 * Repository rules for a session's system prompt, read the way the Marshal desktop reads them
 * (electron/backend/local/repository-customizations.ts at desktop 36452cec2: loadRepositoryInstructions and the
 * instruction part of getRepositoryCustomizationsForSystemPrompt, without the lean index). A runtime loads its own
 * convention natively (Claude: CLAUDE.md, .claude/CLAUDE.md, .claude/rules through the project setting source);
 * this forwards the rest (AGENTS.md, .github/copilot-instructions.md and instructions/, .cursor/rules) into the
 * prompt. Path-scoped rules are listed, not inlined.
 */

export interface RepositoryInstruction {
  path: string;
  content: string;
  source: "copilot" | "cursor" | "claude" | "shared";
  alwaysApply: boolean;
  appliesTo?: string[];
  description?: string;
}

const MAX_RULE_BYTES = 128 * 1024;

function isWithinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function realpathWithin(root: string, candidate: string): string | null {
  try {
    const canonicalRoot = fs.realpathSync(root);
    const canonical = fs.realpathSync(candidate);
    return isWithinDirectory(canonicalRoot, canonical) ? canonical : null;
  } catch {
    return null;
  }
}

function readMarkdownFile(filePath: string, allowedRoot: string): string | null {
  try {
    const resolved = realpathWithin(allowedRoot, filePath);
    if (!resolved) return null;
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_RULE_BYTES) return null;
    return fs.readFileSync(resolved, "utf8").replace(/\r\n/g, "\n").trim() || null;
  } catch {
    return null;
  }
}

function listMarkdownFiles(rootDir: string, matcher: (fileName: string) => boolean): string[] {
  const files: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath, depth + 1);
      else if (entry.isFile() && matcher(entry.name)) files.push(fullPath);
    }
  };
  visit(rootDir, 0);
  return files.sort((left, right) => left.localeCompare(right));
}

function stripYamlQuotes(value: string): string {
  if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function readInstruction(root: string, filePath: string, allowedRoot: string): RepositoryInstruction | null {
  const content = readMarkdownFile(filePath, allowedRoot);
  if (!content) return null;
  const relativePath = path.relative(root, filePath).replace(/\\/g, "/");
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1];
  const applicabilityField = frontmatter.match(/^(?:globs|paths|applyTo):\s*(.*)$/m);
  const inlinePatterns = applicabilityField?.[1]?.trim() ?? "";
  const patterns = inlinePatterns
    ? inlinePatterns
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((value) => stripYamlQuotes(value.trim()))
        .filter(Boolean)
    : [];
  if (applicabilityField && patterns.length === 0) {
    const remainder = frontmatter.slice(frontmatter.indexOf(applicabilityField[0]) + applicabilityField[0].length);
    for (const match of remainder.matchAll(/^\s*-\s*(.+)$/gm)) {
      const value = stripYamlQuotes(match[1]!.trim());
      if (value) patterns.push(value);
    }
  }
  const base = path.basename(filePath);
  const nested = (base === "AGENTS.md" || base === "CLAUDE.md") && path.dirname(relativePath) !== "." && relativePath !== ".claude/CLAUDE.md";
  if (nested && patterns.length === 0) patterns.push(`${path.dirname(relativePath)}/**`);
  const cursorRule = relativePath.startsWith(".cursor/rules/");
  const explicitAlways = /^alwaysApply:\s*true\s*$/m.test(frontmatter);
  const explicitDynamic = /^alwaysApply:\s*false\s*$/m.test(frontmatter);
  const alwaysApply = explicitAlways ? true : explicitDynamic || patterns.length > 0 || nested ? false : !cursorRule;
  const source: RepositoryInstruction["source"] = relativePath.startsWith(".github/")
    ? "copilot"
    : relativePath.startsWith(".cursor/")
      ? "cursor"
      : relativePath.startsWith(".claude/") || base === "CLAUDE.md"
        ? "claude"
        : "shared";
  return {
    path: relativePath,
    content,
    source,
    alwaysApply,
    ...(patterns.length > 0 ? { appliesTo: patterns } : {}),
    ...(description ? { description: stripYamlQuotes(description.trim()) } : {}),
  };
}

function hierarchicalInstructionFiles(root: string): RepositoryInstruction[] {
  const found: RepositoryInstruction[] = [];
  const ignored = new Set([".git", "node_modules", "dist", "build", "coverage"]);
  const visit = (directory: string, depth: number) => {
    if (depth > 6 || found.length >= 64) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= 64) break;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !ignored.has(entry.name)) visit(candidate, depth + 1);
        continue;
      }
      if (!entry.isFile() || (entry.name !== "AGENTS.md" && entry.name !== "CLAUDE.md")) continue;
      const item = readInstruction(root, candidate, root);
      if (item) found.push(item);
    }
  };
  visit(root, 0);
  return found;
}

function ruleDirectory(root: string, directory: string, matcher: (name: string) => boolean): RepositoryInstruction[] {
  const resolved = realpathWithin(root, directory);
  if (!resolved) return [];
  return listMarkdownFiles(resolved, matcher)
    .map((filePath) => readInstruction(root, filePath, resolved))
    .filter((item): item is RepositoryInstruction => item !== null);
}

/** Every rule file of the repository at `repoRoot`, by the desktop's conventions. */
export function loadRepositoryInstructions(repoRoot: string | undefined): RepositoryInstruction[] {
  if (!repoRoot) return [];
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(repoRoot));
  } catch {
    return [];
  }
  const instructions: RepositoryInstruction[] = [];
  const githubDir = realpathWithin(root, path.join(root, ".github"));
  if (githubDir) {
    const rootItem = readInstruction(root, path.join(githubDir, "copilot-instructions.md"), githubDir);
    if (rootItem) instructions.push(rootItem);
    const instructionsDir = realpathWithin(githubDir, path.join(githubDir, "instructions"));
    if (instructionsDir) {
      for (const filePath of listMarkdownFiles(instructionsDir, (name) => name.endsWith(".instructions.md"))) {
        const item = readInstruction(root, filePath, githubDir);
        if (item) instructions.push(item);
      }
    }
  }
  instructions.push(...hierarchicalInstructionFiles(root));
  const claudeDotFile = readInstruction(root, path.join(root, ".claude", "CLAUDE.md"), root);
  if (claudeDotFile) instructions.push(claudeDotFile);
  instructions.push(
    ...ruleDirectory(root, path.join(root, ".cursor", "rules"), (name) => name.endsWith(".mdc")),
    ...ruleDirectory(root, path.join(root, ".claude", "rules"), (name) => name.endsWith(".md")),
  );
  return instructions.filter((item, index, all) => all.findIndex((candidate) => candidate.path === item.path) === index);
}

/** The conventions a runtime reads by itself; their files are not forwarded again. */
function nativeSources(runtimeId: string): ReadonlySet<RepositoryInstruction["source"]> {
  if (runtimeId === "cursor") return new Set(["cursor", "shared"]);
  if (runtimeId === "claude") return new Set(["claude"]);
  return new Set();
}

/**
 * The "Repository Instructions" prompt section for a session on `runtimeId` in `repoRoot`, or "" when the
 * repository has no rule the runtime doesn't already load. Text matches the desktop's section.
 */
export function repositoryRulesPrompt(repoRoot: string | undefined, runtimeId: string): string {
  const native = nativeSources(runtimeId);
  const forwarded = loadRepositoryInstructions(repoRoot).filter(
    // Codex's app-server loads the root AGENTS.md itself.
    (item) => !native.has(item.source) && !(runtimeId === "codex" && item.source === "shared" && item.path === "AGENTS.md"),
  );
  if (forwarded.length === 0) return "";
  const always = forwarded.filter((item) => item.alwaysApply);
  const scoped = forwarded.filter((item) => !item.alwaysApply);
  const blocks = always.map((item) => `### ${item.path}\n\n${item.content}`);
  const scopedBlock = scoped.length
    ? `\n\n### Scoped Repository Rules\nThese rule bodies remain in the repository. Read the matching file before working in its scope:\n${scoped
        .map(
          (item) =>
            `- ${item.path}${item.description ? `: ${item.description}` : ""}${item.appliesTo?.length ? ` (applies to ${item.appliesTo.join(", ")})` : " (apply intelligently when relevant)"}`,
        )
        .join("\n")}`
    : "";
  return `## Repository Instructions
The following user-authored repository customizations were discovered across supported agent conventions. More specific workspace instructions override general ones when they conflict:

${blocks.join("\n\n")}${scopedBlock}`;
}
