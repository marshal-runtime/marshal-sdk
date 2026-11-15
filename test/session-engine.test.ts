import assert from "node:assert/strict";
import { test } from "node:test";

// SessionManager (the desktop's electron/sessions.ts) ships in its own bundle. It and providers.js share one
// ports module, so a host that configures the engine once has configured SessionManager too.
test("SessionManager loads from the SDK and shares the engine's ports with providers.js", async () => {
  // Imported by URL: the SDK typechecks this bundle in the desktop, not here (docs/engine.md).
  const sessionEngine = await import(new URL("../src/session-engine.js", import.meta.url).href);
  const providers = await import("../src/providers.js");
  const ports = await import("../src/engine-host.js");
  assert.equal(typeof sessionEngine.SessionManager, "function");
  assert.equal(typeof sessionEngine.TurnAccumulator, "function");
  assert.equal(providers.configureEngineHost, ports.configureEngineHost, "one ports module, not a copy per bundle");
  providers.configureEngineHost({ APP_NAME: "SharedHost" });
  assert.equal(ports.APP_NAME, "SharedHost");
  assert.equal(ports.isEngineHostConfigured(), true);
});
