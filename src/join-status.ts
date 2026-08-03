export type ParticipationStatus = "registered" | "reserve" | "not_joined";

export interface ParticipationMatch {
  joined: boolean;
  matchedName: string;
  status: ParticipationStatus;
  region: string;
}

export function findFirestoreParticipation(
  registeredUserIds: string[],
  reserveUserIds: string[],
  racketUserId: string,
): ParticipationStatus {
  if (registeredUserIds.includes(racketUserId)) return "registered";
  if (reserveUserIds.includes(racketUserId)) return "reserve";
  return "not_joined";
}

export function findParticipationInText(
  body: string,
  names: string[],
): ParticipationMatch {
  const playersMatch =
    /sort by join date/i.exec(body) ||
    /\bplayers\s+\d+\s*\/\s*\d+/i.exec(body);

  if (!playersMatch) {
    return {
      joined: false,
      matchedName: "",
      status: "not_joined",
      region: "",
    };
  }

  const fromPlayers = body.slice(playersMatch.index);
  const invitationsIndex = fromPlayers.search(/\bInvitations\b/i);
  const participationText =
    invitationsIndex === -1
      ? fromPlayers
      : fromPlayers.slice(0, invitationsIndex);
  const normalized = participationText.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  const reserveIndex = lower.search(/\breserves\b/i);

  for (const name of names) {
    const normalizedName = name.trim().toLowerCase();
    if (!normalizedName) continue;

    const nameIndex = lower.indexOf(normalizedName);
    if (nameIndex === -1) continue;

    const status =
      reserveIndex !== -1 && nameIndex > reserveIndex
        ? "reserve"
        : "registered";
    return {
      joined: true,
      matchedName: name,
      status,
      region: normalized.slice(0, 700),
    };
  }

  return {
    joined: false,
    matchedName: "",
    status: "not_joined",
    region: normalized.slice(0, 700),
  };
}

export function findCapacityInText(body: string): {
  full: boolean;
  current?: number;
  capacity?: number;
} {
  const match = /\b(?:players\s+)?(\d+)\s*\/\s*(\d+)\b/i.exec(body);
  if (!match) return { full: false };

  const current = Number(match[1]);
  const capacity = Number(match[2]);
  return {
    full: capacity > 0 && current >= capacity,
    current,
    capacity,
  };
}
