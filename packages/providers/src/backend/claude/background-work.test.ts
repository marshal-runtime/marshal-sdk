import { describe, expect, it } from "vitest";

import { nextCronFireAt, tasksFromStopHook, wakeupsFromSessionCrons } from "./background-work";

describe("nextCronFireAt", () => {
  const from = new Date(2026, 10, 6, 12, 11, 30).getTime();

  it("resolves the single fire time a one-shot wakeup encodes", () => {
    const at = nextCronFireAt("21 12 6 11 *", from);
    expect(at).toBe(new Date(2026, 10, 6, 12, 21).getTime());
  });

  it("finds the next match for recurring schedules", () => {
    expect(nextCronFireAt("*/15 * * * *", from)).toBe(new Date(2026, 10, 6, 12, 15).getTime());
    expect(nextCronFireAt("0 9 * * 1-5", from)).toBe(new Date(2026, 10, 9, 9, 0).getTime());
  });

  it("never returns the current minute", () => {
    expect(nextCronFireAt("11 12 * * *", from)).toBe(new Date(2026, 10, 7, 12, 11).getTime());
  });

  it("accepts 7 as Sunday inside weekday ranges and lists", () => {
    expect(nextCronFireAt("0 9 * * 1-7", from)).toBe(new Date(2026, 10, 7, 9, 0).getTime());
    expect(nextCronFireAt("0 9 * * 5-7", from)).toBe(new Date(2026, 10, 7, 9, 0).getTime());
    expect(nextCronFireAt("0 9 * * 7", from)).toBe(new Date(2026, 10, 8, 9, 0).getTime());
    expect(nextCronFireAt("0 9 * * 0,7", from)).toBe(new Date(2026, 10, 8, 9, 0).getTime());
  });

  it("treats a field that starts with * as unrestricted when the other day field is set", () => {
    expect(nextCronFireAt("0 9 13 * */2", from)).toBe(new Date(2026, 11, 13, 9, 0).getTime());
    expect(new Date(2026, 11, 13).getDay()).toBe(0);
  });

  it("uses either day field when both are restricted", () => {
    expect(nextCronFireAt("0 9 13 * 6", from)).toBe(new Date(2026, 10, 7, 9, 0).getTime());
  });

  it("finds a leap-day schedule years ahead without scanning every minute", () => {
    const started = performance.now();
    expect(nextCronFireAt("0 9 29 2 *", from)).toBe(new Date(2028, 1, 29, 9, 0).getTime());
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("returns undefined for schedules it cannot parse", () => {
    expect(nextCronFireAt("every ten minutes", from)).toBeUndefined();
    expect(nextCronFireAt("61 * * * *", from)).toBeUndefined();
    expect(nextCronFireAt("* * * *", from)).toBeUndefined();
  });
});

describe("Stop hook mapping", () => {
  it("maps session_crons to wakeups with a computed fire time", () => {
    const now = new Date(2026, 10, 6, 12, 11).getTime();
    expect(
      wakeupsFromSessionCrons(
        [
          { id: "c1", schedule: "21 12 6 11 *", recurring: false, prompt: "check deploy" },
          { id: "c2", schedule: "bogus", recurring: true, prompt: "" },
        ],
        now,
      ),
    ).toEqual([
      {
        id: "c1",
        recurring: false,
        nextFireAt: new Date(2026, 10, 6, 12, 21).getTime(),
        prompt: "check deploy",
      },
      { id: "c2", recurring: true },
    ]);
  });

  it("reports an overdue one-shot as due now instead of rolling it to next year", () => {
    const now = new Date(2026, 10, 6, 12, 11).getTime();
    const [overdue] = wakeupsFromSessionCrons(
      [{ id: "c1", schedule: "5 12 6 11 *", recurring: false, prompt: "late" }],
      now,
    );
    expect(overdue?.nextFireAt).toBe(new Date(2026, 10, 6, 12, 5).getTime());
  });

  it("still rolls a recurring schedule forward", () => {
    const now = new Date(2026, 10, 6, 12, 11).getTime();
    const [recurring] = wakeupsFromSessionCrons(
      [{ id: "c1", schedule: "5 12 * * *", recurring: true, prompt: "" }],
      now,
    );
    expect(recurring?.nextFireAt).toBe(new Date(2026, 10, 7, 12, 5).getTime());
  });

  it("maps background_tasks summaries to tasks", () => {
    expect(
      tasksFromStopHook([
        { id: "t1", type: "shell", status: "running", description: "", command: "sleep 600" },
        { id: "t2", type: "subagent", status: "running", description: "review", agent_type: "x" },
        { id: "t3", type: "monitor", status: "running", description: "deploy" },
      ]),
    ).toEqual([
      { id: "t1", kind: "shell", description: "sleep 600" },
      { id: "t2", kind: "agent", description: "review" },
      { id: "t3", kind: "monitor", description: "deploy" },
    ]);
  });
});
