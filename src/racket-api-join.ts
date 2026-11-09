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
  partnerUserId?: string;
  reason?: string;
  // The document returned by a successful PATCH, used to verify the write
  // without spending another read.
  document?: FirestoreDocument;
}

export type ApiJoinAttemptOutcome =
  | "already_joined"
  | "unsupported"
  | "invalid_document"
  | "read_failed"
  | "placeholder_created"
  | "placeholder_create_failed"
  | "write_succeeded"
  | "write_conflict"
  | "write_failed";

export interface ApiJoinAttemptTelemetry {
  attempt: number;
  outcome: ApiJoinAttemptOutcome;
  readStatus: number | null;
  readDurationMs: number;
  writeStatus?: number | null;
  writeDurationMs?: number;
  totalDurationMs: number;
  responseUpdateTime?: string;
  reason?: string;
}

type ProductReadResult =
  | {
      ok: true;
      document: FirestoreDocument;
      status: number;
      durationMs: number;
    }
  | {
      ok: false;
      status: number | null;
      durationMs: number;
      reason: string;
    };

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

function registrationValue(nodeId: string, joinDate: string): FirestoreValue {
  return {
    mapValue: {
      fields: {
        registration: {
          mapValue: {
            fields: {
              [nodeId]: {
                mapValue: {
                  fields: {
                    joinDate: { stringValue: joinDate },
                    confirmationPending: { nullValue: null },
                  },
                },
              },
            },
          },
        },
        registrationFields: { mapValue: {} },
      },
    },
  };
}

function unsupportedRegistrationReason(
  fields: FirestoreFields,
): string | null {
  if (
    hasValues(fields.price) ||
    hasValues(fields.registrationFields) ||
    Boolean(fields.club?.stringValue)
  ) {
    return "Paid, club, or custom-field registration requires the browser flow.";
  }
  return null;
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
  const unsupportedReason = unsupportedRegistrationReason(fields);
  if (unsupportedReason) return { unsupported: unsupportedReason };

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
        [racketUserId]: registrationValue(signupNodeId(fields), joinDate),
      },
    },
  };
  patchFields.reserves = stringArrayValue(
    reserves.filter((id) => id !== racketUserId),
  );
  fieldPaths.push(userPath, "reserves");
  return { fields: patchFields, fieldPaths, status: "registered" };
}

export function buildApiTeamJoinPatch(
  document: FirestoreDocument,
  leaderUserId: string,
  partnerUserId: string,
  joinDate: string,
): ApiJoinPatch | { unsupported: string } | { alreadyJoined: ParticipationStatus } {
  const fields = document.fields || {};
  if (!fields.teamSignup?.booleanValue) {
    return { unsupported: "The event is not configured for team registration." };
  }

  const users = fields.users?.mapValue?.fields || {};
  const reserves = stringArray(fields.reserves);
  const leaderStatus = findFirestoreParticipation(
    Object.keys(users),
    reserves,
    leaderUserId,
  );
  if (leaderStatus !== "not_joined") {
    return { alreadyJoined: leaderStatus };
  }

  const partnerStatus = findFirestoreParticipation(
    Object.keys(users),
    reserves,
    partnerUserId,
  );
  if (partnerStatus !== "not_joined") {
    return { unsupported: "The selected partner is already registered for this event." };
  }

  const unsupportedReason = unsupportedRegistrationReason(fields);
  if (unsupportedReason) return { unsupported: unsupportedReason };

  const slots = Number(fields.slots?.integerValue || 0);
  if (!slots) return { unsupported: "The event has no registration capacity." };

  const teamIds = [leaderUserId, partnerUserId];
  const invitations = stringArray(fields.invitations).filter(
    (id) => !teamIds.includes(id),
  );
  const indexedUsers = unique([...stringArray(fields._users), ...teamIds]);
  const patchFields: FirestoreFields = {
    invitations: stringArrayValue(invitations),
    _users: stringArrayValue(indexedUsers),
  };
  const fieldPaths = ["invitations", "_users"];
  const placesRemaining = slots - Object.keys(users).length;

  if (placesRemaining < 2) {
    patchFields.reserves = stringArrayValue(unique([...reserves, ...teamIds]));
    fieldPaths.push("reserves");
    return { fields: patchFields, fieldPaths, status: "reserve" };
  }

  const nodeId = signupNodeId(fields);
  patchFields.users = {
    mapValue: {
      fields: Object.fromEntries(
        teamIds.map((userId) => [userId, registrationValue(nodeId, joinDate)]),
      ),
    },
  };
  patchFields.reserves = stringArrayValue(
    reserves.filter((id) => !teamIds.includes(id)),
  );
  fieldPaths.push(
    ...teamIds.map((userId) => `users.${fieldPathSegment(userId)}`),
    "reserves",
  );
  return { fields: patchFields, fieldPaths, status: "registered" };
}

