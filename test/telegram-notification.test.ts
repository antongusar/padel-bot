import { describe, expect, it } from "vitest";
import {
  eventNotificationState,
  formatEventsTelegramMessage,
  type CheckResult,
  type EventSummary,
} from "../src/index";

const singles: EventSummary = {
  id: "singles-event",
  title: "Saturday 14.00-16.00",
  date: "2026-08-08 14:00:00",
  doubles: true,
  teamSignup: false,
  fixedTeams: false,
};

const doubles: EventSummary = {
  id: "doubles-event",
  title: "Sunday Doubles Tournament",
  date: "2026-08-09 14:00:00",
  teamSignup: true,
  fixedTeams: true,
};

function checkResult(events: EventSummary[]): CheckResult {
  return {
    checkedAt: "2026-08-03T11:01:00.000Z",
    ok: true,
    groupId: "group-id",
    groupUrl: "https://racket.id/groups/group-id/",
    hasEvents: events.length > 0,
    emptyStateTextFound: events.length === 0,
    source: "firestore",
    events,
    visibleTextPreview: "",
  };
}

describe("Telegram event notifications", () => {
  it("tracks event IDs and joinability without depending on query order", () => {
    expect(eventNotificationState([singles, doubles])).toBe(
      eventNotificationState([doubles, singles]),
    );
    expect(eventNotificationState([doubles])).not.toBe(
      eventNotificationState([doubles, singles]),
    );
    expect(eventNotificationState([])).toBe("false");
  });

  it("explains which events will be joined and which are skipped", () => {
    const message = formatEventsTelegramMessage(checkResult([singles, doubles]));

    expect(message).toContain(
      "Saturday 14.00-16.00 (2026-08-08 14:00:00) — обычное, подходит для автозаписи.",
    );
    expect(message).toContain(
      "Sunday Doubles Tournament (2026-08-09 14:00:00) — парное, автозапись выключена в настройках группы.",
    );
    expect(message).toContain("Обнаружено ботом: 2026-08-03 12:01:00 (Лиссабон).");
  });
});
