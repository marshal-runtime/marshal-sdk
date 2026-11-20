import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  bridgeEndpoint,
  clearAntigravityCredentials,
  resolveAntigravityEndpoint,
  saveAntigravityCredential,
} from "./credentials";

const home = () => mkdtemp(path.join(tmpdir(), "agy-cred-"));

describe("Antigravity credentials", () => {
  it("stores a service-account key as its own 0600 file and runs Vertex on it", async () => {
    const dir = await home();
    const key = JSON.stringify({ type: "service_account", project_id: "proj-1", private_key: "x" });
    const stored = await saveAntigravityCredential(dir, key);
    expect(stored).toMatchObject({ kind: "vertex", project: "proj-1", location: "global" });
    const file = path.join(dir, "service-account.json");
    expect(await readFile(file, "utf8")).toBe(key);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const endpoint = await resolveAntigravityEndpoint(dir, {});
    expect(endpoint && bridgeEndpoint(endpoint).env).toMatchObject({
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "proj-1",
      GOOGLE_APPLICATION_CREDENTIALS: file,
    });
  });

  it("takes a project for Application Default Credentials, an express key, or a Gemini key", async () => {
    const dir = await home();
    expect(await saveAntigravityCredential(dir, '{"project":"p","location":"us-central1"}')).toEqual({
      kind: "vertex",
      project: "p",
      location: "us-central1",
    });
    expect(await saveAntigravityCredential(dir, '{"vertexApiKey":"vk"}')).toEqual({
      kind: "vertex-express",
      apiKey: "vk",
    });
    expect(await saveAntigravityCredential(dir, "AIza-gemini")).toEqual({
      kind: "gemini",
      apiKey: "AIza-gemini",
    });
    await clearAntigravityCredentials(dir);
    expect(await resolveAntigravityEndpoint(dir, {})).toBeUndefined();
  });

  it("falls back to the launch environment the Python SDK reads", async () => {
    const dir = await home();
    expect(
      await resolveAntigravityEndpoint(dir, {
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        GOOGLE_CLOUD_PROJECT: "env-proj",
        GOOGLE_CLOUD_LOCATION: "europe-west4",
      }),
    ).toEqual({ kind: "vertex", project: "env-proj", location: "europe-west4" });
    expect(await resolveAntigravityEndpoint(dir, { GEMINI_API_KEY: "g" })).toEqual({
      kind: "gemini",
      apiKey: "g",
    });
  });
});
