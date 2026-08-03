import { describe, expect, it } from "vitest";
import { isWithinSchedule, type Schedule } from "../src/index";

describe("monitor schedule", () => {
  it("supports a one-time pause without disabling future Mondays", () => {
    const schedule: Schedule = {
      days: {
        mon: true,
        tue: false,
        wed: false,
        thu: false,
        fri: false,
        sat: false,
        sun: false,
      },
      startTime: "06:00",
      endTime: "20:00",
      pausedUntil: "2026-07-28T00:00:00.000Z",
    };

    expect(isWithinSchedule(schedule, new Date("2026-07-27T10:00:00.000Z"))).toBe(false);
    expect(isWithinSchedule(schedule, new Date("2026-08-03T10:00:00.000Z"))).toBe(true);
  });
});
