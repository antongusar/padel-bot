import type { EventSummary, FirestoreDocument } from "./index";

export interface CopySeed {
  id: string;
  creator?: string;
}

export type CopySeedsByGroup = Record<string, CopySeed[]>;

const FIRESTORE_API_KEY = "AIzaSyBDPghSVKxu2gU-nPdyJJVgoLd7SSVZjZI";
const QUERY_FIELDS = [
  "type", "status", "group", "creator", "copiedFrom", "title", "date",
  "doubles", "teamSignup", "fixedTeams",
];

async function queryProducts(field: "group" | "copiedFrom", values: string[]) {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/racket-id/databases/(default)/documents:runQuery?key=${FIRESTORE_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "IProducts" }],
          select: { fields: QUERY_FIELDS.map((fieldPath) => ({ fieldPath })) },
          // Do not add a date filter: a new copy can have no date, and Racket's
          // compound copiedFrom/date query has returned empty results in practice.
          where: {
            fieldFilter: {
              field: { fieldPath: field },
              op: values.length === 1 ? "EQUAL" : "IN",
              value: values.length === 1
                ? { stringValue: values[0] }
                : { arrayValue: { values: values.map((stringValue) => ({ stringValue })) } },
            },
          },
        },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Copy discovery ${field} query failed: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json() as { document?: FirestoreDocument }[];
  return rows.flatMap((row) => row.document ? [row.document] : []);
}

const field = (document: FirestoreDocument, key: string) =>
  document.fields?.[key]?.stringValue;
const id = (document: FirestoreDocument) => document.name.split("/").pop()!;

export function isRecentUndatedEvent(document: FirestoreDocument, now: string): boolean {
  // Old permanent templates remain copy parents and are queried every minute,
  // but must not occupy the ten-second queue indefinitely.
  const cutoff = new Date(`${now.slice(0, 10)}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 7);
  return Boolean(document.createTime && document.createTime.slice(0, 10) >= cutoff.toISOString().slice(0, 10));
}

export function copyCandidate(
  document: FirestoreDocument,
  groupId: string,
  now: string,
): EventSummary | null {
  const group = field(document, "group");
  const date = field(document, "date");
  if (field(document, "type") !== "event" || field(document, "status") !== "instance" ||
      (group && group !== groupId) ||
      (!date && !isRecentUndatedEvent(document, now)) ||
      (date && (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date) || date < now))) {
    return null;
  }
  return {
    id: id(document), title: field(document, "title"), date: date || undefined,
    doubles: document.fields?.doubles?.booleanValue === true,
    teamSignup: document.fields?.teamSignup?.booleanValue === true,
    fixedTeams: document.fields?.fixedTeams?.booleanValue === true,
  };
}

export async function discoverEventCopies(
  groupId: string,
  storedSeeds: CopySeed[],
  now: string,
) {
  const seeds = new Map(storedSeeds.map((seed) => [seed.id, seed]));
  const candidates = new Map<string, EventSummary>();
  const remember = (document: FirestoreDocument) => {
    seeds.set(id(document), { id: id(document), creator: field(document, "creator") });
    const candidate = copyCandidate(document, groupId, now);
    if (candidate) candidates.set(candidate.id, candidate);
  };
  // All past group events are valid parents. In particular, keep parents even
  // after they expire or disappear from the group, across scheduler restarts.
  for (const document of await queryProducts("group", [groupId])) {
    if (field(document, "group") === groupId && field(document, "type") === "event" &&
        field(document, "status") === "instance") remember(document);
  }

  let frontier = Array.from(seeds.keys());
  const visited = new Set<string>();
  let copyQueryCount = 0;
  while (frontier.length) {
    const parents = frontier.splice(0, 30);
    for (const parent of parents) visited.add(parent);
    const parentSet = new Set(parents);
    const documents = await queryProducts("copiedFrom", parents);
    copyQueryCount++;
    for (const document of documents) {
      const parentId = field(document, "copiedFrom");
      const parent = parentId ? seeds.get(parentId) : undefined;
      const creator = field(document, "creator");
      const group = field(document, "group");
      if (!parentId || !parentSet.has(parentId) || !parent?.creator ||
          creator !== parent.creator || (group && group !== groupId) ||
          field(document, "type") !== "event" || field(document, "status") !== "instance") continue;
      const childId = id(document);
      remember(document);
      // Follow copied copies in the same discovery pass, without cycling.
      if (!visited.has(childId) && !frontier.includes(childId)) frontier.push(childId);
    }
  }
  return { seeds: Array.from(seeds.values()), candidates: Array.from(candidates.values()), copyQueryCount };
}
