import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildApiJoinPatch,
  buildApiTeamJoinPatch,
  joinEventViaApi,
  joinTeamEventViaApi,
  type ApiJoinAttemptTelemetry,
  type FirestoreDocument,
} from "../src/racket-api-join";

afterEach(() => {
  vi.unstubAllGlobals();
});

function product(options: {
  users?: string[];
  reserves?: string[];
  invitations?: string[];
  slots?: number;
  club?: string;
  teamSignup?: boolean;
  fixedTeams?: boolean;
} = {}): FirestoreDocument {
  const users = Object.fromEntries(
    (options.users || []).map((id) => [
      id,
      {
        mapValue: {
          fields: {
            registration: { mapValue: { fields: {} } },
          },
        },
      },
    ]),
  );
  const array = (values: string[]) => ({
    arrayValue: {
      values: values.map((value) => ({ stringValue: value })),
    },
  });

  return {
    name: "projects/racket-id/databases/(default)/documents/IProducts/event",
    updateTime: "2026-07-27T10:00:00Z",
    fields: {
      slots: { integerValue: String(options.slots ?? 8) },
      club: { stringValue: options.club || "" },
      teamSignup: { booleanValue: options.teamSignup === true },
      fixedTeams: { booleanValue: options.fixedTeams === true },
      users: { mapValue: { fields: users } },
      reserves: array(options.reserves || []),
      invitations: array(options.invitations || []),
      _users: array([
        ...(options.users || []),
        ...(options.reserves || []),
      ]),
      gameplan: {
        mapValue: {
          fields: {
            graph: {
              mapValue: {
                fields: {
                  nodes: {
                    arrayValue: {
                      values: [
                        {
                          mapValue: {
                            fields: {
                              id: { stringValue: "signupNode" },
                              type: { stringValue: "signup" },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

describe("direct Racket API join patch", () => {
  it("builds the same registration shape as the Racket client", () => {
    const result = buildApiJoinPatch(
      product({ invitations: ["anton", "other"] }),
      "anton",
      "2026-07-27 12:34:56",
    );
    expect("fields" in result && result.status).toBe("registered");
    if (!("fields" in result)) throw new Error("Expected patch");

    expect(result.fieldPaths).toContain("users.anton");
    expect(
      result.fields.users?.mapValue?.fields?.anton?.mapValue?.fields
        ?.registration?.mapValue?.fields?.signupNode?.mapValue?.fields
        ?.joinDate?.stringValue,
    ).toBe("2026-07-27 12:34:56");
    expect(
      result.fields.invitations?.arrayValue?.values?.map(
        (value) => value.stringValue,
      ),
    ).toEqual(["other"]);
    expect(
      result.fields._users?.arrayValue?.values?.map(
        (value) => value.stringValue,
      ),
    ).toContain("anton");
  });

  it("joins the reserve list when all slots are occupied", () => {
    const result = buildApiJoinPatch(
      product({ users: ["one", "two"], slots: 2 }),
      "anton",
      "2026-07-27 12:34:56",
    );
    expect("fields" in result && result.status).toBe("reserve");
    if (!("fields" in result)) throw new Error("Expected patch");
    expect(result.fields.users).toBeUndefined();
    expect(
      result.fields.reserves?.arrayValue?.values?.map(
        (value) => value.stringValue,
      ),
    ).toEqual(["anton"]);
  });

  it("does not duplicate an existing registration", () => {
    expect(
      buildApiJoinPatch(
        product({ users: ["anton"] }),
        "anton",
        "2026-07-27 12:34:56",
      ),
    ).toEqual({ alreadyJoined: "registered" });
  });

  it("builds one fixed-team patch with a shared join date", () => {
    const result = buildApiTeamJoinPatch(
      product({ teamSignup: true, fixedTeams: true }),
      "anton",
      "partner",
      "2026-09-07 08:22:59",
    );
    if (!("fields" in result)) throw new Error("Expected team patch");

    expect(result.status).toBe("registered");
    expect(result.fieldPaths).toEqual(expect.arrayContaining([
      "users.anton",
      "users.partner",
    ]));
    const users = result.fields.users?.mapValue?.fields || {};
    expect(
      users.anton?.mapValue?.fields?.registration?.mapValue?.fields
        ?.signupNode?.mapValue?.fields?.joinDate?.stringValue,
    ).toBe("2026-09-07 08:22:59");
    expect(
      users.partner?.mapValue?.fields?.registration?.mapValue?.fields
        ?.signupNode?.mapValue?.fields?.joinDate?.stringValue,
    ).toBe("2026-09-07 08:22:59");
  });

  it("creates a temporary partner before joining a placeholder team", async () => {
    const attempts: ApiJoinAttemptTelemetry[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(product({
        teamSignup: true,
        fixedTeams: true,
      })))
      .mockResolvedValueOnce(Response.json({ updateTime: "profile-created" }))
      .mockResolvedValueOnce(Response.json({
        ...product({ users: ["anton"] }),
        updateTime: "2026-09-07T08:23:00Z",
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await joinTeamEventViaApi(
      "event",
      { idToken: "token", racketUserId: "anton" },
      null,
      "2026-09-07 08:22:59",
      (attempt) => attempts.push(attempt),
    );

    expect(result).toMatchObject({
      ok: true,
      status: "registered",
      partnerUserId: expect.stringMatching(/^000T/),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(attempts.map((attempt) => attempt.outcome)).toEqual([
      "placeholder_created",
      "write_succeeded",
    ]);
  });

  it("uses the browser fallback for club registrations", () => {
    expect(
      buildApiJoinPatch(
        product({ club: "club-id" }),
        "anton",
        "2026-07-27 12:34:56",
      ),
    ).toMatchObject({ unsupported: expect.stringContaining("browser") });
  });

  it("reports Firestore read and write status for a successful join", async () => {
    const attempts: ApiJoinAttemptTelemetry[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(product()))
      .mockResolvedValueOnce(Response.json({
        ...product({ users: ["anton"] }),
        updateTime: "2026-07-27T10:00:01Z",
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await joinEventViaApi(
      "event",
      { idToken: "token", racketUserId: "anton" },
      "2026-07-27 12:34:56",
      (attempt) => attempts.push(attempt),
    );

    expect(result).toMatchObject({ ok: true, status: "registered" });
    expect(attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: "write_succeeded",
        readStatus: 200,
        writeStatus: 200,
        responseUpdateTime: "2026-07-27T10:00:01Z",
      }),
    ]);
  });

  it("reports every optimistic-write conflict before falling back", async () => {
    const attempts: ApiJoinAttemptTelemetry[] = [];
    const responses = Array.from({ length: 3 }).flatMap(() => [
      Response.json(product()),
      new Response("conflict", { status: 412 }),
    ]);
    const fetchMock = vi.fn();
    responses.forEach((response) => fetchMock.mockResolvedValueOnce(response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await joinEventViaApi(
      "event",
      { idToken: "token", racketUserId: "anton" },
      "2026-07-27 12:34:56",
      (attempt) => attempts.push(attempt),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "The event changed during all API join attempts.",
    });
    expect(attempts).toHaveLength(3);
    expect(attempts.every((attempt) =>
      attempt.outcome === "write_conflict" && attempt.writeStatus === 412
    )).toBe(true);
  });
});
