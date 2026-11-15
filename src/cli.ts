#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import type { MarshalHostOptions } from "./host.js";
import { ONBOARDING_USAGE, onboardingCommand, withManifest } from "./onboarding-cli.js";
import { startLinkServer } from "./link/server.js";
import { FileSessionStore } from "./session-store.js";

const USAGE = `marshal-sdk <command> [options]

  exec      Call one runtime capability on a headless Marshal host and print its output.
              --capability <name> [--input <json | @file>]
  agent     Start one Marshal session with a task and print its last message.
              --task <text | @file> [--name <title>]
  page-run  One Page Studio page from an agent-sandbox page-agent input folder, in its run contract.
              --input <dir> --out <dir> --logs <dir> --state <dir> [--fake] (page-run --help for the rest)
  sessions  List or search the sessions a host wrote.
              --state <dir> [--search <words>] [--run <id>] [--transcript <session id>]
  serve     Serve a host over the link (docs/link.md) so another Marshal can watch and drive it.
              Live: the host options below, plus [--task <text | @file> [--name <title>]] to start a session.
              Store-only (a finished run, no runtime): --store <state dir> [--native-root <claude dir>]...
              --token-file <file> or $MARSHAL_SDK_LINK_TOKEN (required, 16+ chars)
              [--bind <address>] (default 127.0.0.1) [--port <n>] (default 7781) [--files name=<dir>]...
              [--page-studio-dir <dir>] serves the pages a run made there (default: $PAGE_STUDIO_DIR on a live host)

${ONBOARDING_USAGE}
Host options (exec, agent, serve):
  --manifest <file>          the marshal-sdk.json to load (default: $MARSHAL_SDK_MANIFEST, else ./marshal-sdk.json)
  --cache <dir>              where registry and .tgz extensions are unpacked
  --workspace <dir>          where sessions work (required)
  --state <dir>              host-private folder outside the workspace (required)
  --extension <packageRoot>  a built runtime extension to load; repeatable
  --model <id>  --effort <low|medium|high|xhigh|max>
  --claude-config-dir <dir>  run the backend on that Claude account and drop ANTHROPIC_API_KEY
  --host-id <id>  --host-kind <local|container|e2b>  --label key=value (repeatable)
  --no-browser               do not give sessions a headless browser
`;

interface Arguments {
  command: string;
  values: Map<string, string[]>;
  flags: Set<string>;
}

