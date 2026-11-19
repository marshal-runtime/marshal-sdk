// A test fixture extension: @fixture/hello.
const fs = require("node:fs");
const path = require("node:path");
const capabilities = {
  "hello.agent.run": async (input) => {
    fs.mkdirSync(path.join(input.cwd, "out"), { recursive: true });
    fs.writeFileSync(path.join(input.cwd, "out", "hello.txt"), "hello from @fixture/hello: " + input.prompt + "\n");
    fs.appendFileSync(input.progressFile, "wrote out/hello.txt\n");
    return { result: "said hello", outputs: ["out/hello.txt"], details: { person: input.person || null, fake: input.fake } };
  },
};
module.exports = {
  activate() {
    const descriptors = Object.keys(capabilities).map((name) => ({ protocolVersion: "1.0.0", name, version: "0.1.0", title: name, description: name, inputSchema: { type: "object" }, permissions: [{ permission: name, risk: "low" }] }));
    return {
      capabilityProviders: [{
        id: "@fixture/hello",
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
