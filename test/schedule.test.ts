import { describe, expect, it } from "vitest";
import { isWithinSchedule, type Schedule } from "../src/index";

describe("monitor schedule", () => {
  it("runs only on enabled weekdays inside the Lisbon time window", () => {
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
    };

    expect(isWithinSchedule(schedule, new Date("2026-07-27T10:00:00.000Z"))).toBe(true);
    expect(isWithinSchedule(schedule, new Date("2026-07-27T21:00:00.000Z"))).toBe(false);
    expect(isWithinSchedule(schedule, new Date("2026-07-28T10:00:00.000Z"))).toBe(false);
  });

  it("stays paused until pausedUntil and resumes automatically afterwards", () => {
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
      pausedUntil: "2026-07-27T12:00:00.000Z",
    };

    expect(isWithinSchedule(schedule, new Date("2026-07-27T10:00:00.000Z"))).toBe(false);
    expect(isWithinSchedule(schedule, new Date("2026-07-27T13:00:00.000Z"))).toBe(true);
  });
});