async function getProduct(
  eventId: string,
  idToken: string,
): Promise<ProductReadResult> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/IProducts/${eventId}?key=${FIRESTORE_API_KEY}`,
      { headers: { authorization: `Bearer ${idToken}` } },
    );
  } catch (error) {
    return {
      ok: false,
      status: null,
      durationMs: Date.now() - startedAt,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      durationMs: Date.now() - startedAt,
      reason: `Firestore API join read failed: ${response.status} ${await response.text()}`,
    };
  }
  return {
    ok: true,
    document: await response.json(),
    status: response.status,
    durationMs: Date.now() - startedAt,
  };
}

// Several concurrent writers are expected while an event fills up. Firestore
// reports a stale currentDocument.updateTime as 409/412, and sometimes as
// 400 FAILED_PRECONDITION; all of them mean "re-read and try again".
const MAX_WRITE_ATTEMPTS = 5;

export function isWriteConflict(status: number, body: string): boolean {
  return status === 409 || status === 412 ||
    (status === 400 && /FAILED_PRECONDITION/.test(body));
}

export async function joinEventViaApi(
  eventId: string,
  auth: { idToken: string; racketUserId: string },
  joinDate: string,
  onAttempt?: (telemetry: ApiJoinAttemptTelemetry) => void,
): Promise<ApiJoinResult> {
  for (let attemptIndex = 0; attemptIndex < MAX_WRITE_ATTEMPTS; attemptIndex += 1) {
    const attempt = attemptIndex + 1;
    const attemptStartedAt = Date.now();
    const read = await getProduct(eventId, auth.idToken);
    if (!read.ok) {
      onAttempt?.({
        attempt,
        outcome: "read_failed",
        readStatus: read.status,
        readDurationMs: read.durationMs,
        totalDurationMs: Date.now() - attemptStartedAt,
        reason: read.reason,
      });
      return { ok: false, supported: true, reason: read.reason };
    }

    const document = read.document;
    const patch = buildApiJoinPatch(
      document,
      auth.racketUserId,
      joinDate,
    );

    if ("alreadyJoined" in patch) {
      onAttempt?.({
        attempt,
        outcome: "already_joined",
        readStatus: read.status,
        readDurationMs: read.durationMs,
        totalDurationMs: Date.now() - attemptStartedAt,
      });
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
      onAttempt?.({
        attempt,
        outcome: "unsupported",
        readStatus: read.status,
        readDurationMs: read.durationMs,
        totalDurationMs: Date.now() - attemptStartedAt,
        reason: patch.unsupported,
      });
      return { ok: false, supported: false, reason: patch.unsupported };
    }
    if (!document.name || !document.updateTime) {
      const reason = "Firestore product is missing name or updateTime.";
      onAttempt?.({
        attempt,
        outcome: "invalid_document",
        readStatus: read.status,
        readDurationMs: read.durationMs,
        totalDurationMs: Date.now() - attemptStartedAt,
        reason,
      });
      return {
        ok: false,
        supported: false,
        reason,
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

    const writeStartedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(url, {
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
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      onAttempt?.({
        attempt,
        outcome: "write_failed",
        readStatus: read.status,
        readDurationMs: read.durationMs,
        writeStatus: null,
        writeDurationMs: Date.now() - writeStartedAt,
        totalDurationMs: Date.now() - attemptStartedAt,
        reason,
      });
      return { ok: false, supported: true, reason };
    }
    const writeDurationMs = Date.now() - writeStartedAt;

    if (response.ok) {
      const responseDocument = await response.json().catch(() => null) as
        | FirestoreDocument
        | null;
      onAttempt?.({
        attempt,
        outcome: "write_succeeded",
        readStatus: read.status,
        readDurationMs: read.durationMs,
        writeStatus: response.status,
        writeDurationMs,
        totalDurationMs: Date.now() - attemptStartedAt,
        responseUpdateTime: responseDocument?.updateTime,
      });
      return {
        ok: true,
        supported: true,
        status: patch.status,
        document: responseDocument ?? undefined,
      };
    }
    const errorText = await response.text();
    if (isWriteConflict(response.status, errorText)) {
      onAttempt?.({
        attempt,
        outcome: "write_conflict",
        readStatus: read.status,
        readDurationMs: read.durationMs,
        writeStatus: response.status,
        writeDurationMs,
        totalDurationMs: Date.now() - attemptStartedAt,
        reason: "Firestore document changed after it was read.",
      });
      continue;
    }

    const reason = `Firestore API join write failed: ${response.status} ${errorText}`;
    onAttempt?.({
      attempt,
      outcome: "write_failed",
      readStatus: read.status,
      readDurationMs: read.durationMs,
      writeStatus: response.status,
      writeDurationMs,
      totalDurationMs: Date.now() - attemptStartedAt,
      reason,
    });
    return {
      ok: false,
      supported: true,
      reason,
    };
  }

  return {
    ok: false,
    supported: true,
    reason: "The event changed during all API join attempts.",
  };
}

function createTemporaryUserId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return `000T${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

async function createTemporaryProfile(
  userId: string,
  idToken: string,
  creationDate: string,
): Promise<{ ok: true; status: number; durationMs: number } | {
  ok: false;
  status: number | null;
  durationMs: number;
  reason: string;
}> {
  const startedAt = Date.now();
  const url = new URL(
    `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/IUserProfiles/${userId}`,
  );
  url.searchParams.set("key", FIRESTORE_API_KEY);
  url.searchParams.set("currentDocument.exists", "false");

  let response: Response;
  try {
    response = await fetch(url, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${idToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          id: { stringValue: userId },
          name: { stringValue: "Placeholder" },
          creationDate: { stringValue: creationDate },
          isTemporary: { booleanValue: true },
        },
      }),
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      durationMs: Date.now() - startedAt,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      durationMs: Date.now() - startedAt,
      reason: `Temporary partner creation failed: ${response.status} ${await response.text()}`,
    };
  }
  await response.arrayBuffer();
  return { ok: true, status: response.status, durationMs: Date.now() - startedAt };
}

