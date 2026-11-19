// A test fixture extension: @fixture/pages.
const fs = require("fs");
const path = require("path");
// The runtime registers only closed output schemas.
const OPEN = { type: "object", additionalProperties: true };
const OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: { running: { type: "string" }, result: { type: "string" }, error: { type: "string" }, outputs: { type: "array", items: { type: "string" } }, details: OPEN, text: { type: "string" } },
};
const capabilities = {
  "pages.agent.run": async (input) => {
    const brief = JSON.parse(fs.readFileSync(path.join(input.cwd, "input", "page", "brief.json"), "utf8"));
    const record = path.join(input.state.folder, "pages.json");
    const earlier = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, "utf8")) : { pages: 0 };
    if (input.state.resumed && !earlier.pages) return { error: "nothing to continue" };
    const pages = earlier.pages + 1;
    fs.writeFileSync(record, JSON.stringify({ pages }));
    const meta = input.state.link ? '<meta name="marshal-page-state" content="' + input.state.link + '">' : "";
    fs.mkdirSync(path.join(input.cwd, "out"), { recursive: true });
    fs.writeFileSync(path.join(input.cwd, "out", "index.html"), "<html><head>" + meta + "</head><body><h1>" + brief.product_name + "</h1><p>version " + pages + "</p></body></html>");
    fs.appendFileSync(input.progressFile, "page " + pages + " written\n");
    return { result: "page " + pages, outputs: ["out/index.html"], details: { engine: "fake-pages", runLabel: input.runLabel || null, resumed: input.state.resumed } };
  },
  "pages.agent.fake": async (input) => {
    return { text: "dry: " + String(input.prompt).slice(0, 20) };
  },
};
module.exports = {
  activate() {
    const descriptors = Object.keys(capabilities).map((name) => ({ protocolVersion: "1.0.0", name, version: "0.1.0", title: name, description: name, inputSchema: { type: "object" }, outputSchema: OUTPUT, permissions: [{ permission: name, risk: "low" }] }));
    return {
      capabilityProviders: [{
        id: "@fixture/pages",
        version: "0.1.0",
        list: () => descriptors,
        get: (name) => descriptors.find((descriptor) => descriptor.name === name),
        async invoke(name, input) {
          return { output: await capabilities[name](input || {}) };
        },
      }],
    };
  },
};
