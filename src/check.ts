// `marshal-sdk check`: proves a marshal-sdk.json can start a host before any run depends on it. It resolves the
// manifest (downloads pinned packages, expands ${env:...}), checks what every extension declares it needs, starts a
// host with exactly those extensions (each must install and activate), and asks the Brain one question when the kit
// carries it. marshal_sdk.init() runs it once at a service's start.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { brainKitOptions, readManifest, resolveManifest, type ResolvedExtension } from "./onboarding.js";
import { manifestPath } from "./onboarding-cli.js";
import { pageKit } from "./page-run.js";

export interface CheckReport {
  ok: boolean;
  manifest?: string;
  extensions: { identity: string; version: string; source: ResolvedExtension["source"]; from: string; origin: ResolvedExtension["origin"] }[];
  brain?: { index?: string; url?: string; auth: "person" | "service"; person?: string; reachable?: boolean; error?: string };
  model?: string;
  effort?: string;
  problems: string[];
}

export interface CheckOptions {
  manifest?: string;
  env?: Record<string, string | undefined>;
  /** Ask the Brain one question (default true when the kit carries the Brain). */
  pingBrain?: boolean;
  /** The person the Brain ping answers as (service mode); default $MARSHAL_SDK_BRAIN_CALLER. */
  person?: string;
  log?: (line: string) => void;
}

export async function checkManifest(options: CheckOptions = {}): Promise<CheckReport> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => undefined);
  const report: CheckReport = { ok: false, extensions: [], problems: [] };
  const file = manifestPath(options.manifest, env);
  if (!file) {
    report.problems.push("No marshal-sdk.json: pass --manifest <file> or set MARSHAL_SDK_MANIFEST.");
    return report;
  }
  report.manifest = file;
  let resolved: Awaited<ReturnType<typeof resolveManifest>>;
  try {
    const manifest = readManifest(file);
    if (manifest.brain) {
      const brain = brainKitOptions(manifest.brain, file);
      report.brain = { ...(manifest.brain.index ? { index: manifest.brain.index } : { index: "zyg" }), url: String(brain.cloudUrl), auth: manifest.brain.auth ?? "person" };
    }
    resolved = await resolveManifest(file, { env });
  } catch (error) {
    report.problems.push(...problemLines(error));
    return report;
  }
  report.extensions = resolved.extensions.map((extension) => ({
    identity: extension.identity,
    version: extension.version,
    source: extension.source,
    from: extension.entry,
    origin: extension.origin,
  }));
  if (resolved.model) report.model = resolved.model;
  if (resolved.reasoningEffort) report.effort = resolved.reasoningEffort;
  const person = (options.person ?? env.MARSHAL_SDK_BRAIN_CALLER)?.trim().toLowerCase() || undefined;
  const kit = pageKit(resolved.kit, undefined, undefined, person);
  const brainOn = Boolean(kit?.parts.includes("brain") || kit?.parts.includes("memory"));
  if (brainOn && !report.brain) report.brain = { index: "zyg", auth: kit?.brain?.callerMode === "delegated" ? "service" : "person" };
  if (report.brain && person) report.brain.person = person;

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-check-"));
  const { createMarshalHost } = await import("./host.js");
  let host: Awaited<ReturnType<typeof createMarshalHost>> | undefined;
  try {
    // The host refuses a state folder inside its workspace.
    fs.mkdirSync(path.join(scratch, "workspace"));
    host = await createMarshalHost({
      workspacePath: path.join(scratch, "workspace"),
      stateRoot: path.join(scratch, "host"),
      browser: false,
      labels: { job: "check" },
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      extensions: resolved.extensions.map((extension) => ({
        packageRoot: extension.packageRoot,
        ...(extension.configuration !== undefined ? { configuration: extension.configuration } : {}),
      })),
      ...(kit ? { kit } : {}),
      log,
    });
    log(`host started: ${host.extensions.map((extension) => `${extension.identity}@${extension.version}`).join(", ")}`);
    if (brainOn && options.pingBrain !== false && report.brain) {
      try {
        await host.invoke("knowledge.search", { query: "marshal-sdk check", limit: 1 });
        report.brain.reachable = true;
      } catch (error) {
        report.brain.reachable = false;
        report.brain.error = (error instanceof Error ? error.message : String(error)).slice(0, 400);
        report.problems.push(`The Brain did not answer (${report.brain.url ?? "the kit's Brain"}, ${report.brain.auth} sign-in): ${report.brain.error}`);
      }
    }
  } catch (error) {
    report.problems.push(...problemLines(error));
  } finally {
    await host?.dispose().catch(() => undefined);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  report.ok = report.problems.length === 0;
  return report;
}

/** An error as the lines a person reads: an onboarding or host error lists its problems one per line. */
function problemLines(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message.split("\n").map((line) => line.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
  // A multi-line error is a heading ("… cannot start a host:") over one problem per line.
  return lines.length > 1 ? lines.slice(1) : lines;
}

export const CHECK_USAGE = `  check       Prove the manifest can start a host: resolve and fetch its extensions, check what each declares
              it needs, start them, and ask the Brain one question. Prints a JSON report; exit 1 on a problem.
                [--manifest <file>] [--person <email>] [--no-brain-ping]
`;

export async function checkCommand(argv: readonly string[]): Promise<number> {
  const value = (name: string) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const report = await checkManifest({
    ...(value("manifest") ? { manifest: value("manifest")! } : {}),
    ...(value("person") ? { person: value("person")! } : {}),
    pingBrain: !argv.includes("--no-brain-ping"),
    log: (line) => process.stderr.write(`[marshal-sdk check] ${line}\n`),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}
