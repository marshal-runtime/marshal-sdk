import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { activeSourceSchema } from "./ownership.js";
import type { ConnectionRow } from "./ports.js";

export interface SourceSettings { graph_ingest_holds?: unknown }
export interface GraphSources { shopify: string; meta: { dataset: string } }

export function parseSourceSettings(source: string): SourceSettings {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error("invalid canonical source map");
  const project = document.toJS({ maxAliasCount: 0 });
  if (!project?.vars || typeof project.vars !== "object" || Array.isArray(project.vars)) throw new Error("missing canonical source map");
  return project.vars;
}

/** The exact dbt project file is copied into dist by the package build, not a second maintained map. */
export async function readSourceSettings(): Promise<SourceSettings> {
  const file = new URL(import.meta.url.endsWith(".ts") ? "../../../../data/dbt/dbt_project.yml" : "../source-map.yml", import.meta.url);
  return parseSourceSettings(await readFile(file, "utf8"));
}

/** Model input comes from the brand's retained active or server-promoted connection lifecycle, never its pending writer. */
export function graphSources(brandId: string, connections: readonly ConnectionRow[] = []): GraphSources {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(brandId)) throw new Error("invalid canonical brand UUID");
  const compact = brandId.replaceAll("-", "");
  const shopify = `brand_${compact}_shopify`;
  const meta = `brand_${compact}_facebook_ads`;
  return { shopify: activeSourceSchema(connections, "shopify", shopify) ?? shopify,
    meta: { dataset: activeSourceSchema(connections, "meta_ads", meta) ?? meta } };
}
