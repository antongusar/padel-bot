import { describe, expect, it } from "vitest";
import {
  enabledMonitoredGroupIds,
  monitoredGroupsFromStoredValue,
  normalizeMonitoredGroupId,
  normalizeMonitoredGroupIds,
  normalizeMonitoredGroups,
} from "../src/index";

describe("monitored group settings", () => {
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
      { id: "defaultGroup", enabled: true },
    ]);
    expect(monitoredGroupsFromStoredValue("[]", "defaultGroup")).toEqual([]);
    expect(
      monitoredGroupsFromStoredValue(
        '["firstGroup","secondGroup"]',
        "defaultGroup",
      ),
    ).toEqual([
      { id: "firstGroup", enabled: true },
      { id: "secondGroup", enabled: true },
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
      { id: "firstGroup", enabled: false },
      { id: "secondGroup", enabled: true },
      { id: "legacyGroup", enabled: true },
    ]);
    expect(enabledMonitoredGroupIds(groups)).toEqual([
      "secondGroup",
      "legacyGroup",
    ]);
  });
});
