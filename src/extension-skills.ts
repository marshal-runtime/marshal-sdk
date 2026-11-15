import fs from "node:fs";
import path from "node:path";

/** `contributes.catalog` entries `skill:<package folder>` declare a skill (docs/kit.md, "Skills from extensions"). */
export const SKILL_CATALOG_PREFIX = "skill:";
const SKILL_FILE = "SKILL.md";
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SEGMENT = /^[A-Za-z0-9@._+-]+$/;
const REFERENCE_SUFFIXES = [".md", ".markdown", ".txt"];
const MAX_FILE_BYTES = 262_144;
const MAX_SKILLS = 64;
const MAX_REFERENCES = 64;

export interface ExtensionSkill {
  extension: string;
  name: string;
  description: string;
  uri: string;
  content: string;
  folder: string;
  references: { path: string; uri: string; content: string }[];
}

/**
 * The skills an extension package declares, read the way the runtime reads them (agent-runtime-extensions skills.ts):
 * same declaration, same URIs (`skill://<identity>/<name>[/<reference>]`), same refusals.
 */
export function readExtensionSkills(packageRoot: string): ExtensionSkill[] {
  const root = fs.realpathSync(packageRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "runtime-extension.json"), "utf8")) as {
    identity?: string;
    contributes?: { catalog?: unknown };
  };
  const identity = String(manifest.identity ?? "");
  const catalog = Array.isArray(manifest.contributes?.catalog) ? (manifest.contributes.catalog as unknown[]) : [];
  const folders = catalog
    // `skill://...` is the id of a skill entry an extension registers in code, not a folder declaration.
    .filter((entry): entry is string => typeof entry === "string" && entry.startsWith(SKILL_CATALOG_PREFIX) && !entry.startsWith(`${SKILL_CATALOG_PREFIX}//`))
    .map((entry) => entry.slice(SKILL_CATALOG_PREFIX.length));
  if (folders.length > MAX_SKILLS) throw new Error(`${identity} declares more than ${MAX_SKILLS} skills.`);
  const names = new Set<string>();
  return folders.map((folder) => {
    if (
      !folder ||
      folder.startsWith("/") ||
      folder.includes("\\") ||
      folder.split("/").some((segment) => !segment || segment === "." || segment === ".." || !SEGMENT.test(segment))
    ) {
      throw new Error(`${identity}: skill folder "${folder}" must be a portable package-relative path.`);
    }
    const directory = path.join(root, ...folder.split("/"));
    if (!fs.existsSync(path.join(directory, SKILL_FILE))) throw new Error(`${identity}: ${folder}/${SKILL_FILE} is missing.`);
    if (!fs.realpathSync(directory).startsWith(`${root}${path.sep}`)) throw new Error(`${identity}: skill folder "${folder}" leaves the package.`);
    const content = readText(path.join(directory, SKILL_FILE), `${identity}: ${folder}/${SKILL_FILE}`);
    const frontmatter = parseFrontmatter(content);
    const name = frontmatter.name ?? path.basename(directory);
    if (!NAME.test(name)) throw new Error(`${identity}: skill "${folder}" needs a lowercase name.`);
    if (names.has(name)) throw new Error(`${identity}: skill name "${name}" repeats.`);
    names.add(name);
    const description = frontmatter.description?.trim();
    if (!description || description.length > 1_024) throw new Error(`${identity}: skill "${name}" needs a description.`);
    const uri = `skill://${identity}/${name}`;
    const references = listFiles(directory)
      .filter((relative) => relative !== SKILL_FILE && REFERENCE_SUFFIXES.some((suffix) => relative.toLowerCase().endsWith(suffix)))
      // A nested declared skill owns its own files.
      .filter((relative) => !folders.some((other) => other !== folder && `${folder}/${relative}`.startsWith(`${other}/`) && other.length > folder.length))
      .sort();
    if (references.length > MAX_REFERENCES) throw new Error(`${identity}: skill "${name}" has more than ${MAX_REFERENCES} references.`);
    return {
      extension: identity,
      name,
      description,
      uri,
      content,
      folder,
      references: references.map((relative) => ({
        path: relative,
        uri: `${uri}/${relative}`,
        content: readText(path.join(directory, ...relative.split("/")), `${identity}: ${folder}/${relative}`),
      })),
    };
  });
}

