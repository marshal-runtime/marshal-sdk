import { readSourceSettings, type SourceSettings } from "./source-map.js";

export class GraphIngestHeldError extends Error {
  constructor(readonly reason: "brand-held" | "invalid-policy") {
    super(`graph ingest held: ${reason}`);
    this.name = "GraphIngestHeldError";
  }
}

/** Always read the packaged canonical policy, never a caller's sourceSettings or environment. */
export async function assertGraphIngestAllowed(brandId: string): Promise<SourceSettings> {
  let settings: SourceSettings;
  try { settings = await readSourceSettings(); }
  catch { throw new GraphIngestHeldError("invalid-policy"); }
  const holds = settings.graph_ingest_holds;
  if (!Array.isArray(holds) || holds.some(id => typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))
      || new Set(holds).size !== holds.length) throw new GraphIngestHeldError("invalid-policy");
  if (holds.includes(brandId.replaceAll("-", "").toLowerCase())) throw new GraphIngestHeldError("brand-held");
  return settings;
}
