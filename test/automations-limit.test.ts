import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ClaudeAgentPort } from "../src/agent-port.js";
import { HostAutomations } from "../src/automations.js";
import type { SessionStore } from "../src/session-store.js";

const automations = (maxLivePerOwner?: number) =>
  new HostAutomations({
    root: fs.mkdtempSync(path.join(os.tmpdir(), "automations-limit-")),
    port: { hostId: "test-host" } as unknown as ClaudeAgentPort,
    sessions: {} as unknown as SessionStore,
    now: () => new Date("2026-11-25T08:00:00.000Z"),
    ...(maxLivePerOwner ? { maxLivePerOwner } : {}),
  });

const schedule = (target: HostAutomations, index: number, tenant: string) =>
  target.create({ name: `Hourly ${index}`, prompt: "work", schedule: "every 1 hour", tenant });

test("every tenant's schedules share the scheduler's live limit, 100 by default", async () => {
  const host = automations();
  for (let index = 0; index < 100; index += 1) await schedule(host, index, `brand-${index % 7}`);
  await assert.rejects(schedule(host, 100, "brand-new"), /At most 100 live schedules/);
});

test("maxLivePerOwner raises the live limit the host's automations share", async () => {
  const host = automations(150);
  for (let index = 0; index < 150; index += 1) await schedule(host, index, `brand-${index % 7}`);
  await assert.rejects(schedule(host, 150, "brand-new"), /At most 150 live schedules/);
  assert.equal(host.list().length, 150);
});
