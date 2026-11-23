// Marley imports the SDK as @zygstinct/marshal-sdk-port (a vendored copy); at run time the same names come from this repository's source.
// Only the modules the copied code uses, so a bundle of the kit does not reach the provider layer (Cursor, Codex, OpenAI clients).
export { FileSessionStore } from "../../../../src/session-store.js";
export { HostAutomations } from "../../../../src/automations.js";
export { TURN_EXTRAS } from "../../../../src/agent-port.js";
export { assembleHostPrompt, mergePromptLayers, sdkBaseLayer } from "../../../../src/prompt.js";
export { composePromptLayers, fillLayerVars, parseLayerRef, resolvePromptLayers } from "../../../../src/prompt-layers.js";
export { resolveAgent } from "../../../../src/agent-entries.js";
