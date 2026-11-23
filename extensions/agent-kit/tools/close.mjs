// Closes the kit over Marley's declarations: syncs, typechecks, and for every import of a Marley module the kit does not carry adds the
// imported names to source.json as extracts (a class imported only as a type becomes `Name:declare`), until a round adds nothing.
// Usage: node tools/close.mjs [rounds]
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const kit = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ts = require("../../../node_modules/typescript");
const repo = process.env.ZYGSTINCT ?? "/Users/omer/zygstinct";
const manifestPath = join(kit, "source.json");
const read = () => JSON.parse(readFileSync(manifestPath, "utf8"));
const { commit, serverRoot } = read();
const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 1e9 });
const present = new Set(git(["ls-tree", "-r", "--name-only", commit, `${serverRoot}/`]).split("\n").filter((f) => f.endsWith(".ts")).map((f) => f.slice(serverRoot.length + 1)));
const kindOf = (file, name) => {
  const source = git(["show", `${commit}:${serverRoot}/${file}`]);
  const match = new RegExp(`^export (?:declare )?(?:abstract )?(class|interface|type|const|let|function|async function|enum) ${name.replace(/\$/g, "\\$")}(?![A-Za-z0-9_$])`, "m").exec(source);
  return match ? match[1] : null;
};
const importedNames = (fromFile, spec) => {
  const sf = ts.createSourceFile(fromFile, readFileSync(join(kit, "src/marley", fromFile), "utf8"), ts.ScriptTarget.Latest, true);
  const names = [];
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || s.moduleSpecifier.text !== spec || !s.importClause) continue;
    const clause = s.importClause;
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const el of clause.namedBindings.elements) names.push({ name: (el.propertyName ?? el.name).text, typeOnly: clause.isTypeOnly || el.isTypeOnly });
  }
  return names;
};
const rounds = Number(process.argv[2] ?? 10);
for (let round = 0; round < rounds; round++) {
  execFileSync(process.execPath, [join(kit, "tools/sync.mjs")], { cwd: kit, encoding: "utf8" });
  const result = spawnSync("npx", ["tsc", "-p", "tsconfig.json", "--noEmit"], { cwd: kit, encoding: "utf8", maxBuffer: 1e8 });
  const errors = (result.stdout ?? "").split("\n").filter((line) => line.includes("error TS"));
  const manifest = read();
  let added = 0;
  for (const line of errors) {
    const notFound = /^src\/marley\/(.+?)\(\d+,\d+\): error TS2307: Cannot find module '(\.[^']+)'/.exec(line);
    const noMember = /^src\/marley\/(.+?)\(\d+,\d+\): error TS2305: Module '"(\.[^"]+)"' has no exported member '([^']+)'/.exec(line);
    const match = notFound ?? noMember;
    if (!match) continue;
    const target = posix.normalize(posix.join(posix.dirname(match[1]), match[2])).replace(/\.js$/, ".ts");
    if (!present.has(target) || manifest.copies.includes(target)) continue;
    if (noMember && !manifest.extracts[target]) continue;
    const wanted = notFound ? importedNames(match[1], match[2]) : [{ name: match[3], typeOnly: true }];
    const current = manifest.extracts[target] ?? [];
    for (const { name, typeOnly } of wanted) {
      if (current.some((entry) => entry.split(":")[0] === name)) continue;
      const declare = typeOnly && kindOf(target, name) === "class";
      current.push(declare ? `${name}:declare` : name);
      added++;
      process.stdout.write(`round ${round}: ${target} += ${name}${declare ? ":declare" : ""}\n`);
    }
    manifest.extracts[target] = current;
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`round ${round}: ${errors.length} errors, ${added} names added\n`);
  if (!added) break;
}
