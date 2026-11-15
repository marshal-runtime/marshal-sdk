import { describe, expect, it } from "vitest";

import { describeBackgroundWakeup, formatWakeTime } from "./background-work";

describe("formatWakeTime", () => {
  const now = new Date(2026, 10, 6, 12, 0).getTime();

  it("shows only the time for a wakeup within twelve hours", () => {
    const at = new Date(2026, 10, 6, 18, 30).getTime();
    expect(formatWakeTime(at, now)).toBe(
      new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    );
  });

  it("adds the date for a wakeup further away, so a weekly schedule is not read as today", () => {
    const at = new Date(2026, 10, 9, 9, 0).getTime();
    const label = formatWakeTime(at, now);
    expect(label).toContain(
      new Date(at).toLocaleDateString([], { month: "short", day: "numeric" }),
    );
    expect(label).toContain(
      new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    );
  });

  it("returns undefined when the runtime gave no fire time", () => {
    expect(formatWakeTime(undefined, now)).toBeUndefined();
    expect(describeBackgroundWakeup({ id: "w", recurring: true })).toBe("Recurring wakeup");
  });
});
