import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A stand-in for the gcloud CLI over a folder: gs://<bucket>/<path> is <root>/<bucket>/<path>. It covers the calls the
 * cloud host makes (storage ls with ** and *, rsync -r, cp of files into a file or a folder/, cat). Flags are ignored.
 */
export const FAKE_GCLOUD = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const root = process.env.FAKE_GCS_ROOT;
const local = (uri) => uri.startsWith("gs://") ? path.join(root, uri.slice(5)) : uri;
const [, , group, verb, ...rest] = process.argv;
const args = rest.filter((arg) => !arg.startsWith("--") && arg !== "-r");
const walk = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]) : [];
if (group !== "storage") process.exit(2);
if (verb === "ls") {
  const pattern = args[0];
  const base = pattern.slice(0, pattern.search(/\\*/));
  const re = new RegExp("^" + pattern.replace(/[.+?^\${}()|[\\]\\\\]/g, "\\\\$&").replace(/\\*\\*\\//g, "(?:.*/)?").replace(/\\*/g, "[^/]*") + "$");
  const hits = walk(local(base.replace(/\\/[^/]*$/, ""))).map((file) => "gs://" + path.relative(root, file)).filter((uri) => re.test(uri));
  if (!hits.length) { process.stderr.write("ERROR: One or more URLs matched no objects.\\n"); process.exit(1); }
  process.stdout.write(hits.join("\\n") + "\\n");
} else if (verb === "cat") {
  const file = local(args[0]);
  if (!fs.existsSync(file)) { process.stderr.write("ERROR: not found\\n"); process.exit(1); }
  process.stdout.write(fs.readFileSync(file));
} else if (verb === "rsync") {
  const from = local(args[0]), to = local(args[1]);
  if (!fs.existsSync(from)) { process.stderr.write("ERROR: not found\\n"); process.exit(1); }
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
} else if (verb === "cp") {
  const target = args.at(-1);
  for (const source of args.slice(0, -1)) {
    const from = local(source);
    if (!fs.existsSync(from)) { process.stderr.write("ERROR: not found\\n"); process.exit(1); }
    const to = target.endsWith("/") ? path.join(local(target), path.basename(from)) : local(target);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
} else process.exit(2);
`;

/** A fake bucket in a temp folder, with MARSHAL_SDK_GCLOUD pointing at the stand-in. */
export function fakeBucket(): { dir: string; gcs: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-gcs-"));
  const bin = path.join(dir, "gcloud");
  fs.writeFileSync(bin, FAKE_GCLOUD, { mode: 0o755 });
  process.env.MARSHAL_SDK_GCLOUD = bin;
  process.env.FAKE_GCS_ROOT = path.join(dir, "gcs");
  return { dir, gcs: path.join(dir, "gcs") };
}
