import { LABEL_VALUE } from "../run-records.js";

/** The roots of the org store in a bucket (docs: zyg-org-session-storage). */
export const OBJECTS_ROOT = "sdk/v1";
export const INDEX_ROOT = "sdk-index/v1";

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY = /^[a-z][A-Za-z0-9_]{0,31}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What an SDK usage declares once: its workspace and name, the labels that become path segments (at most 3, in order) and the
 * labels the index lets a reader filter by. Stored at `sdk/v1/<workspace>/<impl>/_impl.json` by the first writer.
 */
export interface ImplDeclaration {
  v: 1;
  workspace: string;
  impl: string;
  partition: string[];
  fields: Record<string, { from: "label"; filter?: boolean }>;
}

export function validateImpl(decl: ImplDeclaration): ImplDeclaration {
  if (decl.v !== 1) throw new Error("Implementation declaration version must be 1.");
  if (!SLUG.test(decl.workspace)) throw new Error(`Invalid workspace "${decl.workspace}".`);
  if (!SLUG.test(decl.impl)) throw new Error(`Invalid implementation "${decl.impl}".`);
  if (decl.partition.length > 3) throw new Error("An implementation has at most 3 partition keys.");
  for (const key of [...decl.partition, ...Object.keys(decl.fields)]) if (!KEY.test(key)) throw new Error(`Invalid label key "${key}".`);
  if (new Set(decl.partition).size !== decl.partition.length) throw new Error("Partition keys must be distinct.");
  return decl;
}

export const implRoot = (decl: ImplDeclaration): string => `${OBJECTS_ROOT}/${decl.workspace}/${decl.impl}`;
export const implFile = (decl: ImplDeclaration): string => `${implRoot(decl)}/_impl.json`;

/** `env=staging/brand=<id>` from a session's labels; undefined unless every declared key is present and id-shaped. */
export function partitionPath(decl: ImplDeclaration, labels: Record<string, string> | undefined): string | undefined {
  const parts: string[] = [];
  for (const key of decl.partition) {
    const value = labels?.[key];
    if (typeof value !== "string" || !LABEL_VALUE.test(value)) return undefined;
    parts.push(`${key}=${value}`);
  }
  return parts.join("/");
}

const join = (...parts: string[]) => parts.filter(Boolean).join("/");

export const dayOf = (createdAt: string): string => {
  const day = createdAt.slice(0, 10);
  if (!DAY.test(day)) throw new Error(`Invalid creation time ${createdAt}.`);
  return day;
};

/** `sdk/v1/<ws>/<impl>/<partition>/<day>/<root session>`: the directory one root session owns. */
export const sessionDir = (decl: ImplDeclaration, partition: string, day: string, rootId: string): string => join(implRoot(decl), partition, day, rootId);

/** `sdk-index/v1/<ws>/<impl>/<partition>`: where a partition's rows are. */
export const indexDir = (decl: ImplDeclaration, partition: string): string => join(INDEX_ROOT, decl.workspace, decl.impl, partition);
export const rowObject = (decl: ImplDeclaration, partition: string, day: string, rootId: string): string => `${indexDir(decl, partition)}/${day}/_rows/${rootId}.json`;
export const shardObject = (decl: ImplDeclaration, partition: string, day: string): string => `${indexDir(decl, partition)}/${day}.jsonl`;
