// Proves the kit's extension packages load in a Marshal runtime host and serve the kit's contracts:
//
//   node extensions/agent-kit/scripts/load-proof.mjs
//
// Builds the packages (build-extensions.mjs), installs them through the SDK's RuntimeExtensionManager with the local package loader (integrity
// checked, the bundle evaluated with only the loader's reviewed builtins), then resolves @marshal/agent-kit:channel and @marshal/agent-kit:sandbox
// from the host's service container and drives each: a Slack send through a recorded Web API call, a Daytona ensure and spawn through host doubles
// of Marley's provider, ssh runner and model proxy (the proxy session closes and the tunnel port is released when the process exits).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(kit, "../..");
const requireFromSdk = createRequire(path.join(root, "package.json"));
const load = async (name) => import(pathToFileURL(requireFromSdk.resolve(name)).href);
const composer = await load("@marshal/agent-runtime-composer");
const core = await load("@marshal/agent-runtime-core");
const extensions = await load("@marshal/agent-runtime-extensions");

const work = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "agent-kit-load-proof-"));
const packages = path.join(work, "packages");
execFileSync(process.execPath, [path.join(kit, "scripts/build-extensions.mjs"), "--out", packages], { stdio: "inherit" });

// The host's side: the services the extensions read.
const services = composer.createRuntimeServiceContainer();
const slackCalls = [];
const slackUploads = [];
await services.bind(Symbol.for("@marshal/agent-kit:slack-host"), {
  useValue: {
    call: async (method, body, form) => {
      slackCalls.push(form ? { method, body, form } : { method, body });
      if (method === "files.getUploadURLExternal") return { ok: true, upload_url: "https://files.slack.com/upload/v1/proof", file_id: "F0PROOF" };
      return method === "reactions.add" && body.name === "rotating_light" ? { ok: false, error: "invalid_name" } : { ok: true, ts: "1763900000.000100" };
    },
    pickReaction: async (text) => (text.includes("urgent") ? "rotating_light" : "heart"),
    speak: async (part) => ({ data: Buffer.from(`OggS:${part.text}:${part.lang}`), mimeType: "audio/ogg" }),
    upload: async (url, data, mimeType) => void slackUploads.push({ url, bytes: data.length, mimeType }),
  },
});
const githubComments = [];
await services.bind(Symbol.for("@marshal/agent-kit:github-host"), {
  useValue: { comment: async (repo, number, body) => (githubComments.push({ repo, number, body }), `https://github.com/${repo}/issues/${number}#issuecomment-${githubComments.length}`) },
});
const daytonaLog = [];
const proxySessions = [];
const spawned = [];
await services.bind(Symbol.for("@marshal/agent-kit:daytona-host"), {
  useValue: {
    provider: {
      ensure: async (brandId, reason) => (daytonaLog.push(["ensure", brandId, reason]), { hostId: "dt:sbx-proof", target: { kind: "daytona", sandboxId: "sbx-proof" } }),
      stop: async (brandId) => void daytonaLog.push(["stop", brandId]),
    },
    ssh: {
      paths: (brandId, chat) => ({ work: chat ? `/srv/zygstinct/brands/${brandId}/chats/proof/work` : `/srv/zygstinct/brands/${brandId}/work` }),
      spawner: (input) => (options) => {
        const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), killed: false, exitCode: null, kill: () => true });
        spawned.push({ input, options, child });
        return child;
      },
    },
    proxy: {
      port: () => 47100,
      open: (brandId, key, role) => {
        const session = { brandId, key, role, dummyKey: `dummy-${key}`, closed: false };
        proxySessions.push(session);
        return { dummyKey: session.dummyKey, close: () => void (session.closed = true), costUsd: () => 0, unavailable: () => null, refusal: () => null, calls: () => 0 };
      },
    },
  },
});

const kernel = core.createRuntimeKernel();
const manager = new extensions.RuntimeExtensionManager({
  kernel,
  services,
  loader: new extensions.LocalRuntimeExtensionPackageLoader({ allowedRoots: [fs.realpathSync(packages)], modules: extensions.createNodeBuiltinModuleMap() }),
  activationContext: { principal: { id: "agent-kit-load-proof", kind: "agent" }, scope: { workspaceId: "agent-kit" } },
  stateStore: new extensions.JsonFileRuntimeExtensionStateStore(path.join(work, "extension-state.json")),
});
for (const name of ["slack", "github", "daytona"]) {
  const packageRoot = fs.realpathSync(path.join(packages, name));
  const record = await manager.install({ packageRoot, integrity: extensions.computeRuntimeExtensionIntegrity(packageRoot) });
  console.log(`installed ${record.identity ?? record.manifest?.identity}@${record.version ?? record.manifest?.version}: ${record.state ?? record.status ?? "?"}`);
}
console.log("manager:", manager.list().map((entry) => `${entry.identity ?? entry.manifest?.identity}=${entry.state ?? entry.status}`).join(" "));

