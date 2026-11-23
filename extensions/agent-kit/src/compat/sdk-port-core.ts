// The core entry's view of the port: only the prompt-layer reader (prompt-v2.ts loadSoul). The rest of the port (automations, the agent
// provider) needs @marshal/runtime, which only a host entry brings, so a core host never installs it.
export { resolvePromptLayers } from "../../../../src/prompt-layers.js";
