import { describe, expect, it } from "vitest";
import {
  buildApiJoinPatch,
  type FirestoreDocument,
} from "../src/racket-api-join";

function product(options: {
  users?: string[];
  reserves?: string[];
  invitations?: string[];
  slots?: number;
  club?: string;
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

  it("uses the browser fallback for club registrations", () => {
    expect(
      buildApiJoinPatch(
        product({ club: "club-id" }),
        "anton",
        "2026-07-27 12:34:56",
      ),
    ).toMatchObject({ unsupported: expect.stringContaining("browser") });
  });
});
