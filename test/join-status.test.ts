import { describe, expect, it } from "vitest";
import {
  findCapacityInText,
  findFirestoreParticipation,
  findParticipationInText,
} from "../src/join-status";

const realEventShape = `
Saturday 14.00-16.00
Players 32/32
Liliia Chuiko
Yaroslav Alekseev
Reserves
Yevhen
Anton Gusar
Andrey D.
Mariana Uszik
Invitations (282)
Mariia Krutko
`;

describe("Racket participation detection", () => {
  it("uses the Racket user id for Firestore registration and reserve lists", () => {
    expect(
      findFirestoreParticipation(
        ["registered-racket-id"],
        ["reserve-racket-id"],
        "reserve-racket-id",
      ),
    ).toBe("reserve");
  });

  it("treats a player in Reserves as successfully joined", () => {
    expect(findParticipationInText(realEventShape, ["Anton Gusar"])).toMatchObject({
      joined: true,
      matchedName: "Anton Gusar",
      status: "reserve",
    });
  });

  it("distinguishes registered players from reserves", () => {
    expect(findParticipationInText(realEventShape, ["Yaroslav Alekseev"])).toMatchObject({
      joined: true,
      status: "registered",
    });
  });

  it("does not confuse an invitation with a joined player", () => {
    expect(findParticipationInText(realEventShape, ["Mariia Krutko"])).toMatchObject({
      joined: false,
      status: "not_joined",
    });
  });

  it("detects a full event without waiting for a missing Join button", () => {
    expect(findCapacityInText(realEventShape)).toEqual({
      full: true,
      current: 32,
      capacity: 32,
    });
  });
});