export async function joinTeamEventViaApi(
  eventId: string,
  auth: { idToken: string; racketUserId: string },
  partnerUserId: string | null,
  joinDate: string,
  onAttempt?: (telemetry: ApiJoinAttemptTelemetry) => void,
): Promise<ApiJoinResult> {
  let resolvedPartnerUserId = partnerUserId || createTemporaryUserId();
  let placeholderCreated = Boolean(partnerUserId);

  for (let attemptIndex = 0; attemptIndex < MAX_WRITE_ATTEMPTS; attemptIndex += 1) {
    const attempt = attemptIndex + 1;
    const attemptStartedAt = Date.now();
    const read = await getProduct(eventId, auth.idToken);
    if (!read.ok) {
      onAttempt?.({
        attempt,
        outcome: "read_failed",
        readStatus: read.status,
        readDurationMs: read.durationMs,
        totalDurationMs: Date.now() - attemptStartedAt,
        reason: read.reason,
      });
      return { ok: false, supported: true, reason: read.reason };
    }

    const patch = buildApiTeamJoinPatch(
      read.document,
      auth.racketUserId,
      resolvedPartnerUserId,
      joinDate,
    );
    if ("alreadyJoined" in patch) {
      onAttempt?.({
        attempt,
        outcome: "already_joined",
        readStatus: read.status,
        readDurationMs: read.durationMs,
        totalDurationMs: Date.now() - attemptStartedAt,
      });
      return {
        ok: true,
        supported: true,
        status: patch.alreadyJoined as Exclude<ParticipationStatus, "not_joined">,
        alreadyJoined: true,
        partnerUserId: resolvedPartnerUserId,
      };
    }
    if ("unsupported" in patch) {
      onAttempt?.({
        attempt,
        outcome: "unsupported",
        readStatus: read.status,
        readDurationMs: read.durationMs,
        totalDurationMs: Date.now() - attemptStartedAt,
        reason: patch.unsupported,
      });
      return { ok: false, supported: false, reason: patch.unsupported };
    }
    if (!read.document.name || !read.document.updateTime) {
      const reason = "Firestore product is missing name or updateTime.";
      onAttempt?.({
        attempt,
        outcome: "invalid_document",
        readStatus: read.status,
        readDurationMs: read.durationMs,
        totalDurationMs: Date.now() - attemptStartedAt,
        reason,
      });
      return { ok: false, supported: false, reason };
    }

    if (!placeholderCreated) {
      const profile = await createTemporaryProfile(
        resolvedPartnerUserId,
        auth.idToken,
        joinDate,
      );
      onAttempt?.({
        attempt,
        outcome: profile.ok ? "placeholder_created" : "placeholder_create_failed",
        readStatus: read.status,
        readDurationMs: read.durationMs,
        writeStatus: profile.status,
        writeDurationMs: profile.durationMs,
        totalDurationMs: Date.now() - attemptStartedAt,
        reason: profile.ok ? undefined : profile.reason,
      });
      if (!profile.ok) {
        return { ok: false, supported: true, reason: profile.reason };
      }
      placeholderCreated = true;
    }

    const url = new URL(`https://firestore.googleapis.com/v1/${read.document.name}`);
    url.searchParams.set("key", FIRESTORE_API_KEY);
    for (const fieldPath of patch.fieldPaths) {
      url.searchParams.append("updateMask.fieldPaths", fieldPath);
    }
    url.searchParams.set("currentDocument.updateTime", read.document.updateTime);

    const writeStartedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(url, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${auth.idToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: read.document.name, fields: patch.fields }),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      onAttempt?.({
        attempt,
        outcome: "write_failed",
        readStatus: read.status,
        readDurationMs: read.durationMs,
        writeStatus: null,
        writeDurationMs: Date.now() - writeStartedAt,
        totalDurationMs: Date.now() - attemptStartedAt,
        reason,
      });
      return { ok: false, supported: true, reason };
    }
    const writeDurationMs = Date.now() - writeStartedAt;

    if (response.ok) {
      const responseDocument = await response.json().catch(() => null) as
        | FirestoreDocument
        | null;
      onAttempt?.({
        attempt,
        outcome: "write_succeeded",
        readStatus: read.status,
        readDurationMs: read.durationMs,
        writeStatus: response.status,
        writeDurationMs,
        totalDurationMs: Date.now() - attemptStartedAt,
        responseUpdateTime: responseDocument?.updateTime,
      });
      return {
        ok: true,
        supported: true,
        status: patch.status,
        partnerUserId: resolvedPartnerUserId,
        document: responseDocument ?? undefined,
      };
    }
    const errorText = await response.text();
    if (isWriteConflict(response.status, errorText)) {
      onAttempt?.({
        attempt,
        outcome: "write_conflict",
        readStatus: read.status,
        readDurationMs: read.durationMs,
        writeStatus: response.status,
        writeDurationMs,
        totalDurationMs: Date.now() - attemptStartedAt,
        reason: "Firestore document changed after it was read.",
      });
      continue;
    }

    const reason = `Firestore team join write failed: ${response.status} ${errorText}`;
    onAttempt?.({
      attempt,
      outcome: "write_failed",
      readStatus: read.status,
      readDurationMs: read.durationMs,
      writeStatus: response.status,
      writeDurationMs,
      totalDurationMs: Date.now() - attemptStartedAt,
      reason,
    });
    return { ok: false, supported: true, reason };
  }

  return {
    ok: false,
    supported: true,
    partnerUserId: resolvedPartnerUserId,
    reason: "The event changed during all API team join attempts.",
  };
}