// The channel: one Slack binding among the host's channels.
const channels = services.getAll(Symbol.for("@marshal/agent-kit:channel"));
assert.deepEqual(channels.map((channel) => channel.kind), ["slack", "github"]);
const key = { brandId: "zyg-agents", channel: "slack", conversationId: "D0PROOF:1763899999.000200" };
const origin = { pendingIds: [1], turnId: "turn-proof", memberId: "U0PROOF" };
const part = { kind: "text", text: "proof: the kit's Slack channel posts this", lang: "en", voiceName: null };
assert.equal(await channels[0].send(key, part, "idem-1", origin), "sent");
assert.equal(await channels[0].send(key, part, "idem-1", origin), "sent");
assert.equal(slackCalls.length, 1, "a key already posted is not posted again");
assert.deepEqual(slackCalls[0], { method: "chat.postMessage", body: { channel: "D0PROOF", text: part.text, thread_ts: "1763899999.000200" } });
assert.equal(await channels[0].send(key, { ...part, text: " " }, "idem-2", origin), "refused");
slackCalls.length = 0;
assert.deepEqual(await channels[0].post(key, { kind: "voice", text: "the deploy is green", lang: "en", voiceName: null }, "idem-v"), { outcome: "sent", id: "F0PROOF" });
assert.deepEqual(slackUploads, [{ url: "https://files.slack.com/upload/v1/proof", bytes: Buffer.from("OggS:the deploy is green:en").length, mimeType: "audio/ogg" }]);
assert.deepEqual(slackCalls.map((entry) => [entry.method, entry.form]), [["files.getUploadURLExternal", true], ["files.completeUploadExternal", true]]);
assert.deepEqual(slackCalls[0].body, { filename: "voice.ogg", length: String(Buffer.from("OggS:the deploy is green:en").length) });
assert.deepEqual(slackCalls[1].body, { files: [{ id: "F0PROOF", title: "Voice note" }], channel_id: "D0PROOF", thread_ts: "1763899999.000200" });
slackCalls.length = 0;
assert.deepEqual(await channels[0].post(key, { kind: "text", text: "posted" }, "idem-p"), { outcome: "sent", id: "1763900000.000100" });
slackCalls.length = 0;
await channels[0].acknowledge(key, "slack:D0PROOF:1763899999.000300", "thanks!");
await channels[0].acknowledge(key, "slack:D0PROOF:1763899999.000400", "urgent: prod is down");
assert.deepEqual(slackCalls.map((entry) => [entry.body.timestamp, entry.body.name]), [["1763899999.000300", "heart"], ["1763899999.000400", "rotating_light"], ["1763899999.000400", "eyes"]]);
console.log("channel @marshal/agent-kit:channel -> slack: sent once in the thread, deduped, a voice part spoken by the host and uploaded into the thread, post gives the ts, acknowledge reacts with the picked reaction (eyes when Slack refuses it)");
const prKey = { brandId: "zyg-agents", channel: "github", conversationId: "zyg-edge/zyg-agents:2004" };
assert.deepEqual(await channels[1].post(prKey, { kind: "text", text: "on it" }, "gh-1"), { outcome: "sent", id: "https://github.com/zyg-edge/zyg-agents/issues/2004#issuecomment-1" });
assert.equal(await channels[1].send(prKey, part, "gh-1", origin), "sent");
assert.equal(await channels[1].send({ ...prKey, conversationId: "zyg-edge/zyg-agents" }, part, "gh-2", origin), "refused");
assert.deepEqual(githubComments, [{ repo: "zyg-edge/zyg-agents", number: 2004, body: "on it" }]);
console.log("channel @marshal/agent-kit:channel -> github: one comment through the host, its URL as the id, deduped, no issue number refused");

