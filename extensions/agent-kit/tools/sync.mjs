// Re-copies every Marley file the kit carries (source.json) from a zygstinct commit: whole files, named extracts and package files.
// Usage: node tools/sync.mjs [commit]   (default: the commit in source.json; ZYGSTINCT points at the zygstinct checkout)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const kit = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = process.env.ZYGSTINCT ?? "/Users/omer/zygstinct";
const manifestPath = join(kit, "source.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const commit = execFileSync("git", ["rev-parse", "--short=9", process.argv[2] ?? manifest.commit], { cwd: repo, encoding: "utf8" }).trim();
const show = (path) => execFileSync("git", ["show", `${commit}:${path}`], { cwd: repo, encoding: "utf8", maxBuffer: 1e9 });
const write = (rel, text) => {
  const target = join(kit, "src", rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
};

for (const file of manifest.copies) write(join("marley", file), show(`${manifest.serverRoot}/${file}`));
for (const [file, names] of Object.entries(manifest.extracts)) {
  const body = execFileSync(process.execPath, [join(kit, "tools/extract.mjs"), commit, file, names.join(",")], { encoding: "utf8", env: { ...process.env, ZYGSTINCT: repo } });
  write(join("marley", file), `// Extract of zygstinct ${manifest.serverRoot}/${file} at ${commit}: only ${names.join(", ")}.\n${body}`);
}
for (const [rel, path] of Object.entries(manifest.packages)) write(join("marley-packages", rel), show(path));
for (const [rel, tree] of Object.entries(manifest.typeTrees ?? {})) {
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", commit, `${tree}/`], { cwd: repo, encoding: "utf8" }).split("\n").filter((file) => file.endsWith(".d.ts"));
  for (const file of files) write(join("marley-packages", rel, file.slice(tree.length + 1)), show(file));
}

manifest.commit = commit;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`synced ${manifest.copies.length} files, ${Object.keys(manifest.extracts).length} extracts, ${Object.keys(manifest.packages).length} package files from ${commit}\n`);
