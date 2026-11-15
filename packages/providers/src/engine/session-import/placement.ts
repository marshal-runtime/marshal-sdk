import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function isWithin(folder: string, root: string): boolean {
  const relative = path.relative(root, folder);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Folders directly under home that hold a person's files rather than one project. */
const BROAD_HOME_FOLDERS = new Set([
  "applications",
  "desktop",
  "documents",
  "downloads",
  "dropbox",
  "movies",
  "music",
  "onedrive",
  "pictures",
  "public",
  "videos",
]);

/** Credential and config trees under home; a workspace there would give agents file access to them. */
const SENSITIVE_HOME_FOLDERS = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config"];

const SYSTEM_ROOTS = [
  "/bin",
  "/dev",
  "/etc",
  "/Library",
  "/private/etc",
  "/sbin",
  "/System",
  "/usr",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "C:\\ProgramData",
  "C:\\Windows",
];

/**
 * Whether an imported conversation's folder is a project worth adding as a workspace. The folder
 * comes from another tool's records, so only a specific project folder qualifies: home, its
 * ancestors and broad children (Desktop, Documents, dot-folders), temp, app-data and system folders
 * (Claude's scratch workspaces, for one) leave the conversation unscoped instead.
 */
export function isProjectFolder(
  folder: string,
  home: string = os.homedir(),
  tempRoots: readonly string[] = [
    os.tmpdir(),
    "/tmp",
    "/private/tmp",
    "/private/var",
    "/var/folders",
  ],
): boolean {
  let real: string;
  try {
    real = fs.realpathSync(folder);
    if (!fs.statSync(real).isDirectory()) return false;
  } catch {
    return false;
  }
  const realHome = (() => {
    try {
      return fs.realpathSync(home);
    } catch {
      return home;
    }
  })();
  if (isWithin(realHome, real)) return false;
  const resolveRoot = (root: string) => {
    try {
      return fs.realpathSync(root);
    } catch {
      return root;
    }
  };
  const excluded = [
    ...tempRoots,
    ...SYSTEM_ROOTS,
    ...["Library", "AppData", ...SENSITIVE_HOME_FOLDERS].map((name) => path.join(realHome, name)),
  ].map(resolveRoot);
  if (excluded.some((root) => isWithin(real, root))) return false;
  if (!isWithin(real, realHome))
    return path.relative(path.parse(real).root, real).split(path.sep).length > 1;
  const fromHome = path.relative(realHome, real).split(path.sep);
  const broad = fromHome[0].startsWith(".") || BROAD_HOME_FOLDERS.has(fromHome[0].toLowerCase());
  return !(fromHome.length === 1 && broad);
}

/** The folder's name, made unique among existing workspace names. */
export function uniqueWorkspaceName(folder: string, taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.toLowerCase()));
  const base = path.basename(folder).trim() || "Imported";
  let name = base;
  for (let suffix = 2; used.has(name.toLowerCase()); suffix += 1) name = `${base}-${suffix}`;
  return name;
}
