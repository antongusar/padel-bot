import {
  findFirestoreParticipation,
  type ParticipationStatus,
} from "./join-status";

const FIRESTORE_API_KEY = "AIzaSyBDPghSVKxu2gU-nPdyJJVgoLd7SSVZjZI";
const FIRESTORE_PROJECT_ID = "racket-id";

export type FirestoreFields = Record<string, FirestoreValue>;

export interface FirestoreValue {
  nullValue?: null;
  booleanValue?: boolean;
  integerValue?: string;
  stringValue?: string;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: FirestoreFields };
}

export interface FirestoreDocument {
  name: string;
  fields?: FirestoreFields;
  updateTime?: string;
}

export interface ApiJoinPatch {
  fields: FirestoreFields;
  fieldPaths: string[];
  status: Exclude<ParticipationStatus, "not_joined">;
}

export interface ApiJoinResult {
  ok: boolean;
  supported: boolean;
  status?: Exclude<ParticipationStatus, "not_joined">;
  alreadyJoined?: boolean;
  reason?: string;
}

function stringArray(value: FirestoreValue | undefined): string[] {
  return value?.arrayValue?.values
    ?.map((item) => item.stringValue || "")
    .filter(Boolean) || [];
}

function stringArrayValue(values: string[]): FirestoreValue {
  return {
    arrayValue: {
      values: values.map((value) => ({ stringValue: value })),
    },
  };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function fieldPathSegment(value: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return value;
  return `\`${value.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
}

function signupNodeId(fields: FirestoreFields): string {
  const nodes =
    fields.gameplan?.mapValue?.fields?.graph?.mapValue?.fields?.nodes
      ?.arrayValue?.values || [];

  for (const node of nodes) {
    const nodeFields = node.mapValue?.fields;
    if (nodeFields?.type?.stringValue === "signup") {
      return nodeFields.id?.stringValue || "default";
    }
  }

  return "default";
}

function hasValues(value: FirestoreValue | undefined): boolean {
  if (!value) return false;
  if (value.arrayValue) return Boolean(value.arrayValue.values?.length);
  if (value.mapValue) return Boolean(
    value.mapValue.fields && Object.keys(value.mapValue.fields).length,
  );
  return true;
}

export function buildApiJoinPatch(
  document: FirestoreDocument,
  racketUserId: string,
  joinDate: string,
): ApiJoinPatch | { unsupported: string } | { alreadyJoined: ParticipationStatus } {
  const fields = document.fields || {};
  const users = fields.users?.mapValue?.fields || {};
  const reserves = stringArray(fields.reserves);
  const existing = findFirestoreParticipation(
    Object.keys(users),
    reserves,
    racketUserId,
  );

  if (existing !== "not_joined") {
    return { alreadyJoined: existing };
  }

  if (fields.teamSignup?.booleanValue || fields.fixedTeams?.booleanValue) {
    return { unsupported: "Team registration requires the browser flow." };
  }
  if (
    hasValues(fields.price) ||
    hasValues(fields.registrationFields) ||
    Boolean(fields.club?.stringValue)
  ) {
    return {
      unsupported:
        "Paid, club, or custom-field registration requires the browser flow.",
    };
  }

  const slots = Number(fields.slots?.integerValue || 0);
  if (!slots) {
    return { unsupported: "The event has no registration capacity." };
  }

  const full = Object.keys(users).length >= slots;
  const invitations = stringArray(fields.invitations).filter(
    (id) => id !== racketUserId,
  );
  const indexedUsers = unique([
    ...stringArray(fields._users),
    racketUserId,
  ]);
  const patchFields: FirestoreFields = {
    invitations: stringArrayValue(invitations),
    _users: stringArrayValue(indexedUsers),
  };
  const fieldPaths = ["invitations", "_users"];

  if (full) {
    patchFields.reserves = stringArrayValue([...reserves, racketUserId]);
    fieldPaths.push("reserves");
    return { fields: patchFields, fieldPaths, status: "reserve" };
  }

  const userPath = `users.${fieldPathSegment(racketUserId)}`;
  patchFields.users = {
    mapValue: {
      fields: {
        [racketUserId]: {
          mapValue: {
            fields: {
              registration: {
                mapValue: {
                  fields: {
                    [signupNodeId(fields)]: {
                      mapValue: {
                        fields: {
                          joinDate: { stringValue: joinDate },
                        },
                      },
                    },
                  },
                },
              },
              registrationFields: { mapValue: {} },
            },
          },
        },
      },
    },
  };
  patchFields.reserves = stringArrayValue(
    reserves.filter((id) => id !== racketUserId),
  );
  fieldPaths.push(userPath, "reserves");
  return { fields: patchFields, fieldPaths, status: "registered" };
}

async function getProduct(
  eventId: string,
  idToken: string,
): Promise<FirestoreDocument> {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/IProducts/${eventId}?key=${FIRESTORE_API_KEY}`,
    { headers: { authorization: `Bearer ${idToken}` } },
  );

  if (!response.ok) {
    throw new Error(
      `Firestore API join read failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

export async function joinEventViaApi(
  eventId: string,
  auth: { idToken: string; racketUserId: string },
  joinDate: string,
): Promise<ApiJoinResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const document = await getProduct(eventId, auth.idToken);
    const patch = buildApiJoinPatch(
      document,
      auth.racketUserId,
      joinDate,
    );

    if ("alreadyJoined" in patch) {
      return {
        ok: true,
        supported: true,
        status: patch.alreadyJoined as Exclude<
          ParticipationStatus,
          "not_joined"
        >,
        alreadyJoined: true,
      };
    }
    if ("unsupported" in patch) {
      return { ok: false, supported: false, reason: patch.unsupported };
    }
    if (!document.name || !document.updateTime) {
      return {
        ok: false,
        supported: false,
        reason: "Firestore product is missing name or updateTime.",
      };
    }

    const url = new URL(`https://firestore.googleapis.com/v1/${document.name}`);
    url.searchParams.set("key", FIRESTORE_API_KEY);
    for (const fieldPath of patch.fieldPaths) {
      url.searchParams.append("updateMask.fieldPaths", fieldPath);
    }
    url.searchParams.set(
      "currentDocument.updateTime",
      document.updateTime,
    );

    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${auth.idToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: document.name,
        fields: patch.fields,
      }),
    });

    if (response.ok) {
      return { ok: true, supported: true, status: patch.status };
    }
    if (response.status === 409 || response.status === 412) {
      continue;
    }

    return {
      ok: false,
      supported: true,
      reason: `Firestore API join write failed: ${response.status} ${await response.text()}`,
    };
  }

  return {
    ok: false,
    supported: true,
    reason: "The event changed during all API join attempts.",
  };
}
