import http from "node:http";

export interface FakeGcs {
  url: string;
  objects: Map<string, { data: Buffer; generation: number }>;
  /** Every request seen, "METHOD path". */
  requests: string[];
  close(): void;
}

/** The slice of the GCS JSON API the SDK uses, with real generation preconditions and compose. */
export async function startFakeGcs(): Promise<FakeGcs> {
  const objects = new Map<string, { data: Buffer; generation: number }>();
  const requests: string[] = [];
  let counter = 1000;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://x");
      requests.push(`${request.method} ${url.pathname}${url.search.includes("alt=media") ? "?alt=media" : ""}`);
      const body = Buffer.concat(chunks);
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { "content-type": "application/json", connection: "close", ...headers });
        response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      };
      const match = url.searchParams.get("ifGenerationMatch");
      const allowed = (name: string) => {
        if (match === null) return true;
        const current = objects.get(name);
        return match === "0" ? current === undefined : current !== undefined && String(current.generation) === match;
      };
      const store = (name: string, data: Buffer) => {
        const generation = ++counter;
        objects.set(name, { data, generation });
        return { name, generation: String(generation), size: String(data.length), updated: new Date().toISOString() };
      };
      if (request.method === "POST" && url.pathname.startsWith("/upload/storage/v1/b/")) {
        const name = url.searchParams.get("name")!;
        if (!allowed(name)) return send(412, { error: "conditionNotMet" });
        return send(200, store(name, body));
      }
      const composeMatch = url.pathname.match(/^\/storage\/v1\/b\/[^/]+\/o\/(.+)\/compose$/);
      if (request.method === "POST" && composeMatch) {
        const name = decodeURIComponent(composeMatch[1]!);
        if (!allowed(name)) return send(412, { error: "conditionNotMet" });
        const sources = (JSON.parse(body.toString("utf8")) as { sourceObjects: { name: string }[] }).sourceObjects;
        if (sources.length > 32) return send(400, { error: "too many sources" });
        const parts = sources.map((source) => objects.get(source.name));
        if (parts.some((part) => !part)) return send(404, { error: "missing source" });
        return send(200, store(name, Buffer.concat(parts.map((part) => part!.data))));
      }
      const objectMatch = url.pathname.match(/^\/storage\/v1\/b\/[^/]+\/o\/(.+)$/);
      if (objectMatch) {
        const name = decodeURIComponent(objectMatch[1]!);
        if (request.method === "GET") {
          const found = objects.get(name);
          if (!found) return send(404, { error: "not found" });
          return send(200, found.data.toString("utf8"), { "x-goog-generation": String(found.generation) });
        }
        if (request.method === "DELETE") {
          if (!allowed(name)) return send(412, { error: "conditionNotMet" });
          objects.delete(name);
          return send(204, "");
        }
      }
      if (request.method === "GET" && /^\/storage\/v1\/b\/[^/]+\/o$/.test(url.pathname)) {
        const prefix = url.searchParams.get("prefix") ?? "";
        const items = [...objects.entries()]
          .filter(([name]) => name.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, value]) => ({ name, generation: String(value.generation), size: String(value.data.length), updated: new Date().toISOString() }));
        return send(200, { items });
      }
      send(404, { error: `unhandled ${request.method} ${url.pathname}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, objects, requests, close: () => server.close() };
}