function parse(argv: readonly string[]): Arguments {
  const [command = "", ...rest] = argv;
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}.`);
    const name = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.add(name);
    } else {
      values.set(name, [...(values.get(name) ?? []), next]);
      index += 1;
    }
  }
  return { command, values, flags };
}

const one = (args: Arguments, name: string): string | undefined => args.values.get(name)?.at(-1);

function required(args: Arguments, name: string): string {
  const value = one(args, name);
  if (!value) throw new Error(`--${name} is required.\n\n${USAGE}`);
  return value;
}

const textArgument = (value: string): string => (value.startsWith("@") ? fs.readFileSync(value.slice(1), "utf8") : value);

function hostOptions(args: Arguments): MarshalHostOptions {
  const configDir = one(args, "claude-config-dir");
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  if (configDir) {
    env.CLAUDE_CONFIG_DIR = path.resolve(configDir);
    delete env.ANTHROPIC_API_KEY;
  }
  const labels = Object.fromEntries(
    (args.values.get("label") ?? []).map((pair) => {
      const at = pair.indexOf("=");
      if (at <= 0) throw new Error(`--label takes key=value, got ${pair}.`);
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );
  const model = one(args, "model");
  const effort = one(args, "effort");
  return {
    workspacePath: path.resolve(required(args, "workspace")),
    stateRoot: path.resolve(required(args, "state")),
    extensions: (args.values.get("extension") ?? []).map((packageRoot) => ({ packageRoot: path.resolve(packageRoot) })),
    host: { id: one(args, "host-id") ?? "marshal-sdk", kind: one(args, "host-kind") ?? "local" },
    labels,
    env,
    browser: !args.flags.has("no-browser"),
    ...(model ? { model } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
    log: (line) => process.stderr.write(`[marshal-sdk] ${line}\n`),
  };
}

async function main(): Promise<void> {
  if (process.argv[2] === "page-run") {
    const { pageRunCommand } = await import("./page-run.js");
    process.exitCode = await pageRunCommand(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "init" || process.argv[2] === "extensions") {
    process.exitCode = await onboardingCommand(process.argv[2], process.argv.slice(3));
    return;
  }
  const args = parse(process.argv.slice(2));
  if (args.command === "sessions") {
    const root = path.join(path.resolve(required(args, "state")), "sessions");
    const store = new FileSessionStore(root, { runId: "reader", host: { id: "reader", kind: "local" } });
    const transcript = one(args, "transcript");
    const search = one(args, "search");
    const output = transcript
      ? { session: store.get(transcript), messages: store.messages(transcript) }
      : search
        ? store.search(search)
        : store.list(one(args, "run") ? { runId: one(args, "run")! } : {});
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  if (args.command === "serve") return serve(args);
  if (args.command !== "exec" && args.command !== "agent") {
    process.stdout.write(USAGE);
    process.exitCode = args.command ? 2 : 0;
    return;
  }
  const options = await withManifest(hostOptions(args), manifestFlags(args));
  const { createMarshalHost } = await import("./host.js");
  const host = await createMarshalHost(options);
  try {
    if (args.command === "exec") {
      const input = one(args, "input");
      const output = await host.invoke(required(args, "capability"), input ? JSON.parse(textArgument(input)) : {});
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return;
    }
    const agent = host.agents.launch({
      task: textArgument(required(args, "task")),
      idempotencyKey: `cli-${host.runId}`,
      ...(one(args, "name") ? { name: one(args, "name")! } : {}),
      labels: options.labels,
    });
    for (;;) {
      const waited = await host.agents.wait(agent.id);
      if (waited.state === "completed") {
        process.stdout.write(`${JSON.stringify({ runId: host.runId, agent: waited.agent, result: waited.result }, null, 2)}\n`);
        if (waited.agent.state === "failed") process.exitCode = 1;
        return;
      }
    }
  } finally {
    await host.dispose();
  }
}

function manifestFlags(args: Arguments): { manifest?: string; cache?: string; model?: string; effort?: string } {
  const pick = (name: string) => one(args, name);
  return Object.fromEntries(
    (["manifest", "cache", "model", "effort"] as const).flatMap((name) => (pick(name) ? [[name, pick(name)!]] : [])),
  );
}

function linkToken(args: Arguments): string {
  const file = one(args, "token-file");
  const token = (file ? fs.readFileSync(path.resolve(file), "utf8") : (process.env.MARSHAL_SDK_LINK_TOKEN ?? "")).trim();
  if (!token) throw new Error("serve needs a token: --token-file <file> or MARSHAL_SDK_LINK_TOKEN. It never starts without one.");
  return token;
}

function namedFolders(args: Arguments): Record<string, string> {
  return Object.fromEntries(
    (args.values.get("files") ?? []).map((pair) => {
      const at = pair.indexOf("=");
      if (at <= 0) throw new Error(`--files takes name=<dir>, got ${pair}.`);
      return [pair.slice(0, at), path.resolve(pair.slice(at + 1))];
    }),
  );
}

/** Runs until SIGINT or SIGTERM. Prints the URL, never the token. */
async function serve(args: Arguments): Promise<void> {
  const token = linkToken(args);
  const port = Number(one(args, "port") ?? 7781);
  const bind = one(args, "bind") ?? "127.0.0.1";
  const nativeRoots = (args.values.get("native-root") ?? []).map((dir) => path.resolve(dir));
  const log = (line: string) => process.stderr.write(`[marshal-sdk] ${line}\n`);
  let close: () => Promise<void>;
  const store = one(args, "store");
  if (store) {
    const state = path.resolve(store);
    const sessionsRoot = fs.existsSync(path.join(state, "sessions", "index.json")) ? path.join(state, "sessions") : state;
    if (!fs.existsSync(path.join(sessionsRoot, "index.json"))) throw new Error(`No session store at ${state} (looked for sessions/index.json).`);
    const server = await startLinkServer({
      token,
      bind,
      port,
      sessionsRoot,
      host: { id: one(args, "host-id") ?? "marshal-sdk", kind: one(args, "host-kind") ?? "local" },
      files: namedFolders(args),
      nativeRoots,
      ...(one(args, "page-studio-dir") ? { pageStudioDir: path.resolve(one(args, "page-studio-dir")!) } : {}),
      log,
    });
    log(`store-only link serving ${sessionsRoot} on ${server.url}`);
    close = () => server.close();
  } else {
    const options = await withManifest(hostOptions(args), manifestFlags(args));
    // Loaded only for a live host: store-only serving needs no runtime or model SDK installed.
    const { createMarshalHost } = await import("./host.js");
    const pageStudioDir = one(args, "page-studio-dir");
    const host = await createMarshalHost({
      ...options,
      link: { token, bind, port, files: namedFolders(args), nativeRoots, ...(pageStudioDir ? { pageStudioDir: path.resolve(pageStudioDir) } : {}) },
    });
    const task = one(args, "task");
    if (task) {
      const agent = host.agents.launch({
        task: textArgument(task),
        idempotencyKey: `serve-${host.runId}`,
        ...(one(args, "name") ? { name: one(args, "name")! } : {}),
        labels: options.labels,
      });
      log(`session ${agent.id} started`);
    }
    process.stdout.write(`${JSON.stringify({ runId: host.runId, url: host.link?.url })}\n`);
    close = () => host.dispose();
  }
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await close();
}

main().then(
  // The runtime keeps timers alive; a finished command has nothing left to wait for.
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    // A manifest or package problem is the user's to fix: its message names what and where, a stack adds nothing.
    const plain = error instanceof Error && error.name === "OnboardingError";
    process.stderr.write(`${plain ? `marshal-sdk: ${error.message}` : error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