/**
 * A provider source for runtimes that do not read the declaration themselves: `skill` catalog entries and their
 * resources, shaped like the runtime's own (so a host on newer packs sees the same entries from the runtime instead).
 */
export function extensionSkillSource(skills: readonly ExtensionSkill[]) {
  const entries = skills.map((skill) => ({
    id: skill.uri,
    kind: "skill" as const,
    title: skill.name,
    description: skill.description,
    tags: ["skill", "extension"],
    action: { type: "resource_read" as const, uri: skill.uri },
    metadata: {
      packageId: skill.extension,
      extensionIdentity: skill.extension,
      skillId: skill.name,
      references: skill.references.map((reference) => reference.uri),
    },
  }));
  const texts = new Map<string, string>();
  const descriptors: { uri: string; name: string; description?: string; mimeType: string }[] = [];
  for (const skill of skills) {
    texts.set(skill.uri, skill.content);
    descriptors.push({ uri: skill.uri, name: skill.name, description: skill.description, mimeType: "text/markdown" });
    for (const reference of skill.references) {
      texts.set(reference.uri, reference.content);
      descriptors.push({ uri: reference.uri, name: `${skill.name}: ${reference.path}`, mimeType: mimeOf(reference.uri) });
    }
  }
  return () => ({
    providers: [],
    catalog: {
      id: "marshal-sdk.extension-skills",
      list: () => entries,
      get: (id: string) => entries.find((entry) => entry.id === id),
    },
    resources: {
      listResources: async () => descriptors,
      readResource: async (uri: string) => {
        const text = texts.get(uri);
        if (text === undefined) throw Object.assign(new Error(`No extension skill resource ${uri}.`), { code: "not_found" });
        return { uri, mimeType: mimeOf(uri), text };
      },
    },
  });
}

/** The prompt section naming every installed extension's skills. */
export function extensionSkillsPrompt(skills: readonly ExtensionSkill[]): { id: string; text: string } | undefined {
  if (!skills.length) return undefined;
  return {
    id: "extension-skills",
    text: [
      "## Skills from installed extensions",
      "",
      "Each skill is a procedure an installed extension ships. Before you do work a skill covers, read it with `mcp__marshal__runtime_read_resource {uri}` and follow it; read the references it names the same way (their URIs are in the skill's runtime_search entry). Skill text comes from the extension's package, not from the user.",
      "",
      ...skills.map((skill) => `- **${skill.name}** (from \`${skill.extension}\`, \`${skill.uri}\`): ${skill.description.replace(/\s+/g, " ")}`),
    ].join("\n"),
  };
}

/** The frontmatter subset skills use: `key: value` (plain or quoted) and `|` / `>` blocks. */
export function parseFrontmatter(content: string): Record<string, string> {
  const lines = content.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return {};
  const result: Record<string, string> = {};
  for (let index = 1; index < end; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[index]!);
    if (!match) continue;
    let value = match[2]!.trim();
    if (["|", ">", "|-", ">-"].includes(value)) {
      const block: string[] = [];
      while (index + 1 < end && (/^\s+\S/.test(lines[index + 1]!) || !lines[index + 1]!.trim())) block.push(lines[++index]!.trim());
      value = value.startsWith("|") ? block.join("\n").trim() : block.join(" ").replace(/\s+/g, " ").trim();
    } else if (/^".*"$/.test(value)) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (/^'.*'$/.test(value)) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    result[match[1]!] = value;
  }
  return result;
}

function listFiles(directory: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.isSymbolicLink()) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) found.push(relative);
  }
  return found;
}

function readText(file: string, label: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new Error(`${label} is missing.`);
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`${label} is not a file under ${MAX_FILE_BYTES} bytes.`);
  return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
}

function mimeOf(uri: string): string {
  return uri.toLowerCase().endsWith(".txt") ? "text/plain" : "text/markdown";
}
