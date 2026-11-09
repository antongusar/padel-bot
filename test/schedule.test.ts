import { describe, expect, it } from "vitest";
import {
  isWithinSchedule,
  monitoringWindowKey,
  nextMonitorAlarmAt,
  type Schedule,
} from "../src/index";

const MONITOR_POLL_INTERVAL_MS = 10_000;

describe("monitor schedule", () => {
  it("uses a stable Lisbon window key for ten-second monitoring", () => {
    const schedule: Schedule = {
      days: { mon: true },
      startTime: "08:00",
      endTime: "18:00",
    };

    expect(MONITOR_POLL_INTERVAL_MS).toBe(10_000);
    expect(monitoringWindowKey(schedule, new Date("2026-07-27T10:00:00.000Z")))
      .toBe("2026-07-27:08:00-18:00");
    expect(monitoringWindowKey(schedule, new Date("2026-07-28T10:00:00.000Z")))
      .toBeNull();
    expect(nextMonitorAlarmAt(1_000, 2_000)).toBe(11_000);
    expect(nextMonitorAlarmAt(1_000, 20_000)).toBe(20_100);
  });

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
