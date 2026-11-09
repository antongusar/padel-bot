import { describe, expect, it } from "vitest";
import {
  buildJoinCandidates,
  enabledMonitoredGroupIds,
  isWaitingForConfiguredEventType,
  monitoredGroupsFromStoredValue,
  normalizeMonitoredGroupId,
  normalizeMonitoredGroupIds,
  normalizeMonitoredGroups,
  normalizeMinParticipants,
  validateDoublesTeamSettings,
} from "../src/index";

const defaults = {
  joinSingles: true,
  joinDoubles: false,
  doublesTeams: [],
  minParticipants: 10,
};

describe("monitored group settings", () => {
  it("defaults to ten participants and preserves a custom threshold", () => {
    expect(normalizeMinParticipants(undefined)).toBe(10);
    expect(normalizeMinParticipants("invalid")).toBe(10);
    expect(normalizeMinParticipants(0)).toBe(0);
    expect(normalizeMonitoredGroups([{ id: "group", minParticipants: 12 }])[0].minParticipants).toBe(12);
  });
  it("accepts a group ID or a full Racket group URL", () => {
    expect(normalizeMonitoredGroupId("4Y4qCwClTWQPAM")).toBe(
      "4Y4qCwClTWQPAM",
    );
    expect(
      normalizeMonitoredGroupId(
        "https://racket.id/groups/IenuPng40UmpsU/?tab=events",
      ),
    ).toBe("IenuPng40UmpsU");
  });

  it("removes empty and duplicate group IDs while preserving priority", () => {
    expect(
      normalizeMonitoredGroupIds([
        "4Y4qCwClTWQPAM",
        "",
        "https://racket.id/groups/IenuPng40UmpsU/",
        "4Y4qCwClTWQPAM",
      ]),
    ).toEqual(["4Y4qCwClTWQPAM", "IenuPng40UmpsU"]);
  });

  it("rejects malformed IDs and encoded path separators", () => {
    expect(normalizeMonitoredGroupId("not a group")).toBeNull();
    expect(
      normalizeMonitoredGroupId("https://racket.id/groups/bad%2Fid"),
    ).toBeNull();
    expect(normalizeMonitoredGroupId("%ZZ")).toBeNull();
  });

  it("uses the environment group only until settings are saved", () => {
    expect(monitoredGroupsFromStoredValue(null, "defaultGroup")).toEqual([
      { id: "defaultGroup", enabled: true, ...defaults },
    ]);
    expect(monitoredGroupsFromStoredValue("[]", "defaultGroup")).toEqual([]);
    expect(
      monitoredGroupsFromStoredValue(
        '["firstGroup","secondGroup"]',
        "defaultGroup",
      ),
    ).toEqual([
      { id: "firstGroup", enabled: true, ...defaults },
      { id: "secondGroup", enabled: true, ...defaults },
    ]);
    expect(monitoredGroupsFromStoredValue(null, null)).toEqual([]);
  });

  it("preserves disabled groups without checking them by default", () => {
    const groups = normalizeMonitoredGroups([
      { id: "firstGroup", enabled: false },
      { id: "secondGroup", enabled: true },
      "legacyGroup",
    ]);
    expect(groups).toEqual([
      { id: "firstGroup", enabled: false, ...defaults },
      { id: "secondGroup", enabled: true, ...defaults },
      { id: "legacyGroup", enabled: true, ...defaults },
    ]);
    expect(enabledMonitoredGroupIds(groups)).toEqual([
      "secondGroup",
      "legacyGroup",
    ]);
  });

  it("preserves doubles teams and keeps doubles disabled for legacy settings", () => {
    expect(normalizeMonitoredGroups([
      {
        id: "group",
        joinSingles: false,
        joinDoubles: true,
        doublesTeams: [
          { id: "pair-1", leaderId: "anton", partnerId: null },
        ],
      },
    ])).toEqual([
      {
        id: "group",
        enabled: true,
        joinSingles: false,
        joinDoubles: true,
        minParticipants: 10,
        doublesTeams: [
          {
            id: "pair-1",
            leaderId: "anton",
            partnerId: null,
            enabled: true,
          },
        ],
      },
    ]);
  });

  it("rejects a player used by two enabled teams", () => {
    const groups = normalizeMonitoredGroups([
      {
        id: "group",
        joinDoubles: true,
        doublesTeams: [
          { id: "one", leaderId: "anton", partnerId: "vlad" },
          { id: "two", leaderId: "andrey", partnerId: "anton" },
        ],
      },
    ]);
    const roster = ["anton", "vlad", "andrey"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
      password: "secret",
      enabled: true,
    }));
    expect(validateDoublesTeamSettings(groups, roster)).toContain(
      "нескольких парах",
    );
  });

  it("treats a normal padel event as singles registration even when doubles is true", () => {
    const roster = ["anton", "vlad"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
      password: "secret",
      enabled: true,
    }));
    const candidates = buildJoinCandidates(
      roster,
      { id: "event", title: "Saturday", doubles: true },
      { id: "group", enabled: true, ...defaults },
    );

    expect(candidates.map((candidate) => candidate.id)).toEqual(["anton", "vlad"]);
  });

  it("builds the team-signup queue from configured pairs in priority order", () => {
    const roster = ["anton", "vlad", "andrey"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
      password: "secret",
      enabled: true,
    }));
    const candidates = buildJoinCandidates(
      roster,
      { id: "event", title: "Tournament", teamSignup: true, fixedTeams: true },
      {
        id: "group",
        enabled: true,
        joinSingles: true,
        joinDoubles: true,
        doublesTeams: [
          { id: "first", leaderId: "andrey", partnerId: null, enabled: true },
          { id: "second", leaderId: "anton", partnerId: "vlad", enabled: true },
        ],
      },
    );

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "team:first",
      "team:second",
    ]);
    expect(candidates.map((candidate) => candidate.name)).toEqual([
      "andrey + Placeholder",
      "anton + vlad",
    ]);
  });

  it("keeps fast polling while an enabled event type has not appeared", () => {
    const group = {
      id: "group",
      enabled: true,
      joinSingles: true,
      joinDoubles: true,
      doublesTeams: [
        { id: "pair", leaderId: "anton", partnerId: null, enabled: true },
      ],
    };
    const singlesEvent = { id: "singles", title: "Saturday", doubles: true };
    const doublesEvent = {
      id: "doubles",
      title: "Tournament",
      teamSignup: true,
      fixedTeams: true,
    };

    expect(isWaitingForConfiguredEventType([singlesEvent], group)).toBe(true);
    expect(isWaitingForConfiguredEventType([singlesEvent, doublesEvent], group)).toBe(false);
  });
});
