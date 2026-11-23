// Copies named top-level declarations (with their doc comments) out of a zygstinct agent-server file at a commit, plus every
// top-level declaration of that file they reference and the imports they use. A name written `Name:declare` is a class the kit
// only needs as a type: it is emitted as a `declare class` with its members' signatures and no bodies.
// Usage: node tools/extract.mjs <commit> <path under apps/agent-server/src> <name[,name:declare],...>
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("../../../node_modules/typescript");
const [commit, file, namesArg] = process.argv.slice(2);
const requested = namesArg.split(",").map((raw) => ({ name: raw.split(":")[0], declare: raw.endsWith(":declare") }));
const declareOnly = new Set(requested.filter((r) => r.declare).map((r) => r.name));
const source = execFileSync("git", ["show", `${commit}:apps/agent-server/src/${file}`], { cwd: process.env.ZYGSTINCT ?? "/Users/omer/zygstinct", encoding: "utf8", maxBuffer: 1e8 });
const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const wordIn = (name, text) => new RegExp(`(^|[^A-Za-z0-9_$])${name.replace(/\$/g, "\\$")}([^A-Za-z0-9_$]|$)`).test(text);
const declNames = (s) => {
  if (s.name && ts.isIdentifier(s.name)) return [s.name.text];
  if (ts.isVariableStatement(s)) return s.declarationList.declarations.map((d) => (ts.isIdentifier(d.name) ? d.name.text : "")).filter(Boolean);
  return [];
};
const text = (node) => (node ? node.getText(sf) : "");
const visibility = (m) => (m.modifiers ?? []).filter((x) => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.StaticKeyword, ts.SyntaxKind.ReadonlyKeyword].includes(x.kind)).map((x) => x.getText(sf));
const isAsync = (m) => (m.modifiers ?? []).some((x) => x.kind === ts.SyntaxKind.AsyncKeyword);
const param = (p) => `${p.dotDotDotToken ? "..." : ""}${text(p.name)}${p.questionToken || p.initializer ? "?" : ""}: ${p.type ? text(p.type) : "any"}`;
const returnType = (m) => (m.type ? text(m.type) : isAsync(m) ? "Promise<any>" : "any");
const doc = (node) => {
  const full = source.slice(node.getFullStart(), node.getStart(sf));
  const match = /\/\*\*[\s\S]*?\*\/\s*$/.exec(full);
  return match ? `${match[0].trim()}\n` : "";
};
const declareClass = (s) => {
  const lines = [];
  for (const m of s.members) {
    const mods = visibility(m).filter((x) => x !== "readonly" || ts.isPropertyDeclaration(m));
    const prefix = mods.length ? `${mods.join(" ")} ` : "";
    const isPrivate = mods.includes("private") || (m.name && ts.isPrivateIdentifier(m.name));
    if (m.name && ts.isPrivateIdentifier(m.name)) continue;
    if (ts.isConstructorDeclaration(m)) {
      for (const p of m.parameters) {
        const pm = visibility(p);
        if (pm.length) lines.push(`  ${pm.join(" ")} ${text(p.name)}${p.questionToken ? "?" : ""}${pm.includes("private") ? "" : `: ${p.type ? text(p.type) : "any"}`};`);
      }
      lines.push(`  constructor(${m.parameters.map(param).join(", ")});`);
    } else if (ts.isPropertyDeclaration(m)) {
      lines.push(`  ${doc(m)}${prefix}${text(m.name)}${m.questionToken ? "?" : ""}${isPrivate ? "" : `: ${m.type ? text(m.type) : "any"}`};`);
    } else if (ts.isMethodDeclaration(m)) {
      lines.push(isPrivate ? `  ${prefix}${text(m.name)};` : `  ${doc(m)}${prefix}${text(m.name)}${m.questionToken ? "?" : ""}${m.typeParameters ? `<${m.typeParameters.map(text).join(", ")}>` : ""}(${m.parameters.map(param).join(", ")}): ${returnType(m)};`);
    } else if (ts.isGetAccessorDeclaration(m)) {
      lines.push(`  ${prefix}get ${text(m.name)}(): ${m.type ? text(m.type) : "any"};`);
    } else if (ts.isSetAccessorDeclaration(m)) {
      lines.push(`  ${prefix}set ${text(m.name)}(${m.parameters.map(param).join(", ")});`);
    }
  }
  const heritage = s.heritageClauses ? ` ${s.heritageClauses.map(text).join(" ")}` : "";
  const typeParams = s.typeParameters ? `<${s.typeParameters.map(text).join(", ")}>` : "";
  return `${doc(s)}export declare class ${s.name.text}${typeParams}${heritage} {\n${lines.join("\n")}\n}`;
};

const statements = sf.statements.filter((s) => !ts.isImportDeclaration(s) && declNames(s).length);
const picked = new Map();
const pick = (s) => {
  if (picked.has(s)) return false;
  const declare = ts.isClassDeclaration(s) && declareOnly.has(declNames(s)[0]);
  picked.set(s, { statement: s, body: declare ? declareClass(s) : source.slice(s.getFullStart(), s.getEnd()).replace(/^\n+/, "") });
  return true;
};
for (const s of statements) if (declNames(s).some((n) => requested.some((r) => r.name === n))) pick(s);
let grew = true;
while (grew) {
  grew = false;
  const all = [...picked.values()].map((p) => p.body).join("\n");
  for (const s of statements) if (!picked.has(s) && declNames(s).some((n) => wordIn(n, all)) && pick(s)) grew = true;
}
const ordered = statements.filter((s) => picked.has(s)).map((s) => picked.get(s).body);
const body = ordered.join("\n\n");
const imports = [];
for (const s of sf.statements) {
  if (!ts.isImportDeclaration(s) || !s.importClause) continue;
  const clause = s.importClause;
  const used = [];
  if (clause.name && wordIn(clause.name.text, body)) used.push({ def: clause.name.text });
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const el of clause.namedBindings.elements) if (wordIn(el.name.text, body)) used.push({ el: text(el) });
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && wordIn(clause.namedBindings.name.text, body)) used.push({ ns: clause.namedBindings.name.text });
  if (!used.length) continue;
  const spec = s.moduleSpecifier.text;
  const typeOnly = clause.isTypeOnly ? "type " : "";
  const def = used.find((u) => u.def)?.def;
  const nsName = used.find((u) => u.ns)?.ns;
  const els = used.filter((u) => u.el).map((u) => u.el);
  if (nsName) imports.push(`import ${typeOnly}* as ${nsName} from "${spec}";`);
  else imports.push(`import ${typeOnly}${def ?? ""}${def && els.length ? ", " : ""}${els.length ? `{ ${els.join(", ")} }` : ""} from "${spec}";`);
}
const missing = requested.filter((r) => ![...picked.values()].some((p) => declNames(p.statement).includes(r.name))).map((r) => r.name);
process.stdout.write(`${imports.join("\n")}${imports.length ? "\n\n" : ""}${body}\n`);
if (missing.length) process.stderr.write(`missing: ${missing.join(",")}\n`);
