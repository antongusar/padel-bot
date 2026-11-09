import { describe, expect, it } from "vitest";
import {
  normalizeOperationLog,
  operationLogMatchesView,
  sanitizeLogDetails,
} from "../src/operation-log-store";

describe("operation log safety", () => {
  it("redacts credentials recursively", () => {
    expect(sanitizeLogDetails({
      personId: "person-1",
      password: "unsafe",
      nested: {
        authorization: "Bearer unsafe",
        idToken: "unsafe",
        email: "person@example.com",
        status: 412,
      },
    })).toEqual({
      personId: "person-1",
      password: "[redacted]",
      nested: {
        authorization: "[redacted]",
        idToken: "[redacted]",
        email: "[redacted]",
        status: 412,
      },
    });
  });

  it("normalizes level and rejects empty actions", () => {
    expect(normalizeOperationLog({ action: "" })).toBeNull();
    expect(normalizeOperationLog({
      action: "firestore_join_attempt",
      level: "warn",
      sequence: 4,
      details: { writeStatus: 412 },
    })).toMatchObject({
      action: "firestore_join_attempt",
      level: "warn",
      sequence: 4,
      details: { writeStatus: 412 },
    });
  });

  it("separates real join runs from routine cron checks", () => {
    const entry = (action: string, level: "info" | "warn" | "error" = "info", details = {}) => ({
      action,
      level,
      details,
    });

    expect(operationLogMatchesView(entry("cron_started"), "join")).toBe(false);
    expect(operationLogMatchesView(entry("autojoin_event_selected"), "join")).toBe(false);
    expect(operationLogMatchesView(entry("autojoin_skipped"), "join")).toBe(false);
    expect(operationLogMatchesView(entry("group_check_finished", "info", { hasEvents: false }), "events")).toBe(false);
    expect(operationLogMatchesView(entry("join_person_started"), "join")).toBe(true);
    expect(operationLogMatchesView(entry("manual_join_started"), "join")).toBe(true);
    expect(operationLogMatchesView(entry("browser_fallback_started", "warn"), "join")).toBe(false);
    expect(operationLogMatchesView(entry("cron_failed", "error"), "problems")).toBe(true);
    expect(operationLogMatchesView(entry("group_check_finished", "info", { hasEvents: true }), "events")).toBe(true);
  });
});