// The sandbox: Daytona, routed through the host's provider, ssh runner and proxy.
const sandbox = services.get(Symbol.for("@marshal/agent-kit:sandbox"));
assert.equal(sandbox.kind, "daytona");
const brand = "11111111-2222-4333-8444-555555555555";
const target = await sandbox.ensure(brand, "turn");
assert.deepEqual(target, { id: "dt:sbx-proof", workDir: `/srv/zygstinct/brands/${brand}/work` });
const abort = new AbortController();
const chat = { brandId: brand, channel: "slack", conversationId: "D0PROOF" };
const child = sandbox.spawn(target, { scope: brand, conversation: chat, runId: "run-proof", front: true }, { command: "claude", args: ["--print"], cwd: undefined, env: {}, signal: abort.signal });
assert.equal(spawned.length, 1);
const { input } = spawned[0];
assert.equal(input.brandId, brand);
assert.deepEqual(input.ip, { kind: "daytona", sandboxId: "sbx-proof" });
assert.equal(input.proxyPort, 47100);
assert.equal(input.dummyKey, "dummy-run-proof");
assert.ok(input.remotePort >= 41000 && input.remotePort <= 45999);
assert.equal(input.cwd, `/srv/zygstinct/brands/${brand}/chats/proof/work`);
assert.deepEqual(proxySessions[0].role, { front: true, chat: `${brand}|slack|D0PROOF` });
assert.equal(proxySessions[0].closed, false);
child.emit("exit", 0, null);
assert.equal(proxySessions[0].closed, true, "the proxy session closes when the process exits");
sandbox.spawn(target, { scope: brand, runId: "run-proof-2" }, { command: "claude", args: [], env: {}, signal: abort.signal });
assert.equal(spawned[1].input.remotePort, input.remotePort + 1, "the next session takes the next tunnel port");
assert.deepEqual(proxySessions[1].role, { front: false, chat: null });
await sandbox.stop(brand);
assert.throws(() => sandbox.spawn(target, { scope: brand, runId: "run-proof-3" }, { command: "claude", args: [], env: {}, signal: abort.signal }), /no Daytona target/);
assert.deepEqual(daytonaLog, [["ensure", brand, "turn"], ["stop", brand]]);
console.log("sandbox @marshal/agent-kit:sandbox -> daytona: ensure via provider, spawn via proxy+port+ssh, proxy session closed on exit, stop forgets the target");

// The host entry: an engine asks the kit for a session's Agent SDK options and its outbox send, over whatever the extensions bound.
const { build } = await import("esbuild");
const hostBundle = path.join(work, "bindings.mjs");
await build({ entryPoints: [path.join(kit, "src/bindings.ts")], outfile: hostBundle, bundle: true, format: "esm", platform: "node", logLevel: "warning", external: ["@anthropic-ai/claude-agent-sdk"] });
const host = await import(pathToFileURL(hostBundle).href);
const bindings = host.kitBindings(services);
assert.equal(bindings.sandbox.kind, "daytona");
assert.deepEqual(bindings.channels.map((channel) => channel.kind), ["slack", "github"]);
assert.equal(await bindings.send(key, { ...part, text: "via the host entry" }, "idem-3", origin), "sent");
assert.equal(await bindings.send({ ...key, channel: "whatsapp" }, part, "idem-4", origin), "refused");
const sdkOptions = await host.sandboxSessionOptions(services, { scope: brand, conversation: chat, runId: "run-host", front: true }, "turn");
assert.equal(sdkOptions.cwd, `/srv/zygstinct/brands/${brand}/work`);
const hostChild = sdkOptions.spawnClaudeCodeProcess({ command: "claude", args: [], env: {}, signal: abort.signal });
assert.equal(spawned.at(-1).child, hostChild);
assert.equal(spawned.at(-1).input.dummyKey, "dummy-run-host");
console.log("host entry: kitBindings sends through the bound channel (unbound kind refused); sandboxSessionOptions gives the SDK cwd + spawnClaudeCodeProcess in the ensured sandbox");

// Swapping a binding is installing another extension: removing the Daytona one leaves no sandbox.
await manager.remove("@marshal/agent-kit-daytona");
assert.equal(services.tryGet(Symbol.for("@marshal/agent-kit:sandbox")), undefined);
await assert.rejects(host.sandboxSessionOptions(services, { scope: brand, runId: "run-none" }, "turn"), { name: "NoSandboxError" });
console.log("removed @marshal/agent-kit-daytona: no sandbox bound");
console.log("LOAD PROOF OK");
fs.rmSync(work, { recursive: true, force: true });
