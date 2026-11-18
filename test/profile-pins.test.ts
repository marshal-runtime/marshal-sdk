import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { systemPromptText } from "../src/agent-port.js";
import { createMarshalHost } from "../src/host.js";
import { PROFILE_PINS } from "../src/profile.js";

function skillPackage(root: string, identity: string, skill: string): string {
  const packageRoot = path.join(root, identity.replace(/[^a-z]/g, "-"));
  const write = (relative: string, content: string) => {
    const target = path.join(packageRoot, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write(
    "runtime-extension.json",
    JSON.stringify({ schemaVersion: 1, identity, version: "1.0.0", entrypoint: "dist/index.cjs", moduleFormat: "commonjs-bundle-v1", contributes: { catalog: [`skill:skills/${skill}`] } }),
  );
  write("package.json", JSON.stringify({ name: identity, version: "1.0.0", type: "commonjs", main: "dist/index.cjs" }));
  write("dist/index.cjs", "module.exports = { activate() { return {}; } };");
  write(`skills/${skill}/SKILL.md`, `---\nname: ${skill}\ndescription: "Skill ${skill} of ${identity}, for the profile pin test."\n---\n\n# ${skill}\n`);
  return packageRoot;
}

async function rig() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-pins-")));
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath);
  const calls: Record<string, any>[] = [];
  const host = await createMarshalHost({
    workspacePath,
    stateRoot: path.join(root, "state"),
    extensions: [{ packageRoot: skillPackage(root, "@test/alpha", "alpha-skill") }, { packageRoot: skillPackage(root, "@test/beta", "beta-skill") }],
    browser: false,
    query: ({ options }: { options: Record<string, any> }) => {
      calls.push(options);
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: `native-${calls.length}` };
        yield { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, usage: {} };
      })();
    },
  } as never);
  const launch = async (key: string, profile: Record<string, unknown>) => {
    const agent = host.agents.launch({ task: "t", idempotencyKey: key, ...profile });
    await host.agents.wait(agent.id);
    return agent.id;
  };
  return { host, calls, launch };
}

const skillNames = (found: unknown) =>
  ((found as { discoveries?: { entry: Record<string, any> }[] }).discoveries ?? [])
    .map((item) => item.entry)
    .filter((entry) => entry.kind === "skill")
    .map((entry) => String(entry.id));

// One case per pin: a pin the host accepts must change what the session sees. Adding a name to PROFILE_PINS without
// a case fails typecheck; a case whose pin has no effect fails here.
const EFFECTS: Record<(typeof PROFILE_PINS)[number], (r: Awaited<ReturnType<typeof rig>>) => Promise<void>> = {
  async extensions({ host, launch }) {
    const alpha = await launch("ext", { extensions: ["@test/alpha"] });
    const unscoped = await launch("ext-none", {});
    assert.deepEqual(skillNames(await host.search("skill", 30, alpha)).sort(), ["skill://@test/alpha/alpha-skill"]);
    assert.deepEqual(skillNames(await host.search("skill", 30, unscoped)).sort(), ["skill://@test/alpha/alpha-skill", "skill://@test/beta/beta-skill"]);
    assert.match(host.systemPrompt(alpha) ?? "", /alpha-skill/);
    assert.doesNotMatch(host.systemPrompt(alpha) ?? "", /beta-skill/);
    assert.match(host.systemPrompt(unscoped) ?? "", /beta-skill/);
    await assert.rejects(host.readResource("skill://@test/beta/beta-skill", alpha));
    assert.match((await host.readResource("skill://@test/alpha/alpha-skill", alpha)).text ?? "", /# alpha-skill/);
  },
  async skills({ host, launch }) {
    const named = await launch("skills", { skills: ["beta-skill"] });
    assert.match(host.systemPrompt(named) ?? "", /beta-skill/);
    assert.doesNotMatch(host.systemPrompt(named) ?? "", /alpha-skill/);
    await assert.rejects(host.readResource("skill://@test/alpha/alpha-skill", named), /not part of this agent's profile/);
    assert.match((await host.readResource("skill://@test/beta/beta-skill", named)).text ?? "", /# beta-skill/);
  },
  async mcpServers({ calls, launch }) {
    await launch("mcp-all", {});
    await launch("mcp-none", { mcpServerNames: ["no-such-server"] });
    assert.ok(Object.keys(calls[0]!.mcpServers).length > 0, "the host's default MCP servers reach the session");
    assert.deepEqual(Object.keys(calls[1]!.mcpServers), []);
  },
  async systemPromptAppend({ calls, launch }) {
    await launch("plain", {});
    await launch("append", { systemPromptAppend: "PROFILE-APPEND-LINE" });
    assert.doesNotMatch(systemPromptText(calls[0]!.systemPrompt) ?? "", /PROFILE-APPEND-LINE/);
    assert.match(systemPromptText(calls[1]!.systemPrompt) ?? "", /PROFILE-APPEND-LINE\s*$/);
  },
  async nativeTools({ calls, launch }) {
    await launch("tools", { nativeTools: ["Read", "Bash"] });
    assert.deepEqual(calls[0]!.tools, ["Read", "Bash"]);
  },
};

for (const pin of PROFILE_PINS) {
  test(`profile pin ${pin} takes effect on the SDK host`, async () => {
    const r = await rig();
    try {
      await EFFECTS[pin](r);
    } finally {
      await r.host.dispose();
    }
  });
}
