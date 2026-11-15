import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readExtensionSkills, parseFrontmatter } from "../src/extension-skills.js";
import { createMarshalHost } from "../src/host.js";

const SKILL = [
  "---",
  "name: brief-check",
  'description: "Check a page brief for a product, an audience and one offer before generating."',
  "---",
  "",
  "# Brief check",
  "",
  "Read references/checklist.md, then answer pass or fail.",
  "",
].join("\n");

function skillPackage(root: string, files: Record<string, string>, catalog: string[]): string {
  const packageRoot = path.join(root, "package");
  const write = (relative: string, content: string) => {
    const target = path.join(packageRoot, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write(
    "runtime-extension.json",
    JSON.stringify({
      schemaVersion: 1,
      identity: "@test/brief-skills",
      version: "1.0.0",
      entrypoint: "dist/index.cjs",
      moduleFormat: "commonjs-bundle-v1",
      contributes: { catalog },
    }),
  );
  write("package.json", JSON.stringify({ name: "@test/brief-skills", version: "1.0.0", type: "commonjs", main: "dist/index.cjs" }));
  write("dist/index.cjs", "module.exports = { activate() { return {}; } };");
  for (const [relative, content] of Object.entries(files)) write(relative, content);
  return packageRoot;
}

function scratch(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-skills-")));
}

test("an extension's declared skill is in runtime_search, readable, and named in the host prompt", async () => {
  const root = scratch();
  const packageRoot = skillPackage(
    root,
    { "skills/brief-check/SKILL.md": SKILL, "skills/brief-check/references/checklist.md": "- product\n- audience\n- one offer\n" },
    ["skill:skills/brief-check", "test:not-a-skill"],
  );
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath);
  const host = await createMarshalHost({
    workspacePath,
    stateRoot: path.join(root, "state"),
    extensions: [{ packageRoot }],
    browser: false,
    query: () => (async function* () {})(),
  });
  try {
    assert.deepEqual(
      host.skills.map((skill) => [skill.extension, skill.name, skill.uri]),
      [["@test/brief-skills", "brief-check", "skill://@test/brief-skills/brief-check"]],
    );
    const found = (await host.search("check a page brief", 20)) as { discoveries?: { entry: Record<string, any> }[] };
    const entry = (found.discoveries ?? []).map((item) => item.entry).find((item) => item.kind === "skill");
    assert.ok(entry, `no skill entry in ${JSON.stringify(found).slice(0, 500)}`);
    assert.equal(entry.id, "skill://@test/brief-skills/brief-check");
    assert.deepEqual(entry.action, { type: "resource_read", uri: "skill://@test/brief-skills/brief-check" });
    assert.deepEqual(entry.metadata.references, ["skill://@test/brief-skills/brief-check/references/checklist.md"]);
    assert.equal((await host.readResource("skill://@test/brief-skills/brief-check")).text, SKILL);
    assert.equal(
      (await host.readResource("skill://@test/brief-skills/brief-check/references/checklist.md")).text,
      "- product\n- audience\n- one offer\n",
    );
    const prompt = host.systemPrompt() ?? "";
    assert.match(prompt, /## Skills from installed extensions/);
    assert.match(prompt, /\*\*brief-check\*\* \(from `@test\/brief-skills`, `skill:\/\/@test\/brief-skills\/brief-check`\)/);
    assert.match(prompt, /mcp__marshal__runtime_read_resource/);
  } finally {
    await host.dispose();
  }
});

test("a host without extension skills adds no skills section", async () => {
  const root = scratch();
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath);
  const host = await createMarshalHost({ workspacePath, stateRoot: path.join(root, "state"), browser: false, query: () => (async function* () {})() });
  try {
    assert.deepEqual(host.skills, []);
    assert.doesNotMatch(host.systemPrompt() ?? "", /Skills from installed extensions/);
  } finally {
    await host.dispose();
  }
});

test("skill declarations are refused the way the runtime refuses them", () => {
  const cases: [Record<string, string>, string[], RegExp][] = [
    [{}, ["skill:skills/missing"], /SKILL\.md is missing/],
    [{ "skills/a/SKILL.md": "---\nname: a\n---\nbody" }, ["skill:skills/a"], /needs a description/],
    [{ "skills/a/SKILL.md": "---\nname: Bad\ndescription: d\n---\n" }, ["skill:skills/a"], /lowercase name/],
    [{}, ["skill:../outside"], /portable/],
  ];
  for (const [files, catalog, error] of cases) {
    assert.throws(() => readExtensionSkills(skillPackage(scratch(), files, catalog)), error);
  }
  assert.deepEqual(readExtensionSkills(skillPackage(scratch(), {}, ["other:entry", "skill://other/registered-in-code"])), []);
});

test("frontmatter: quoted, folded and literal values", () => {
  assert.deepEqual(parseFrontmatter("---\nname: 'x'\ndescription: >\n  one\n  two\nnote: |\n  a\n  b\n---\nbody"), {
    name: "x",
    description: "one two",
    note: "a\nb",
  });
});
