import {
  history as browserHistory,
  launch,
  limits as browserLimits,
  sessions as browserSessions,
  type Browser,
  type Page,
  type ElementHandle,
} from "@cloudflare/puppeteer";
import {
  JoinCoordinatorClient,
  type JoinCoordinatorState,
} from "./join-coordinator";
import {
  runCoordinatedBatch,
  type CoordinatedBatchResult,
} from "./join-runner";
import {
  findCapacityInText,
  findFirestoreParticipation,
  findParticipationInText,
  type ParticipationStatus,
} from "./join-status";
import { joinEventViaApi, joinTeamEventViaApi } from "./racket-api-join";
import { discoverEventCopies, isRecentUndatedEvent, type CopySeedsByGroup } from "./event-copy-discovery";
import {
  OperationLogStoreClient,
  type OperationLogLevel,
  type OperationLogView,
} from "./operation-log-store";

export { JoinCoordinator } from "./join-coordinator";
export { OperationLogStore } from "./operation-log-store";

interface Env {
  MONITOR_STATE: KVNamespace;
  MONITOR_SCHEDULER: DurableObjectNamespace;
  JOIN_COORDINATOR: DurableObjectNamespace;
  OPERATION_LOGS: DurableObjectNamespace;
  BROWSER: BrowserRun;
  GROUP_ID?: string;
  JOIN_DEBUG_SCREENSHOTS?: string;
  JOIN_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

export interface CheckResult {
  checkedAt: string;
  ok: boolean;
  groupId: string;
  groupUrl: string;
  hasEvents: boolean;
  emptyStateTextFound: boolean;
  source: "firestore";
  events: EventSummary[];
  preparingEvents?: EventSummary[];
  copyDiscoveryError?: string;
  copyQueryCount?: number;
  groupConfig?: MonitoredGroup;
  visibleTextPreview: string;
  error?: string;
}

export interface EventSummary {
  id: string;
  title?: string;
  date?: string;
  doubles?: boolean;
  teamSignup?: boolean;
  fixedTeams?: boolean;
  registeredCount?: number;
  reserveCount?: number;
}

interface BrowserJoinDebug {
  url: string;
  title: string;
  textPreview: string;
  clickables: string[];
}

interface TextClickCandidate {
  text: string;
  exact?: boolean;
}

interface FirebaseAuthResult {
  idToken: string;
  localId: string;
  racketUserId: string;
}

interface RacketCallableEnvelope<T> {
  result?: T;
  data?: T;
  error?: {
    status?: string;
    message?: string;
    details?: unknown;
  };
}

interface RacketPreloginResult {
  success?: boolean;
  userIds?: unknown[];
  error?: string;
}

interface RacketLoginResult {
  success?: boolean;
  jwt?: string;
  error?: string;
}

export interface FirestoreDocument {
  name: string;
  fields?: FirestoreFields;
  createTime?: string;
  updateTime?: string;
}

type FirestoreFields = Record<string, FirestoreValue>;

type FirestoreValue = {
  nullValue?: "NULL_VALUE";
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  timestampValue?: string;
  stringValue?: string;
  bytesValue?: string;
  referenceValue?: string;
  geoPointValue?: { latitude: number; longitude: number };
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: FirestoreFields };
};

const TEST_GROUP_ID = "IenuPng40UmpsU";
const TEST_GROUP_URL = "https://racket.id/groups/IenuPng40UmpsU";
const FIRESTORE_API_KEY = "AIzaSyBDPghSVKxu2gU-nPdyJJVgoLd7SSVZjZI";
const FIRESTORE_PROJECT_ID = "racket-id";
const LAST_HAS_EVENTS_KEY = "last_has_events";
const TELEGRAM_CHAT_ID_KEY = "telegram_chat_id";
const MAX_JOIN_ATTEMPTS = 10;
const ROSTER_KEY = "roster";
const SCHEDULE_KEY = "schedule";
const MONITORED_GROUPS_KEY = "monitored_groups";
const ACTIVE_JOIN_EVENT_KEY = "active_join_event";
const ACTIVE_JOIN_EVENTS_KEY = "active_join_events";
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const MONITOR_POLL_INTERVAL_MS = 10_000;
const MONITOR_DISCOVERY_INTERVAL_MS = 60_000;
const MONITOR_SCHEDULER_NAME = "global";
const MONITOR_PENDING_EVENTS_KEY = "pending-events";
const MONITOR_COPY_SEEDS_KEY = "copy-seeds";
const MONITOR_LAST_DISCOVERY_KEY = "last-discovery-at";
const MONITOR_ROUTINE_LOG_MINUTE_KEY = "routine-log-minute";

type JoinOutcome = { ok: boolean; reason?: string };

interface Person {
  id: string;
  name: string;
  email: string;
  password: string;
  enabled: boolean;
}

export interface DoublesTeam {
  id: string;
  leaderId: string;
  partnerId: string | null;
  enabled: boolean;
}

interface JoinCandidate extends Person {
  leader: Person;
  partner: Person | null;
  doublesTeamId?: string;
}

export interface MonitoredGroup {
  id: string;
  enabled: boolean;
  joinSingles: boolean;
  joinDoubles: boolean;
  doublesTeams: DoublesTeam[];
  minParticipants?: number;
}

export interface Schedule {
  days: Record<string, boolean>;
  startTime: string; // "HH:MM" Lisbon
  endTime: string; // "HH:MM" Lisbon
  pausedUntil?: string;
}

interface TelegramUpdate {
  message?: {
    chat?: {
      id?: number | string;
    };
    text?: string;
  };
}

type OperationalLogger = (
  action: string,
  details?: Record<string, unknown>,
  level?: OperationLogLevel,
) => void;

type WaitUntilContext = Pick<ExecutionContext, "waitUntil">;
type AutoJoinStatus = "complete" | "retry" | "terminal";

function consoleOperationalLog(
  action: string,
  details: Record<string, unknown> = {},
  level: OperationLogLevel = "info",
): void {
  const entry = JSON.stringify({
    type: "racket-monitor",
    action,
    timestamp: new Date().toISOString(),
    ...details,
  });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

function createOperationalLogger(
  env: Env,
  ctx: WaitUntilContext,
  options: { runId: string; trigger: string },
): OperationalLogger {
  const id = env.OPERATION_LOGS.idFromName("global");
  const client = new OperationLogStoreClient(env.OPERATION_LOGS.get(id));
  let sequence = 0;

  return (action, details = {}, level = "info") => {
    sequence += 1;
    const timestamp = new Date().toISOString();
    consoleOperationalLog(action, {
      runId: options.runId,
      trigger: options.trigger,
      ...details,
    }, level);
    ctx.waitUntil(
      client.append({
        timestamp,
        action,
        level,
        sequence,
        runId: options.runId,
        trigger: options.trigger,
        details,
      }).catch((error) => {
        console.error("Operation log persistence failed:", error);
      }),
    );
  };
}

function getLisbonDateTimeString(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Lisbon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

// Short lowercase Lisbon weekday key: "mon", "tue", ... matching DAY_KEYS.
function getLisbonWeekday(date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Lisbon",
    weekday: "short",
  })
    .format(date)
    .toLowerCase();
}

// Current Lisbon time as "HH:MM" (zero-padded, 24h) for lexicographic comparison.
function getLisbonHM(date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Lisbon",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function fieldString(fields: Record<string, { stringValue?: string }> | undefined, field: string) {
  return fields?.[field]?.stringValue;
}

function fieldBool(fields: Record<string, { booleanValue?: boolean }> | undefined, field: string): boolean {
  return fields?.[field]?.booleanValue === true;
}

async function queryGroupEvents(groupId: string, limit = 10): Promise<EventSummary[]> {
  const currentDateTime = getLisbonDateTimeString();
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents:runQuery?key=${FIRESTORE_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "IProducts" }],
          where: {
            compositeFilter: {
              op: "AND",
              filters: [
                {
                  fieldFilter: {
                    field: { fieldPath: "group" },
                    op: "EQUAL",
                    value: { stringValue: groupId },
                  },
                },
                {
                  fieldFilter: {
                    field: { fieldPath: "status" },
                    op: "EQUAL",
                    value: { stringValue: "instance" },
                  },
                },
                {
                  fieldFilter: {
                    field: { fieldPath: "date" },
                    op: "GREATER_THAN_OR_EQUAL",
                    value: { stringValue: currentDateTime },
                  },
                },
              ],
            },
          },
          orderBy: [{ field: { fieldPath: "date" }, direction: "ASCENDING" }],
          limit,
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Firestore query failed: ${response.status} ${await response.text()}`);
  }

  const rows = (await response.json()) as Array<{
    document?: FirestoreDocument;
  }>;

  return rows
    .filter((row) => row.document)
    .map((row) => {
      const document = row.document!;
      return {
        id: document.name.split("/").pop() || document.name,
        title: fieldString(document.fields, "title"),
        date: fieldString(document.fields, "date"),
        doubles: fieldBool(document.fields, "doubles"),
        teamSignup: fieldBool(document.fields, "teamSignup"),
        fixedTeams: fieldBool(document.fields, "fixedTeams"),
        registeredCount: Object.keys(document.fields?.users?.mapValue?.fields || {}).length,
        reserveCount: firestoreStringArray(document.fields?.reserves).length,
      };
    });
}

function isDoublesEvent(event: EventSummary): boolean {
  return Boolean(event.teamSignup || event.fixedTeams);
}

function isEventEnabledForGroup(
  event: EventSummary,
  group?: MonitoredGroup,
): boolean {
  return isDoublesEvent(event)
    ? Boolean(group?.joinDoubles && group.doublesTeams.some((team) => team.enabled))
    : group?.joinSingles !== false;
}

export function isWaitingForConfiguredEventType(
  events: EventSummary[],
  group: MonitoredGroup,
): boolean {
  const hasSingles = events.some((event) => !isDoublesEvent(event));
  const hasDoubles = events.some(isDoublesEvent);
  const expectsDoubles = group.joinDoubles &&
    group.doublesTeams.some((team) => team.enabled);
  return (group.joinSingles && !hasSingles) || (expectsDoubles && !hasDoubles);
}

function pickJoinableEvent(
  events: EventSummary[],
  group?: MonitoredGroup,
): EventSummary | undefined {
  return events.find((event) => isEventEnabledForGroup(event, group));
}

export function eventNotificationState(events: EventSummary[]): string {
  if (!events.length) return "false";
  return `events:${events
    .map((event) => `${event.id}:${isDoublesEvent(event) ? "doubles" : "singles"}`)
    .sort()
    .join(",")}`;
}

export function formatEventsTelegramMessage(
  result: CheckResult,
  group?: MonitoredGroup,
): string {
  const lines = result.events.map((event, index) => {
    const title = event.title || event.date || event.id;
    const date = event.date && event.date !== title ? ` (${event.date})` : "";
    const eventType = isDoublesEvent(event) ? "парное" : "обычное";
    const decision = isEventEnabledForGroup(event, group)
      ? `${eventType}, подходит для автозаписи`
      : `${eventType}, автозапись выключена в настройках группы`;
    return `${index + 1}. ${title}${date} — ${decision}.`;
  });
  const detectedAt = getLisbonDateTimeString(new Date(result.checkedAt));

  return [
    `События в группе ${result.groupId}:`,
    ...lines,
    `Обнаружено ботом: ${detectedAt} (Лиссабон).`,
    result.groupUrl,
  ].join("\n");
}

function groupUrl(groupId: string): string {
  return `https://racket.id/groups/${encodeURIComponent(groupId)}/`;
}

export function normalizeMonitoredGroupId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;

  const urlMatch = /(?:^|\/)groups\/([^/?#]+)/i.exec(value);
  let candidate: string;
  try {
    candidate = decodeURIComponent(urlMatch?.[1] || value).trim();
  } catch {
    return null;
  }
  return /^[A-Za-z0-9_-]{4,128}$/.test(candidate) ? candidate : null;
}

export function normalizeMonitoredGroupIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw
    .map(normalizeMonitoredGroupId)
    .filter((groupId): groupId is string => groupId !== null);
  return [...new Set(ids)];
}

export function normalizeMonitoredGroups(raw: unknown): MonitoredGroup[] {
  if (!Array.isArray(raw)) return [];

  const groups: MonitoredGroup[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const record =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : null;
    const id = normalizeMonitoredGroupId(record ? record.id : value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const doublesTeams = record && Array.isArray(record.doublesTeams)
      ? record.doublesTeams
          .map((team): DoublesTeam | null => {
            if (!team || typeof team !== "object") return null;
            const fields = team as Record<string, unknown>;
            const leaderId = String(fields.leaderId ?? "").trim();
            const rawPartnerId = fields.partnerId;
            const partnerId = typeof rawPartnerId === "string" && rawPartnerId.trim()
              ? rawPartnerId.trim()
              : null;
            if (!leaderId || partnerId === leaderId) return null;
            return {
              id: String(fields.id ?? crypto.randomUUID()),
              leaderId,
              partnerId,
              enabled: fields.enabled !== false,
            };
          })
          .filter((team): team is DoublesTeam => team !== null)
      : [];
    groups.push({
      id,
      enabled: record ? record.enabled !== false : true,
      joinSingles: record ? record.joinSingles !== false : true,
      joinDoubles: record ? record.joinDoubles === true : false,
      doublesTeams,
      minParticipants: normalizeMinParticipants(record?.minParticipants),
    });
  }
  return groups;
}

export function normalizeMinParticipants(value: unknown): number {
  if (value === undefined || value === null || value === "") return 10;
  const count = Number(value);
  return Number.isFinite(count) ? Math.min(10_000, Math.max(0, Math.floor(count))) : 10;
}

export function enabledMonitoredGroupIds(
  groups: MonitoredGroup[],
): string[] {
  return groups.filter((group) => group.enabled).map((group) => group.id);
}

export function validateDoublesTeamSettings(
  groups: MonitoredGroup[],
  roster: Person[],
): string | null {
  const enabledPeople = new Set(
    roster.filter((person) => person.enabled).map((person) => person.id),
  );
  for (const group of groups) {
    if (!group.joinDoubles) continue;
    const usedIds = new Set<string>();
    for (const team of group.doublesTeams.filter((item) => item.enabled)) {
      if (!enabledPeople.has(team.leaderId)) {
        return `В группе ${group.id} у пары не выбран включённый первый игрок.`;
      }
      if (team.partnerId && !enabledPeople.has(team.partnerId)) {
        return `В группе ${group.id} выбранный партнёр выключен или удалён.`;
      }
      for (const personId of [team.leaderId, team.partnerId].filter(
        (id): id is string => Boolean(id),
      )) {
        if (usedIds.has(personId)) {
          return `В группе ${group.id} один игрок указан в нескольких парах.`;
        }
        usedIds.add(personId);
      }
    }
  }
  return null;
}

function fallbackGroupId(env: Env): string | null {
  return normalizeMonitoredGroupId(env.GROUP_ID);
}

export function monitoredGroupsFromStoredValue(
  raw: string | null,
  fallbackId: string | null,
): MonitoredGroup[] {
  const fallback = fallbackId
    ? [{
        id: fallbackId,
        enabled: true,
        joinSingles: true,
        joinDoubles: false,
        doublesTeams: [],
        minParticipants: 10,
      }]
    : [];
  if (raw === null) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? normalizeMonitoredGroups(parsed)
      : fallback;
  } catch {
    return fallback;
  }
}

async function getMonitoredGroups(env: Env): Promise<MonitoredGroup[]> {
  const raw = await env.MONITOR_STATE.get(MONITORED_GROUPS_KEY);
  return monitoredGroupsFromStoredValue(raw, fallbackGroupId(env));
}

async function saveMonitoredGroups(
  env: Env,
  groups: MonitoredGroup[],
): Promise<void> {
  await env.MONITOR_STATE.put(MONITORED_GROUPS_KEY, JSON.stringify(groups));
}

async function getActiveJoinEventIds(env: Env, groupId: string): Promise<string[]> {
  const raw = await env.MONITOR_STATE.get(`${ACTIVE_JOIN_EVENTS_KEY}:${groupId}`);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return Array.from(new Set(parsed.map(String).filter(Boolean)));
      }
    } catch {
      // Fall through to the legacy single-event key.
    }
  }
  const legacy = await env.MONITOR_STATE.get(`${ACTIVE_JOIN_EVENT_KEY}:${groupId}`);
  return legacy ? [legacy] : [];
}

async function saveActiveJoinEventIds(
  env: Env,
  groupId: string,
  eventIds: string[],
): Promise<void> {
  const normalized = Array.from(new Set(eventIds.filter(Boolean)));
  const key = `${ACTIVE_JOIN_EVENTS_KEY}:${groupId}`;
  const serialized = JSON.stringify(normalized);
  if (await env.MONITOR_STATE.get(key) !== serialized) {
    await env.MONITOR_STATE.put(key, serialized);
  }
  const legacyKey = `${ACTIVE_JOIN_EVENT_KEY}:${groupId}`;
  const first = normalized[0] || "";
  const legacy = await env.MONITOR_STATE.get(legacyKey);
  if (first && legacy !== first) {
    await env.MONITOR_STATE.put(legacyKey, first);
  } else if (!first && legacy !== null) {
    await env.MONITOR_STATE.delete(legacyKey);
  }
}

async function readKnownEvent(groupId: string, id: string): Promise<EventSummary | null> {
  let product: FirestoreDocument;
  try {
    product = await getFirestoreDocument(`IProducts/${id}`);
  } catch (error) {
    if (error instanceof Error &&
        error.message.startsWith(`Firestore get IProducts/${id} failed: 404 `)) return null;
    throw error;
  }
  const fields = product.fields;
  const date = fieldString(fields, "date");
  const currentGroup = fieldString(fields, "group");
  if (fieldString(fields, "status") !== "instance" ||
      (!date && !isRecentUndatedEvent(product, getLisbonDateTimeString())) ||
      (date && (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date) || date < getLisbonDateTimeString())) ||
      (currentGroup && currentGroup !== groupId)) {
    return null;
  }
  return {
    id,
    title: fieldString(fields, "title"),
    date,
    doubles: fieldBool(fields, "doubles"),
    teamSignup: fieldBool(fields, "teamSignup"),
    fixedTeams: fieldBool(fields, "fixedTeams"),
    registeredCount: Object.keys(fields?.users?.mapValue?.fields || {}).length,
    reserveCount: firestoreStringArray(fields?.reserves).length,
  };
}

async function checkGroupEvents(
  groupId: string,
  groupConfig?: MonitoredGroup,
  env?: Env,
): Promise<CheckResult> {
  const targetGroupUrl = groupUrl(groupId);
  const events = await queryGroupEvents(groupId);

  // An event may be detached from its group after discovery. Keep checking its
  // document directly while it is upcoming, including while waiting to join.
  if (env) {
    const knownIds = await getActiveJoinEventIds(env, groupId);
    const missingIds = knownIds.filter((id) => !events.some((event) => event.id === id));
    const knownEvents = await Promise.all(missingIds.map((id) => readKnownEvent(groupId, id)));
    events.push(...knownEvents.filter((event): event is EventSummary => event !== null && Boolean(event.date)));
    events.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  }

  return {
    checkedAt: new Date().toISOString(),
    ok: true,
    groupId,
    groupUrl: targetGroupUrl,
    hasEvents: events.length > 0,
    emptyStateTextFound: events.length === 0,
    source: "firestore",
    events,
    groupConfig,
    visibleTextPreview: events.length
      ? `Firestore returned ${events.length} upcoming event(s).`
      : "Firestore returned no upcoming events.",
  };
}

async function checkMonitoredGroupEvents(env: Env, configuredGroups?: MonitoredGroup[]): Promise<CheckResult[]> {
  const groups = (configuredGroups ?? await getMonitoredGroups(env)).filter((group) => group.enabled);
  return Promise.all(
    groups.map(async (group) => {
      try {
        return await checkGroupEvents(group.id, group, env);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          checkedAt: new Date().toISOString(),
          ok: false,
          groupId: group.id,
          groupUrl: groupUrl(group.id),
          hasEvents: false,
          emptyStateTextFound: false,
          source: "firestore" as const,
          events: [],
          groupConfig: group,
          visibleTextPreview: "Firestore group check failed.",
          error: message,
        };
      }
    }),
  );
}

function requireJoinSecret(request: Request, env: Env) {
  if (!env.JOIN_SECRET) {
    return jsonResponse(
      { ok: false, error: "JOIN_SECRET is not configured." },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const providedSecret = request.headers.get("x-join-secret") || url.searchParams.get("secret");

  if (providedSecret !== env.JOIN_SECRET) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

function truncateForError(text: string, maxLength = 1000): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

async function callRacketFunction<T>(name: string, data: Record<string, unknown>): Promise<T> {
  const response = await fetch(
    `https://us-central1-${FIRESTORE_PROJECT_ID}.cloudfunctions.net/${name}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    },
  );
  const text = await response.text();
  let envelope: RacketCallableEnvelope<T>;

  try {
    envelope = JSON.parse(text) as RacketCallableEnvelope<T>;
  } catch {
    throw new Error(`Racket callable ${name} returned invalid JSON: ${truncateForError(text)}`);
  }

  if (!response.ok || envelope.error) {
    const message = envelope.error?.message || truncateForError(text);
    throw new Error(`Racket callable ${name} failed: ${response.status} ${message}`);
  }

  const result = envelope.data ?? envelope.result;
  if (!result) {
    throw new Error(`Racket callable ${name} returned no result.`);
  }

  return result;
}

function getPreloginUserIds(prelogin: RacketPreloginResult): string[] {
  return uniqueStrings(
    (prelogin.userIds || [])
      .map((value) => (typeof value === "string" ? value : ""))
      .filter(Boolean),
  );
}

async function signInToRacket(
  emailValue: string,
  passwordValue: string,
): Promise<FirebaseAuthResult> {
  const email = emailValue.trim();
  const password = passwordValue.trim();
  if (!email || !password) {
    throw new Error("Racket email and password must be configured.");
  }
  const prelogin = await callRacketFunction<RacketPreloginResult>("preloginUser", {
    email,
    password,
  });

  if (!prelogin.success) {
    throw new Error(`Racket prelogin failed: ${prelogin.error || "unknown error"}`);
  }

  const userIds = getPreloginUserIds(prelogin);
  if (!userIds.length) {
    throw new Error("Racket prelogin failed: no user found for these credentials.");
  }

  if (userIds.length > 1) {
    throw new Error(`Racket prelogin returned multiple users: ${userIds.join(", ")}`);
  }

  const login = await callRacketFunction<RacketLoginResult>("loginUser", {
    userId: userIds[0],
    password,
  });

  if (!login.success || !login.jwt) {
    throw new Error(`Racket login failed: ${login.error || "missing custom token"}`);
  }

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIRESTORE_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: login.jwt,
        returnSecureToken: true,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Firebase custom token sign-in failed: ${response.status} ${await response.text()}`);
  }

  const firebase = (await response.json()) as Omit<FirebaseAuthResult, "racketUserId">;
  return { ...firebase, racketUserId: userIds[0] };
}

async function getFirestoreDocument(path: string, idToken?: string): Promise<FirestoreDocument> {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/${path}?key=${FIRESTORE_API_KEY}`,
    {
      headers: idToken ? { authorization: `Bearer ${idToken}` } : undefined,
    },
  );

  if (!response.ok) {
    throw new Error(`Firestore get ${path} failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as FirestoreDocument;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function firestoreStringArray(value: FirestoreValue | undefined): string[] {
  return value?.arrayValue?.values?.map((item) => item.stringValue || "").filter(Boolean) || [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollPageAction<T>(
  action: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await action();
    if (result) {
      return result;
    }
    await sleep(intervalMs);
  }

  return null;
}

async function tryClickByText(
  page: Page,
  candidates: TextClickCandidate[],
  timeoutMs = 10000,
  preferLast = false,
): Promise<string | null> {
  return pollPageAction(
    () =>
      page.evaluate(({ clickCandidates, useLast }) => {
        const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
        const isVisible = (element: Element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0"
          );
        };
        const textFor = (element: Element) =>
          normalize(
            [
              element.textContent || "",
              element.getAttribute("aria-label") || "",
              element.getAttribute("title") || "",
            ].join(" "),
          );
        const matches = (text: string, candidate: TextClickCandidate) => {
          const normalizedText = text.toLowerCase();
          const normalizedCandidate = normalize(candidate.text).toLowerCase();
          return candidate.exact
            ? normalizedText === normalizedCandidate
            : normalizedText.includes(normalizedCandidate);
        };
        const clickableAncestor = (element: Element) => {
          let current: Element | null = element;
          while (current && current !== document.body) {
            if (!(current instanceof HTMLElement)) break;
            const tag = current.tagName.toLowerCase();
            const role = current.getAttribute("role");
            const cursor = window.getComputedStyle(current).cursor;
            if (tag === "button" || tag === "a" || role === "button" || cursor === "pointer") {
              return current;
            }
            current = current.parentElement;
          }
          return element;
        };

        const elements = Array.from(
          document.querySelectorAll("button,a,[role='button'],[tabindex],div,span"),
        );

        for (const candidate of clickCandidates) {
          const found: HTMLElement[] = [];
          for (const element of elements) {
            const text = textFor(element);
            if (!text || !matches(text, candidate)) continue;

            const target = clickableAncestor(element);
            if (!isVisible(target) || !(target instanceof HTMLElement)) continue;
            if (!found.includes(target)) found.push(target);
          }

          if (found.length) {
            const target = useLast ? found[found.length - 1] : found[0];
            target.scrollIntoView({ block: "center", inline: "center" });
            target.click();
            return textFor(target) || null;
          }
        }

        return null;
      }, { clickCandidates: candidates, useLast: preferLast }),
    timeoutMs,
  );
}

async function fillLoginForm(page: Page, email: string, password: string): Promise<void> {
  const ready = await pollPageAction(
    () =>
      page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
        const visible = inputs.filter((input) => {
          const rect = input.getBoundingClientRect();
          const style = window.getComputedStyle(input);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
        });
        return visible.length >= 2 ? true : null;
      }),
    15000,
  );

  if (!ready) {
    throw new Error("Could not find Racket login email/password inputs.");
  }

  const handles = await page.$$("input");
  let emailHandle: ElementHandle<Element> | null = null;
  let passwordHandle: ElementHandle<Element> | null = null;
  let firstTextHandle: ElementHandle<Element> | null = null;

  for (const handle of handles) {
    const meta = await handle.evaluate((element) => {
      const input = element as HTMLInputElement;
      const rect = input.getBoundingClientRect();
      const style = window.getComputedStyle(input);
      return {
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden",
        type: input.type.toLowerCase(),
        hint: `${input.type} ${input.name} ${input.placeholder} ${input.autocomplete}`.toLowerCase(),
      };
    });

    if (!meta.visible) continue;

    if (meta.type === "password") {
      passwordHandle = passwordHandle || handle;
    } else {
      firstTextHandle = firstTextHandle || handle;
      if (!emailHandle && (meta.hint.includes("email") || meta.type === "email")) {
        emailHandle = handle;
      }
    }
  }

  emailHandle = emailHandle || firstTextHandle;

  if (!emailHandle || !passwordHandle) {
    throw new Error("Could not find Racket login email/password inputs.");
  }

  // Real keystrokes so the React login form registers the values and enables submit.
  await emailHandle.click({ clickCount: 3 });
  await emailHandle.type(email, { delay: 25 });
  await passwordHandle.click({ clickCount: 3 });
  await passwordHandle.type(password, { delay: 25 });
}

function eventTextHints(event: EventSummary): string[] {
  const hints = event.title ? [event.title] : [];
  const match = event.date?.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})/);

  if (match) {
    const [, year, month, day, time] = match;
    const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
    hints.push(time, String(Number(day)));
    hints.push(date.toLocaleString("en-US", { month: "short", timeZone: "UTC" }));
    hints.push(date.toLocaleString("en-US", { month: "long", timeZone: "UTC" }));
  }

  return uniqueStrings(hints.filter((hint) => hint.length >= 2));
}

async function tryClickEventCard(page: Page, event: EventSummary, timeoutMs = 10000): Promise<string | null> {
  const hints = eventTextHints(event);

  return pollPageAction(
    () =>
      page.evaluate(
        ({ eventId, eventHints }) => {
          const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
          const isVisible = (element: Element) => {
            if (!(element instanceof HTMLElement)) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              style.opacity !== "0"
            );
          };
          const clickableAncestor = (element: Element) => {
            let current: Element | null = element;
            while (current && current !== document.body) {
              if (!(current instanceof HTMLElement)) break;
              const tag = current.tagName.toLowerCase();
              const role = current.getAttribute("role");
              const cursor = window.getComputedStyle(current).cursor;
              if (tag === "button" || tag === "a" || role === "button" || cursor === "pointer") {
                return current;
              }
              current = current.parentElement;
            }
            return element;
          };
          const click = (element: Element) => {
            if (!(element instanceof HTMLElement) || !isVisible(element)) return null;
            element.scrollIntoView({ block: "center", inline: "center" });
            element.click();
            return normalize(element.textContent || element.getAttribute("aria-label") || element.getAttribute("href") || "");
          };

          const exactLink = Array.from(document.querySelectorAll("a[href]")).find((link) =>
            link.getAttribute("href")?.includes(eventId),
          );
          const exactLinkResult = exactLink ? click(exactLink) : null;
          if (exactLinkResult) return exactLinkResult;

          const normalizedHints = eventHints.map((hint) => normalize(hint).toLowerCase());
          const candidates = Array.from(
            document.querySelectorAll("a,button,[role='button'],[tabindex],div"),
          )
            .map((element) => clickableAncestor(element))
            .filter((element, index, array) => array.indexOf(element) === index)
            .map((element) => {
              const rect = element.getBoundingClientRect();
              const text = normalize(element.textContent || element.getAttribute("aria-label") || "");
              return { element, text, area: rect.width * rect.height };
            })
            .filter(({ element, text }) => {
              if (!isVisible(element) || text.length < 3 || text.length > 500) return false;
              const lowerText = text.toLowerCase();
              if (/log in|no events/i.test(lowerText)) return false;
              return normalizedHints.some((hint) => lowerText.includes(hint));
            })
            .sort((a, b) => a.area - b.area);

          return candidates[0] ? click(candidates[0].element) : null;
        },
        { eventId: event.id, eventHints: hints },
      ),
    timeoutMs,
  );
}

async function collectBrowserDebug(page: Page): Promise<BrowserJoinDebug> {
  return page.evaluate(() => {
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    const clickables = Array.from(document.querySelectorAll("button,a,[role='button'],[tabindex]"))
      .map((element) =>
        normalize(
          [
            element.textContent || "",
            element.getAttribute("aria-label") || "",
            element.getAttribute("href") || "",
          ].join(" "),
        ),
      )
      .filter(Boolean)
      .slice(0, 40);

    return {
      url: window.location.href,
      title: document.title,
      textPreview: normalize(document.body?.innerText || "").slice(0, 1800),
      clickables,
    };
  });
}

async function waitForLoginResult(page: Page): Promise<string | null> {
  return pollPageAction(
    () =>
      page.evaluate(() => {
        const text = document.body?.innerText || "";
        if (/invalid|incorrect|login error|password/i.test(text) && /error|invalid|incorrect/i.test(text)) {
          return `login-error:${text.replace(/\s+/g, " ").trim().slice(0, 300)}`;
        }
        return text.includes("Log in to join") ? null : "authenticated";
      }),
    20000,
  );
}

async function getJoinStatus(eventId: string, auth: FirebaseAuthResult): Promise<{
  joined: boolean;
  status: "registered" | "reserve" | "not_joined";
}> {
  const product = await getFirestoreDocument(`IProducts/${eventId}`, auth.idToken);
  const users = product.fields?.users?.mapValue?.fields || {};
  const reserves = firestoreStringArray(product.fields?.reserves);
  const status = findFirestoreParticipation(
    Object.keys(users),
    reserves,
    auth.racketUserId,
  );
  return { joined: status !== "not_joined", status };
}

async function getTeamJoinStatus(
  eventId: string,
  leaderUserId: string,
  partnerUserId: string,
): Promise<{
  joined: boolean;
  status: "registered" | "reserve" | "not_joined";
}> {
  const product = await getFirestoreDocument(`IProducts/${eventId}`);
  const users = Object.keys(product.fields?.users?.mapValue?.fields || {});
  const reserves = firestoreStringArray(product.fields?.reserves);
  const leaderStatus = findFirestoreParticipation(users, reserves, leaderUserId);
  const partnerStatus = findFirestoreParticipation(users, reserves, partnerUserId);
  return leaderStatus !== "not_joined" && leaderStatus === partnerStatus
    ? { joined: true, status: leaderStatus }
    : { joined: false, status: "not_joined" };
}

async function waitForJoinStatus(eventId: string, auth: FirebaseAuthResult): Promise<{
  joined: boolean;
  status: "registered" | "reserve" | "not_joined";
}> {
  const result = await pollPageAction(async () => {
    const status = await getJoinStatus(eventId, auth);
    return status.joined ? status : null;
  }, 15000, 1500);

  return result || { joined: false, status: "not_joined" };
}

// Looks up the user's display name from Firebase Auth so we can identify their
// row in the players list (independent of the Firestore document shape).
async function getRacketDisplayName(auth: FirebaseAuthResult): Promise<string | null> {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIRESTORE_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: auth.idToken }),
    },
  );

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as { users?: Array<{ displayName?: string }> };
  return data.users?.[0]?.displayName?.trim() || null;
}

async function verifyJoinInBrowser(
  page: Page,
  names: string[],
  timeoutMs = 0,
): Promise<{
  joined: boolean;
  matchedName: string;
  status: ParticipationStatus;
  region: string;
}> {
  const probe = async () => {
    const body = await page.evaluate(() => document.body?.innerText || "");
    return findParticipationInText(body, names);
  };

  const result = await pollPageAction(
    async () => {
      const current = await probe();
      return current.joined ? current : null;
    },
    timeoutMs,
    1000,
  );

  return result || probe();
}

async function getEventCapacity(page: Page) {
  const body = await page.evaluate(() => document.body?.innerText || "");
  return findCapacityInText(body);
}

function normalizePerson(raw: unknown): Person | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const name = String(record.name ?? "").trim();
  const email = String(record.email ?? "").trim();
  const password = String(record.password ?? "");

  if (!email || !password) return null;

  return {
    id: String(record.id ?? crypto.randomUUID()),
    name,
    email,
    password,
    enabled: record.enabled !== false,
  };
}

async function getRoster(env: Env): Promise<Person[]> {
  const raw = await env.MONITOR_STATE.get(ROSTER_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizePerson).filter((person): person is Person => person !== null);
  } catch {
    return [];
  }
}

async function saveRoster(env: Env, people: Person[]): Promise<void> {
  await env.MONITOR_STATE.put(ROSTER_KEY, JSON.stringify(people));
}

function isValidHM(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

// Default keeps the previous behaviour (all Monday) until the user configures it.
function defaultSchedule(): Schedule {
  const days: Record<string, boolean> = {};
  for (const key of DAY_KEYS) days[key] = key === "mon";
  return { days, startTime: "00:00", endTime: "23:59" };
}

function normalizeSchedule(raw: unknown): Schedule {
  const base = defaultSchedule();
  if (!raw || typeof raw !== "object") return base;
  const record = raw as {
    days?: unknown;
    startTime?: unknown;
    endTime?: unknown;
    pausedUntil?: unknown;
  };

  const days: Record<string, boolean> = {};
  const rawDays = (record.days ?? {}) as Record<string, unknown>;
  for (const key of DAY_KEYS) days[key] = rawDays[key] === true;

  return {
    days,
    startTime: isValidHM(record.startTime) ? record.startTime : base.startTime,
    endTime: isValidHM(record.endTime) ? record.endTime : base.endTime,
    pausedUntil:
      typeof record.pausedUntil === "string" &&
      Number.isFinite(Date.parse(record.pausedUntil))
        ? record.pausedUntil
        : undefined,
  };
}

async function getSchedule(env: Env): Promise<Schedule> {
  const raw = await env.MONITOR_STATE.get(SCHEDULE_KEY);
  if (!raw) return defaultSchedule();
  try {
    return normalizeSchedule(JSON.parse(raw));
  } catch {
    return defaultSchedule();
  }
}

async function saveSchedule(env: Env, schedule: Schedule): Promise<void> {
  await env.MONITOR_STATE.put(SCHEDULE_KEY, JSON.stringify(schedule));
}

// True when the current Lisbon day is enabled and the time is within the window.
// Supports overnight windows (startTime > endTime).
export function isWithinSchedule(schedule: Schedule, date = new Date()): boolean {
  if (schedule.pausedUntil && date.getTime() < Date.parse(schedule.pausedUntil)) {
    return false;
  }
  if (!schedule.days[getLisbonWeekday(date)]) return false;

  const now = getLisbonHM(date);
  const { startTime, endTime } = schedule;

  return startTime <= endTime
    ? now >= startTime && now <= endTime
    : now >= startTime || now <= endTime;
}

export function monitoringWindowKey(
  schedule: Schedule,
  date = new Date(),
): string | null {
  if (!isWithinSchedule(schedule, date)) return null;
  const lisbonDate = getLisbonDateTimeString(date).slice(0, 10);
  return `${lisbonDate}:${schedule.startTime}-${schedule.endTime}`;
}

export function nextMonitorAlarmAt(
  alarmStartedAt: number,
  now = Date.now(),
): number {
  return Math.max(now + 100, alarmStartedAt + MONITOR_POLL_INTERVAL_MS);
}

async function getPeopleToJoin(env: Env): Promise<Person[]> {
  const roster = await getRoster(env);
  // KV array order is the join priority: the first enabled person is joined first.
  return roster.filter(
    (person) => person.enabled && person.email && person.password,
  );
}

export function buildJoinCandidates(
  roster: Person[],
  event: EventSummary,
  group?: MonitoredGroup,
): JoinCandidate[] {
  const enabledPeople = roster.filter(
    (person) => person.enabled && person.email && person.password,
  );
  if (!isDoublesEvent(event)) {
    if (group?.joinSingles === false) return [];
    return enabledPeople.map((person) => ({
      ...person,
      leader: person,
      partner: null,
    }));
  }

  if (!group?.joinDoubles) return [];
  const peopleById = new Map(enabledPeople.map((person) => [person.id, person]));
  return group.doublesTeams
    .filter((team) => team.enabled)
    .map((team): JoinCandidate | null => {
      const leader = peopleById.get(team.leaderId);
      const partner = team.partnerId
        ? peopleById.get(team.partnerId) || null
        : null;
      if (!leader || (team.partnerId && !partner)) return null;
      return {
        ...leader,
        id: `team:${team.id}`,
        name: `${leader.name || leader.email} + ${partner?.name || partner?.email || "Placeholder"}`,
        leader,
        partner,
        doublesTeamId: team.id,
      };
    })
    .filter((candidate): candidate is JoinCandidate => candidate !== null);
}

async function getBrowserRunSnapshot(env: Env) {
  const [limitsResult, sessionsResult, historyResult] = await Promise.allSettled([
    browserLimits(env.BROWSER),
    browserSessions(env.BROWSER),
    browserHistory(env.BROWSER),
  ]);

  const limitsValue =
    limitsResult.status === "fulfilled" ? limitsResult.value : null;
  const activeSessions =
    sessionsResult.status === "fulfilled" ? sessionsResult.value : [];
  const recentRuns =
    historyResult.status === "fulfilled"
      ? [...historyResult.value]
          .sort((a, b) => b.endTime - a.endTime)
          .slice(0, 10)
          .map((run) => ({
            startedAt: new Date(run.startTime).toISOString(),
            endedAt: new Date(run.endTime).toISOString(),
            durationMs: Math.max(0, run.endTime - run.startTime),
            closeReason: run.closeReasonText,
          }))
      : [];
  const errors = [limitsResult, sessionsResult, historyResult]
    .filter((result) => result.status === "rejected")
    .map((result) =>
      result.status === "rejected"
        ? result.reason instanceof Error
          ? result.reason.message
          : String(result.reason)
        : "",
    );

  return {
    ok: errors.length === 0,
    state: !limitsValue
      ? "unknown"
      : limitsValue.allowedBrowserAcquisitions > 0
        ? "available"
        : "limited",
    activeSessionCount: activeSessions.length,
    allowedBrowserAcquisitions:
      limitsValue?.allowedBrowserAcquisitions ?? null,
    maxConcurrentSessions: limitsValue?.maxConcurrentSessions ?? null,
    timeUntilNextAllowedBrowserAcquisition:
      limitsValue?.timeUntilNextAllowedBrowserAcquisition ?? null,
    recentRuns,
    error: errors[0],
  };
}

async function getEventParticipationSnapshot(eventId: string) {
  const product = await getFirestoreDocument(`IProducts/${eventId}`);
  const users = product.fields?.users?.mapValue?.fields || {};
  const reserves = firestoreStringArray(product.fields?.reserves);
  const slots = Math.max(0, Number(product.fields?.slots?.integerValue || 0));
  return {
    registeredIds: Object.keys(users),
    reserveIds: reserves,
    registeredCount: Object.keys(users).length,
    reserveCount: reserves.length,
    slots,
  };
}

async function getApplicationStatus(env: Env, log: OperationalLogger) {
  const checkedAt = new Date();
  const [schedule, roster, configuredGroups, browser, scheduler] = await Promise.all([
    getSchedule(env),
    getRoster(env),
    getMonitoredGroups(env),
    getBrowserRunSnapshot(env),
    getMonitorSchedulerState(env),
  ]);
  const enabledGroups = configuredGroups.filter((group) => group.enabled);
  const checks = await Promise.all(
    enabledGroups.map(async (group) => {
      try {
        return await checkGroupEvents(group.id, group, env);
      } catch (error) {
        return {
          checkedAt: checkedAt.toISOString(),
          ok: false,
          groupId: group.id,
          groupUrl: groupUrl(group.id),
          hasEvents: false,
          emptyStateTextFound: false,
          source: "firestore" as const,
          events: [],
          visibleTextPreview: "Firestore group check failed.",
          error: error instanceof Error ? error.message : String(error),
        } satisfies CheckResult;
      }
    }),
  );

  const joinableEvents = checks
    .map((check, index) => pickJoinableEvent(check.events, enabledGroups[index]))
    .filter((event): event is EventSummary => Boolean(event));
  const enabledPeople = roster.filter(
    (person) => person.enabled && person.email && person.password,
  );
  const authByPerson = new Map<
    string,
    { racketUserId?: string; error?: string }
  >();

  if (joinableEvents.length) {
    await Promise.all(
      enabledPeople.map(async (person) => {
        try {
          const auth = await signInToRacket(person.email, person.password);
          authByPerson.set(person.id, { racketUserId: auth.racketUserId });
        } catch (error) {
          authByPerson.set(person.id, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }

  const groups = await Promise.all(
    checks.map(async (check, index) => {
      const groupConfig = enabledGroups[index];
      const event = pickJoinableEvent(check.events, groupConfig);
      const [activeEventIds, participation, joinState] = await Promise.all([
        getActiveJoinEventIds(env, check.groupId),
        event
          ? getEventParticipationSnapshot(event.id).catch(() => null)
          : Promise.resolve(null),
        event
          ? new JoinCoordinatorClient(env.JOIN_COORDINATOR.getByName(event.id))
            .getState().catch(() => null)
          : Promise.resolve(null),
      ]);
      const statusPeople = event && isDoublesEvent(event)
        ? buildJoinCandidates(roster, event, groupConfig)
        : roster.map((person) => ({ ...person, leader: person, partner: null }));
      const players = statusPeople.map((person) => {
        if (!person.enabled) {
          return { id: person.id, name: person.name, status: "disabled" };
        }
        if (!event) {
          return { id: person.id, name: person.name, status: "no_event" };
        }
        const auth = authByPerson.get(person.leader.id);
        if (!auth?.racketUserId) {
          return {
            id: person.id,
            name: person.name,
            status: "error",
            error: auth?.error || "Racket authentication failed.",
          };
        }
        if (!participation) {
          return {
            id: person.id,
            name: person.name,
            status: "error",
            error: "Could not read event participation.",
          };
        }
        return {
          id: person.id,
          name: person.name,
          status: findFirestoreParticipation(
            participation.registeredIds,
            participation.reserveIds,
            auth.racketUserId,
          ),
        };
      });

      return {
        groupId: check.groupId,
        groupUrl: check.groupUrl,
        ok: check.ok,
        error: check.error,
        upcomingEventCount: check.events.length,
        activeEventId: activeEventIds[0] || null,
        activeEventIds,
        minParticipants: normalizeMinParticipants(groupConfig.minParticipants),
        hasStartedAutoJoin: Boolean(joinState && (joinState.running || joinState.done ||
          joinState.joinedIds.length || Object.values(joinState.attemptsByPerson).some((n) => n > 0))),
        event: event
          ? {
              ...event,
              registeredCount: participation?.registeredCount ?? null,
              reserveCount: participation?.reserveCount ?? null,
              slots: participation?.slots ?? null,
            }
          : null,
        players,
      };
    }),
  );

  const activeNow = isWithinSchedule(schedule, checkedAt);
  const paused = Boolean(
    schedule.pausedUntil &&
      checkedAt.getTime() < Date.parse(schedule.pausedUntil),
  );
  const anyDaysEnabled = DAY_KEYS.some((day) => schedule.days[day]);
  const monitorState = paused
    ? "paused"
    : !anyDaysEnabled || !enabledGroups.length
      ? "disabled"
      : activeNow
        ? "active"
        : "outside_schedule";

  const result = {
    checkedAt: checkedAt.toISOString(),
    lisbonTime: getLisbonDateTimeString(checkedAt),
    monitor: {
      state: monitorState,
      activeNow,
      schedule,
      scheduler,
      configuredGroupCount: configuredGroups.length,
      enabledGroupCount: enabledGroups.length,
      enabledPlayerCount: enabledPeople.length,
      liveChecksOk: groups.every((group) => group.ok),
    },
    browser,
    groups,
  };

  log("status_snapshot", {
    monitorState,
    enabledGroupCount: enabledGroups.length,
    liveChecksOk: result.monitor.liveChecksOk,
    eventCount: groups.filter((group) => group.event).length,
    browserState: browser.state,
  });
  return result;
}

interface PersonJoinResult {
  id: string;
  name: string;
  email: string;
  ok: boolean;
  reason?: string;
  verified?: boolean;
  verifiedVia?: string;
  alreadyJoined?: boolean;
  status?: ParticipationStatus;
  playersList?: string;
}

// Logs in as a single person in an isolated browser context and joins the event.
// Each person gets a fresh context so Firebase auth (stored in IndexedDB, not
// cookies) does not leak between accounts.
async function joinEventForPerson(
  browser: Browser,
  event: EventSummary,
  person: Person,
  groupUrl: string,
  env: Env,
  debugChatId: string | null,
  heartbeat: () => Promise<void>,
  auth: FirebaseAuthResult | null,
  log: OperationalLogger,
): Promise<PersonJoinResult> {
  const baseDetails = {
    groupId: normalizeMonitoredGroupId(groupUrl) || groupUrl,
    eventId: event.id,
    personId: person.id,
    name: person.name,
  };
  const browserLog = (
    action: string,
    details: Record<string, unknown> = {},
    level: OperationLogLevel = "info",
  ) => log(action, { ...baseDetails, ...details }, level);
  const contextStartedAt = Date.now();
  const context = await browser.createBrowserContext();
  browserLog("browser_context_created", {
    durationMs: Date.now() - contextStartedAt,
  });
  let page: Page | undefined;

  const debugShot = async (label: string) => {
    if (!debugChatId || !env.TELEGRAM_BOT_TOKEN || !page) return;
    try {
      const image = (await page.screenshot({ type: "png" })) as Uint8Array;
      await sendTelegramPhoto(env, debugChatId, image, `[${person.name || person.email}] ${label}\n${page.url()}`);
    } catch (error) {
      console.error("Debug screenshot failed:", error);
    }
  };

  const fail = async (reason: string): Promise<PersonJoinResult> => {
    browserLog("browser_step_failed", { reason }, "warn");
    await debugShot(`Ошибка: ${reason}`);
    return { id: person.id, name: person.name, email: person.email, ok: false, reason };
  };

  try {
    const pageStartedAt = Date.now();
    page = await context.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    browserLog("browser_page_created", {
      durationMs: Date.now() - pageStartedAt,
    });
    const navigationStartedAt = Date.now();
    browserLog("browser_navigation_started");
    await page.goto(groupUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    browserLog("browser_navigation_finished", {
      durationMs: Date.now() - navigationStartedAt,
      pageUrl: page.url(),
    });
    await heartbeat();

    const loginButtonStartedAt = Date.now();
    const loginButton = await tryClickByText(page, [{ text: "Log in to join", exact: true }], 15000);
    if (!loginButton) {
      return await fail("Не нашёл кнопку «Log in to join».");
    }
    browserLog("browser_login_button_clicked", {
      durationMs: Date.now() - loginButtonStartedAt,
    });

    const formStartedAt = Date.now();
    await fillLoginForm(page, person.email.trim(), person.password.trim());
    browserLog("browser_login_form_filled", {
      durationMs: Date.now() - formStartedAt,
    });
    await debugShot("1/5 Заполнил форму логина");

    const submitStartedAt = Date.now();
    const loginSubmit = await tryClickByText(page, [{ text: "Log in", exact: true }], 15000, true);
    if (!loginSubmit) {
      return await fail("Не нашёл кнопку отправки логина.");
    }
    browserLog("browser_login_submitted", {
      durationMs: Date.now() - submitStartedAt,
    });

    const loginStartedAt = Date.now();
    const loginResult = await waitForLoginResult(page);
    if (!loginResult || loginResult.startsWith("login-error:")) {
      return await fail(loginResult || "Логин не завершился в браузере.");
    }
    browserLog("browser_login_finished", {
      result: loginResult,
      durationMs: Date.now() - loginStartedAt,
    });

    await heartbeat();
    await sleep(1500);
    await debugShot("2/5 Залогинился");

    const eventClickStartedAt = Date.now();
    const eventClicked = await tryClickEventCard(page, event, 12000);
    if (!eventClicked) {
      return await fail("Не нашёл карточку ивента.");
    }
    browserLog("browser_event_opened", {
      eventTitle: event.title,
      durationMs: Date.now() - eventClickStartedAt,
    });

    await heartbeat();
    await sleep(1500);
    await debugShot("3/5 Открыл ивент");

    const names = uniqueStrings([person.name]);

    // Pre-check: if already in the players list, do not click Join again. This
    // keeps retries idempotent and handles events that hide "Join" once joined.
    const browserPrecheckStartedAt = Date.now();
    const preCheck = await verifyJoinInBrowser(page, names);
    browserLog("browser_participation_precheck", {
      joined: preCheck.joined,
      status: preCheck.status,
      durationMs: Date.now() - browserPrecheckStartedAt,
    });
    if (preCheck.joined) {
      await debugShot(`уже записан: ${person.name}`);
      return {
        id: person.id,
        name: person.name,
        email: person.email,
        ok: true,
        verified: true,
        verifiedVia: `browser:${preCheck.matchedName}`,
        alreadyJoined: true,
        status: preCheck.status,
        playersList: preCheck.region,
      };
    }

    const joinCandidates: TextClickCandidate[] = [
      { text: "Join", exact: true },
      { text: "Join event" },
      { text: "Join game" },
      { text: "Join activity" },
      { text: "Join reserve" },
      { text: "Join waitlist" },
    ];
    const joinButtonStartedAt = Date.now();
    let joinClicked = await tryClickByText(page, joinCandidates, 1200);
    if (!joinClicked) {
      const capacityStartedAt = Date.now();
      const capacity = await getEventCapacity(page);
      browserLog("browser_capacity_checked", {
        current: capacity.current,
        capacity: capacity.capacity,
        full: capacity.full,
        durationMs: Date.now() - capacityStartedAt,
      });
      if (capacity.full) {
        return await fail(
          `Ивент заполнен (${capacity.current}/${capacity.capacity}), а кнопки записи в резерв нет.`,
        );
      }
      joinClicked = await tryClickByText(page, joinCandidates, 13800);
    }

    if (!joinClicked) {
      return await fail("Не нашёл кнопку «Join».");
    }
    browserLog("browser_join_clicked", {
      durationMs: Date.now() - joinButtonStartedAt,
    });

    await sleep(1500);
    await debugShot("4/5 Нажал Join, открылся Registration Checkout");

    // The Registration Checkout modal confirms with its own "Join" button (last match in the DOM).
    const confirmationStartedAt = Date.now();
    const confirmClicked = await tryClickByText(
      page,
      [
        { text: "Join", exact: true },
        { text: "Confirm", exact: true },
        { text: "OK", exact: true },
        { text: "Done", exact: true },
      ],
      8000,
      true,
    );
    if (!confirmClicked) {
      console.warn(
        `Checkout confirmation was not found for ${person.name || person.email}; verifying actual status.`,
      );
    }
    browserLog("browser_checkout_confirmation", {
      found: confirmClicked,
      durationMs: Date.now() - confirmationStartedAt,
    }, confirmClicked ? "info" : "warn");
    await heartbeat();
    await sleep(1500);
    const finalVerificationStartedAt = Date.now();
    const firestoreCheck = auth
      ? await waitForJoinStatus(event.id, auth).catch((error) => {
          console.warn(
            `Firestore join verification failed for ${person.name || person.email}:`,
            error,
          );
          return null;
        })
      : null;
    const browserCheck = firestoreCheck?.joined
      ? null
      : await verifyJoinInBrowser(page, names, 10000);
    const joined = firestoreCheck?.joined === true || browserCheck?.joined === true;
    const status =
      firestoreCheck?.joined
        ? firestoreCheck.status
        : browserCheck?.status || "not_joined";
    const matchedName = browserCheck?.matchedName || person.name;
    const playersList = browserCheck?.region || "";
    browserLog("browser_final_verification", {
      joined,
      status,
      verifiedVia: firestoreCheck?.joined
        ? `firestore:${firestoreCheck.status}`
        : joined ? `browser:${matchedName}` : "none",
      durationMs: Date.now() - finalVerificationStartedAt,
    }, joined ? "info" : "warn");

    await debugShot(
      joined
        ? `5/5 Готово: ${person.name} (${status})`
        : "5/5 Checkout закрылся, но имя не найдено в списке игроков",
    );

    return {
      id: person.id,
      name: person.name,
      email: person.email,
      ok: joined,
      reason: joined ? undefined : "Имя не найдено среди игроков или резерва после Join.",
      verified: joined,
      verifiedVia: firestoreCheck?.joined
        ? `firestore:${firestoreCheck.status}`
        : joined
          ? `browser:${matchedName}`
          : "none",
      status,
      playersList,
    };
  } finally {
    const closeStartedAt = Date.now();
    await page?.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    browserLog("browser_context_closed", {
      durationMs: Date.now() - closeStartedAt,
    });
  }
}

// Orchestrates joining people onto the first joinable event. The Durable Object
// serializes all cron/manual calls for the event and checkpoints each person.
async function joinFirstAvailableEvent(
  groupId: string,
  groupUrl: string,
  env: Env,
  debug = false,
  resetState = false,
  log: OperationalLogger = consoleOperationalLog,
  selectedEvent?: EventSummary,
  groupConfig?: MonitoredGroup,
) {
  const events = selectedEvent ? [selectedEvent] : await queryGroupEvents(groupId, 10);
  const event = selectedEvent || pickJoinableEvent(events, groupConfig);

  if (!event) {
    return {
      ok: false,
      reason: events.length
        ? "No event is enabled for auto-registration in this group."
        : "No upcoming events found.",
      event: undefined as EventSummary | undefined,
      results: [] as PersonJoinResult[],
    };
  }

  const roster = await getRoster(env);
  const people = buildJoinCandidates(roster, event, groupConfig);
  if (!people.length) {
    return {
      ok: false,
      reason: isDoublesEvent(event)
        ? "No valid enabled doubles teams are configured for this group."
        : "No enabled players in the roster.",
      event,
      results: [] as PersonJoinResult[],
    };
  }

  const coordinatorId = env.JOIN_COORDINATOR.idFromName(event.id);
  const coordinator = new JoinCoordinatorClient(env.JOIN_COORDINATOR.get(coordinatorId));
  if (resetState) {
    await coordinator.reset();
  }
  let browser: Browser | undefined;
  let debugChatId: string | null = null;
  const batchStartedAt = Date.now();

  const batch: CoordinatedBatchResult<PersonJoinResult> = await runCoordinatedBatch({
    coordinator,
    people,
    maxAttempts: MAX_JOIN_ATTEMPTS,
    beforeBatch: async () => {
      if (!env.BROWSER) {
        throw new Error("BROWSER binding is not configured.");
      }
      debugChatId = debug ? await env.MONITOR_STATE.get(TELEGRAM_CHAT_ID_KEY) : null;
    },
    joinPerson: async (person, heartbeat) => {
      const personStartedAt = Date.now();
      log("join_person_started", {
        groupId,
        eventId: event.id,
        personId: person.id,
        name: person.name,
      });
      let auth: FirebaseAuthResult | null = null;
      let fallbackReason = "API path did not complete.";
      let apiPhase = "authentication";
      try {
        const authStartedAt = Date.now();
        log("racket_auth_started", {
          groupId,
          eventId: event.id,
          personId: person.id,
          name: person.name,
        });
        auth = await signInToRacket(person.email, person.password);
        log("racket_auth_finished", {
          groupId,
          eventId: event.id,
          personId: person.id,
          name: person.name,
          durationMs: Date.now() - authStartedAt,
        });

        apiPhase = "participation_precheck";
        const precheckStartedAt = Date.now();
        log("participation_precheck_started", {
          groupId,
          eventId: event.id,
          personId: person.id,
          name: person.name,
        });
        const status = await getJoinStatus(event.id, auth);
        log("participation_precheck_finished", {
          groupId,
          eventId: event.id,
          personId: person.id,
          name: person.name,
          joined: status.joined,
          status: status.status,
          durationMs: Date.now() - precheckStartedAt,
        });
        if (status.joined) {
          const result: PersonJoinResult = {
            id: person.id,
            name: person.name,
            email: person.email,
            ok: true,
            verified: true,
            verifiedVia: `firestore:${status.status}`,
            alreadyJoined: true,
            status: status.status,
          };
          log("join_person_finished", {
            groupId,
            eventId: event.id,
            personId: person.id,
            name: person.name,
            route: "firestore_precheck",
            status: result.status,
            alreadyJoined: true,
            durationMs: Date.now() - personStartedAt,
          });
          return result;
        }

        apiPhase = "firestore_join";
        let partnerAuth: FirebaseAuthResult | null = null;
        if (isDoublesEvent(event) && person.partner) {
          const partnerAuthStartedAt = Date.now();
          log("racket_partner_auth_started", {
            groupId,
            eventId: event.id,
            teamId: person.doublesTeamId,
            partnerId: person.partner.id,
            partnerName: person.partner.name,
          });
          partnerAuth = await signInToRacket(
            person.partner.email,
            person.partner.password,
          );
          log("racket_partner_auth_finished", {
            groupId,
            eventId: event.id,
            teamId: person.doublesTeamId,
            partnerId: person.partner.id,
            partnerName: person.partner.name,
            durationMs: Date.now() - partnerAuthStartedAt,
          });
        }

        const joinDate = getLisbonDateTimeString();
        const apiJoin = isDoublesEvent(event)
          ? await joinTeamEventViaApi(
              event.id,
              auth,
              partnerAuth?.racketUserId || null,
              joinDate,
              (attempt) => log(
                "firestore_team_join_attempt",
                {
                  groupId,
                  eventId: event.id,
                  teamId: person.doublesTeamId,
                  personId: person.id,
                  name: person.name,
                  partnerMode: person.partner ? "player" : "placeholder",
                  ...attempt,
                  reason: attempt.reason?.slice(0, 500),
                },
                attempt.outcome === "write_succeeded" ||
                    attempt.outcome === "already_joined" ||
                    attempt.outcome === "placeholder_created"
                  ? "info"
                  : "warn",
              ),
            )
          : await joinEventViaApi(
              event.id,
              auth,
              joinDate,
          (attempt) => log(
            "firestore_join_attempt",
            {
              groupId,
              eventId: event.id,
              personId: person.id,
              name: person.name,
              ...attempt,
              reason: attempt.reason?.slice(0, 500),
            },
            attempt.outcome === "write_succeeded" || attempt.outcome === "already_joined"
              ? "info"
              : "warn",
          ),
            );
        if (apiJoin.ok) {
          apiPhase = "participation_verification";
          const verificationStartedAt = Date.now();
          log("participation_verification_started", {
            groupId,
            eventId: event.id,
            personId: person.id,
            name: person.name,
          });
          const verified = isDoublesEvent(event) && apiJoin.partnerUserId
            ? await getTeamJoinStatus(
                event.id,
                auth.racketUserId,
                apiJoin.partnerUserId,
              )
            : await getJoinStatus(event.id, auth);
          log("participation_verification_finished", {
            groupId,
            eventId: event.id,
            personId: person.id,
            name: person.name,
            joined: verified.joined,
            status: verified.status,
            durationMs: Date.now() - verificationStartedAt,
          }, verified.joined ? "info" : "warn");
          if (verified.joined) {
            const result: PersonJoinResult = {
              id: person.id,
              name: person.name,
              email: person.email,
              ok: true,
              verified: true,
              verifiedVia: `api:${verified.status}`,
              alreadyJoined: apiJoin.alreadyJoined,
              status: verified.status,
            };
            log("join_person_finished", {
              groupId,
              eventId: event.id,
              personId: person.id,
              name: person.name,
              route: "firestore_api",
              status: result.status,
              alreadyJoined: result.alreadyJoined,
              verificationDurationMs: Date.now() - verificationStartedAt,
              durationMs: Date.now() - personStartedAt,
            });
            return result;
          }
          fallbackReason = "Firestore PATCH succeeded, but participation verification returned not_joined.";
          console.warn(
            `Racket API join was not visible after write for ${person.name || person.email}; falling back to browser.`,
          );
        } else {
          fallbackReason = apiJoin.reason || "Firestore API returned an unknown failure.";
          console.warn(
            `Racket API join unavailable for ${person.name || person.email}: ${apiJoin.reason || "unknown error"}; falling back to browser.`,
          );
        }

        if (isDoublesEvent(event)) {
          const result: PersonJoinResult = {
            id: person.id,
            name: person.name,
            email: person.email,
            ok: false,
            reason: fallbackReason,
            verified: false,
            verifiedVia: "none",
            status: "not_joined",
          };
          log("join_person_finished", {
            groupId,
            eventId: event.id,
            teamId: person.doublesTeamId,
            personId: person.id,
            name: person.name,
            route: "firestore_team_api",
            ok: false,
            reason: fallbackReason.slice(0, 500),
            durationMs: Date.now() - personStartedAt,
          }, "warn");
          return result;
        }
      } catch (error) {
        fallbackReason = error instanceof Error ? error.message : String(error);
        log("api_path_failed", {
          groupId,
          eventId: event.id,
          personId: person.id,
          name: person.name,
          phase: apiPhase,
          durationMs: Date.now() - personStartedAt,
          error: fallbackReason.slice(0, 500),
        }, "warn");
        console.warn(
          `Racket API join failed for ${person.name || person.email}; falling back to browser:`,
          error,
        );
        if (isDoublesEvent(event)) {
          return {
            id: person.id,
            name: person.name,
            email: person.email,
            ok: false,
            reason: fallbackReason,
            verified: false,
            verifiedVia: "none",
            status: "not_joined",
          };
        }
      }

      await heartbeat();
      const reusedBrowser = Boolean(browser);
      log("browser_fallback_started", {
        groupId,
        eventId: event.id,
        personId: person.id,
        name: person.name,
        reusedBrowser,
        reason: fallbackReason.slice(0, 500),
        apiPathDurationMs: Date.now() - personStartedAt,
      }, "warn");
      if (!browser) {
        const acquisitionStartedAt = Date.now();
        try {
          browser = await launch(env.BROWSER, { keep_alive: 60000 });
          log("browser_acquired", {
            groupId,
            eventId: event.id,
            personId: person.id,
            name: person.name,
            durationMs: Date.now() - acquisitionStartedAt,
          });
        } catch (error) {
          log("browser_acquisition_failed", {
            groupId,
            eventId: event.id,
            personId: person.id,
            name: person.name,
            durationMs: Date.now() - acquisitionStartedAt,
            error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          }, "error");
          throw error;
        }
      }
      const result = await joinEventForPerson(
        browser,
        event,
        person,
        groupUrl,
        env,
        debugChatId,
        heartbeat,
        auth,
        log,
      );
      log("join_person_finished", {
        groupId,
        eventId: event.id,
        personId: person.id,
        name: person.name,
        route: "browser",
        reusedBrowser,
        ok: result.ok,
        status: result.status,
        verifiedVia: result.verifiedVia,
        reason: result.reason?.slice(0, 500),
        durationMs: Date.now() - personStartedAt,
      }, result.ok ? "info" : "warn");
      return result;
    },
    personError: (person, error) => ({
      id: person.id,
      name: person.name,
      email: person.email,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }),
    afterBatch: async () => {
      await browser?.close().catch(() => undefined);
      browser = undefined;
    },
  });

  const joinedIds =
    batch.state?.joinedIds ||
    ("joinedIds" in batch.begin ? batch.begin.joinedIds : []);
  const failed = batch.results.filter((result) => !result.ok);
  const joinedCount = people.filter((person) => joinedIds.includes(person.id)).length;
  const exhaustedIds =
    batch.begin.status === "exhausted" ? batch.begin.exhaustedIds : [];
  const reason =
    batch.status === "busy"
      ? "Join is already running for this event."
      : batch.status === "exhausted"
        ? `Достигнут лимит попыток: ${people
            .filter((person) => exhaustedIds.includes(person.id))
            .map((person) => person.name || person.email)
            .join(", ")}.`
        : batch.error ||
          (failed.length
            ? `Не записаны: ${failed
                .map((result) => `${result.name || result.email} (${result.reason || "?"})`)
                .join("; ")}`
            : undefined);

  log(
    "join_batch_finished",
    {
      groupId,
      eventId: event.id,
      coordinatorStatus: batch.status,
      completedNow: batch.completedNow,
      joinedCount,
      totalCount: people.length,
      durationMs: Date.now() - batchStartedAt,
      results: batch.results.map((result) => ({
        personId: result.id,
        name: result.name,
        ok: result.ok,
        status: result.status,
        verifiedVia: result.verifiedVia,
        reason: result.reason,
      })),
      error: batch.error,
    },
    failed.length || batch.error ? "warn" : "info",
  );

  return {
    ok: batch.status === "complete" || batch.state?.done === true,
    skipped: batch.status === "busy" || batch.status === "complete",
    completedNow: batch.completedNow,
    coordinatorStatus: batch.status,
    reason,
    groupUrl,
    event,
    joinedAt: batch.completedNow ? getLisbonDateTimeString() : undefined,
    joinedCount,
    totalCount: people.length,
    results: batch.results,
    coordinatorState: batch.state,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

function renderHomePage(env: Env): Response {
  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Racket Events Monitor</title>
<style>
  :root {
    color-scheme: light;
    --card: #fdf6f3; --ink: #34303b; --muted: #a2909c;
    --border: #f3e4e9; --field: #fbf1f2; --accent: #cf6fa8; --accent-soft: #fae7f0;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1rem;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(150deg, #f9dbe1 0%, #f4d2e2 45%, #e6cef2 100%);
    background-attachment: fixed; color: var(--ink);
    display: flex; justify-content: center;
  }
  main { width: 100%; max-width: 760px; background: var(--card); border: 1px solid rgba(255,255,255,.6); border-radius: 24px; padding: 2rem 2rem 2.4rem; box-shadow: 0 18px 50px rgba(190, 120, 170, .22); }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 .6rem; border-bottom: 1px solid var(--border); padding-bottom: .3rem; }
  .sub { color: var(--muted); margin: 0 0 1.5rem; }
  a { color: var(--accent); }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  code { background: var(--accent-soft); color: #b6478f; padding: .1rem .35rem; border-radius: 5px; font-size: .88em; }
  pre { background: var(--field); padding: .8rem 1rem; border-radius: 11px; overflow-x: auto; border: 1px solid var(--border); }
  table { width: 100%; border-collapse: collapse; margin-top: .4rem; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  .tag { display: inline-block; padding: .05rem .5rem; border-radius: 999px; font-size: .75rem; background: var(--accent-soft); color: #b6478f; margin-left: .4rem; }
  ul { padding-left: 1.2rem; } li { margin: .2rem 0; }
  .note { background: var(--accent-soft); border: 1px solid #f2d3e6; border-radius: 11px; padding: .7rem 1rem; margin-top: .8rem; font-size: .9rem; }
  .foot { margin-top: 2.5rem; color: var(--muted); font-size: .82rem; }
</style>
</head>
<body>
<main>
  <h1>🎾 Racket Events Monitor</h1>
  <p class="sub">Cloudflare Worker: следит за выбранными группами в Racket, по заданному расписанию записывает игроков на появившиеся ивенты и сообщает результат в Telegram.</p>

  <h2>Что происходит</h2>
  <ul>
    <li>Крон срабатывает <strong>каждую минуту</strong>, но работает только в <strong>окне расписания</strong> (дни и время задаются на <a href="/players">/players</a>). Ни один день не отмечен — скрипт не запускается.</li>
    <li>Каждый запуск в окне — дешёвая проверка выбранных групп через <strong>Firestore</strong> (без браузера).</li>
    <li>Как только появляется ивент — воркер авторизуется в Racket и <strong>записывает включённых игроков</strong> напрямую через Firestore API.</li>
    <li>Запись подтверждается по имени в списке игроков на самой странице ивента.</li>
    <li>Один Durable Object на событие не допускает параллельных запусков. После каждого успешного игрока его id сохраняется немедленно; повторы трогают только оставшихся. Лимит — ${MAX_JOIN_ATTEMPTS} попыток на человека.</li>
    <li>Browser Run остаётся только запасным вариантом для платных, клубных и нестандартных регистраций.</li>
    <li>Результаты приходят в Telegram-бот. Пошаговые скриншоты включены для ручных тестов и опциональны для cron.</li>
  </ul>

  <h2>Эндпоинты</h2>
  <table>
    <tr><th>Путь</th><th>Что делает</th></tr>
    <tr><td><code>/players</code> <span class="tag">secret</span></td><td>Страница управления игроками, приоритетом, группами мониторинга и расписанием. Оттуда же — тест на тестовой группе.</td></tr>
    <tr><td><code>/check</code></td><td>Ручная проверка событий через Firestore. Возвращает JSON, браузер не запускает.</td></tr>
    <tr><td><code>/join</code> <span class="tag">secret</span></td><td>Записать всех включённых игроков на первый ивент первой настроенной группы. Конкретную группу можно выбрать через <code>?group=ID</code>.</td></tr>
    <tr><td><code>/join-test</code> <span class="tag">secret</span></td><td>То же, но в <strong>тестовой</strong> группе.</td></tr>
    <tr><td><code>/join-state?event=...</code> <span class="tag">secret</span></td><td>Показать сохранённое состояние записи конкретного события: блокировку, игроков и попытки.</td></tr>
    <tr><td><code>/logs</code> <span class="tag">secret</span></td><td>Последние диагностические шаги, сгруппированные по запускам. Хранятся в Durable Object, а не в KV.</td></tr>
    <tr><td><code>/telegram</code></td><td>Webhook бота. Любое сообщение боту сохраняет твой chat_id для уведомлений.</td></tr>
  </table>
  <p class="sub" style="margin-top:.8rem"><span class="tag">secret</span> — нужен <code>JOIN_SECRET</code>: передай как <code>?secret=...</code> или заголовок <code>x-join-secret</code>.</p>

  <h2>Команды</h2>
<pre>npm run dev         # локально (работает только /check — браузер не доступен локально)
npm run deploy      # выкатить в Cloudflare
npm run typecheck   # проверка типов</pre>

  <h2>Секреты (Cloudflare)</h2>
<pre>npx wrangler secret put JOIN_SECRET           # защита /join и /join-test
npx wrangler secret put TELEGRAM_BOT_TOKEN    # токен бота
npx wrangler secret list                      # посмотреть список</pre>

  <h2>Как проверить запись вручную</h2>
<pre>curl "https://&lt;этот-домен&gt;/join?secret=&lt;JOIN_SECRET&gt;"</pre>
  <p class="sub" style="margin-top:.6rem">Внимание: это <strong>реально записывает</strong> на ближайший ивент, если он есть. В ответе смотри <code>ok</code>, <code>verifiedVia</code>, <code>playersList</code>.</p>

  <h2>Настройки</h2>
  <table>
    <tr><th>Группы</th><td>ID и флаг «Мониторить» задаются на <a href="/players">/players</a> и хранятся в KV. Выключенные группы остаются в списке, но cron их пропускает.</td></tr>
    <tr><td>Крон</td><td><code>* * * * *</code> (каждую минуту; окно дней/времени задаётся на <a href="/players">/players</a>, часовой пояс Europe/Lisbon)</td></tr>
    <tr><td>KV-ключи</td><td><code>telegram_chat_id</code>, <code>last_has_events:ID</code>, <code>active_join_event:ID</code>, <code>roster</code>, <code>schedule</code>, <code>monitored_groups</code></td></tr>
    <tr><td>Join state</td><td>Strongly consistent Durable Object, отдельный экземпляр для каждого <code>eventId</code>.</td></tr>
  </table>

  <h2>Как это устроено</h2>
  <p class="sub" style="margin:.2rem 0 .6rem">Крон срабатывает каждую минуту, но почти всегда мгновенно выходит — тяжёлая работа только в окне расписания и только когда есть ивент.</p>
<pre>каждую минуту:
  читаем расписание            // 1 чтение KV
  окно расписания сейчас?
    нет → выходим              // мгновенно, дёшево
    да  → читаем список групп
          проверяем каждую в Firestore    // без браузера
          появился ивент → записываем включённых игроков</pre>
  <ul>
    <li>Вне окна расписания тик — это одно чтение KV и выход.</li>
    <li>Внутри окна — запросы в Firestore; обычная запись также выполняется через API без Browser Run.</li>
    <li>Как только событие обрабатывает один Worker, остальные cron получают <code>busy</code> и выходят. Каждый успех сохраняется до перехода к следующему игроку.</li>
  </ul>

  <h2>Упрётся ли в лимиты</h2>
  <table>
    <tr><th>Ресурс</th><th>Нагрузка</th><th>Почему ок</th></tr>
    <tr><td>Вызовы воркера</td><td>1440/сутки ≈ 44k/мес</td><td>доли процента от включённых 10M (Paid)</td></tr>
    <tr><td>CPU на вызов</td><td>суб-мс вне окна</td><td>работа — I/O-ожидание (KV/Firestore/браузер), не CPU; лимит 30 c</td></tr>
    <tr><td>KV</td><td>~1440 чтений/сутки</td><td>записи редкие (настройки, смена состояния); глубоко в лимитах</td></tr>
    <tr><td>Firestore</td><td>по одному запросу на группу за тик в окне</td><td>нагрузка линейно зависит от числа настроенных групп</td></tr>
    <tr><td>Browser Run</td><td>обычно 0 запусков</td><td>только fallback для неподдерживаемой API-регистрации</td></tr>
  </table>
  <div class="note">Durable Object использует возобновляемую блокировку. Если Worker аварийно завершится, сохранённые игроки останутся в storage, а после истечения lease следующий cron продолжит только с оставшихся.</div>

  <p class="foot">Подробности — в <code>README.md</code>. Скриншоты автозаписи можно выключить в <code>src/index.ts</code> (флаг <code>debug</code> у вызова <code>joinFirstAvailableEvent</code> в автозаписи).</p>
</main>
</body>
</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function renderRosterPage(
  roster: Person[],
  schedule: Schedule,
  groups: MonitoredGroup[],
  secret: string,
): Response {
  // Embed as JSON literals; escape "<" so a value can't break out of <script>.
  const embed = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Игроки — Racket Monitor</title>
<style>
  :root {
    color-scheme: light;
    --card: #fdf6f3; --ink: #34303b; --muted: #a2909c;
    --border: #f3e4e9; --field: #fbf1f2; --field-border: #f0dde3;
    --accent: #cf6fa8; --accent-soft: #fae7f0;
    --grad: linear-gradient(135deg, #f2946f 0%, #c56fce 100%);
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2.5rem 1rem; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: linear-gradient(150deg, #f9dbe1 0%, #f4d2e2 45%, #e6cef2 100%); background-attachment: fixed; color: var(--ink); display: flex; justify-content: center; }
  main { width: 100%; min-width: 0; max-width: 860px; background: var(--card); border: 1px solid rgba(255,255,255,.6); border-radius: 24px; padding: 2rem 2rem 2.4rem; box-shadow: 0 18px 50px rgba(190, 120, 170, .22); }
  h1 { font-size: 1.5rem; margin: 0 0 .2rem; }
  .sub { color: var(--muted); margin: 0 0 1.4rem; }
  a { color: var(--accent); }
  .table-scroll { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; margin-top: .5rem; }
  th, td { padding: .5rem .5rem; border-bottom: 1px solid var(--border); text-align: left; }
  th { color: var(--muted); font-weight: 600; font-size: .82rem; }
  input[type=text], input[type=email], input[type=password], select { width: 100%; background: var(--field); border: 1px solid var(--field-border); color: var(--ink); border-radius: 9px; padding: .45rem .55rem; font: inherit; }
  input[type=text]:focus, input[type=email]:focus, input[type=password]:focus, input[type=time]:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(207, 111, 168, .18); }
  input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--accent); }
  .col-priority { width: 104px; text-align: center; white-space: nowrap; }
  .col-enabled { width: 60px; text-align: center; }
  .col-remove { width: 40px; text-align: center; }
  button { font: inherit; font-weight: 600; border: 0; border-radius: 11px; padding: .55rem 1.1rem; cursor: pointer; transition: filter .15s, box-shadow .15s; }
  button:hover { filter: brightness(1.03); }
  .btn-add { background: var(--accent-soft); color: #b6478f; margin-top: 1rem; }
  .group-list { display: grid; gap: .8rem; margin-top: .7rem; }
  .group-row { display: grid; grid-template-columns: minmax(0, 1fr) auto 36px 36px; gap: .55rem; align-items: center; padding: .8rem; border: 1px solid var(--border); border-radius: 8px; background: #fff; }
  .group-row:has([data-group-enabled]:not(:checked)) [data-group-id] { opacity: .58; }
  .group-runtime { grid-column: 1 / -1; display: flex; align-items: flex-start; gap: .5rem; min-width: 0; padding: .1rem .15rem .35rem; }
  .group-runtime-text { min-width: 0; }
  .group-runtime-title { font-size: .84rem; font-weight: 700; }
  .group-runtime-details { color: var(--muted); font-size: .78rem; overflow-wrap: anywhere; }
  .group-enabled { display: inline-flex; align-items: center; gap: .4rem; color: var(--muted); font-size: .86rem; white-space: nowrap; cursor: pointer; }
  .group-row .btn-remove { width: 36px; height: 36px; padding: 0; }
  .group-options { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: .55rem 1rem; padding-top: .65rem; border-top: 1px solid var(--border); }
  .group-option { display: inline-flex; align-items: center; gap: .45rem; cursor: pointer; }
  .doubles-config { grid-column: 1 / -1; padding-top: .25rem; }
  .doubles-config[hidden] { display: none; }
  .team-list { display: grid; gap: .45rem; }
  .team-row { display: grid; grid-template-columns: 64px minmax(0, 1fr) 18px minmax(0, 1fr) 36px; gap: .45rem; align-items: center; }
  .team-priority { display: inline-grid; grid-template-columns: 26px 26px; gap: .2rem; justify-content: start; }
  .team-priority .priority-number { text-align: center; }
  .team-priority .btn-move { width: 26px; height: 26px; }
  .team-plus { color: var(--muted); text-align: center; font-weight: 700; }
  .btn-add-team { margin-top: .6rem; padding: .4rem .7rem; background: var(--accent-soft); color: #b6478f; }
  .btn-reset-state { width: 36px; height: 36px; padding: 0; background: var(--accent-soft); color: #b6478f; font-size: 1.15rem; }
  .btn-save { background: var(--grad); color: #fff; box-shadow: 0 6px 18px rgba(197, 111, 206, .38); }
  .btn-test { background: #fff; color: #c56fce; border: 1.5px solid #eccbe6; }
  .btn-remove { background: transparent; color: #e2849b; font-size: 1.2rem; padding: .1rem .4rem; box-shadow: none; }
  .priority-controls { display: inline-grid; grid-template-columns: 28px 28px; gap: .25rem; justify-content: center; }
  .priority-number { grid-column: 1 / -1; color: var(--muted); font-size: .75rem; line-height: 1; }
  .btn-move { width: 28px; height: 28px; padding: 0; border-radius: 7px; background: var(--accent-soft); color: #b6478f; line-height: 1; }
  .btn-move:disabled { opacity: .35; cursor: default; filter: none; }
  .actions { display: flex; gap: .6rem; margin-top: 1.4rem; flex-wrap: wrap; align-items: center; }
  .status { margin-left: .4rem; color: var(--muted); }
  .app-status { margin: 0 0 2rem; padding: 0 0 1.2rem; border-bottom: 1px solid var(--border); }
  .status-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .status-head h2 { margin: 0; font-size: 1.05rem; }
  .status-updated { color: var(--muted); font-size: .82rem; margin-top: .15rem; }
  .btn-refresh { flex: 0 0 auto; background: #fff; color: #b6478f; border: 1px solid #eccbe6; }
  .btn-refresh:disabled { opacity: .55; cursor: wait; }
  .status-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 1rem; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .status-metric { min-width: 0; padding: .75rem .8rem; background: #fff; border-right: 1px solid var(--border); }
  .status-metric:last-child { border-right: 0; }
  .status-label { color: var(--muted); font-size: .75rem; }
  .status-value { display: flex; align-items: center; gap: .45rem; margin-top: .15rem; font-weight: 700; overflow-wrap: anywhere; }
  .status-dot { width: 9px; height: 9px; flex: 0 0 9px; border-radius: 50%; background: #9aa0ab; }
  .is-good .status-dot, .status-dot.is-good { background: #4f9d69; }
  .is-warn .status-dot, .status-dot.is-warn { background: #d49a34; }
  .is-bad .status-dot, .status-dot.is-bad { background: #d65f65; }
  .live-groups { margin-top: 1rem; }
  .live-group { padding: 1rem 0; border-top: 1px solid var(--border); }
  .live-group:first-child { border-top: 0; }
  .live-group-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
  .live-group-title { font-weight: 700; overflow-wrap: anywhere; }
  .live-group-meta { color: var(--muted); font-size: .82rem; }
  .event-line { margin-top: .55rem; }
  .event-title { font-weight: 650; }
  .status-badge { display: inline-block; border-radius: 999px; padding: .12rem .5rem; font-size: .75rem; font-weight: 700; background: var(--field); color: var(--muted); white-space: nowrap; }
  .status-badge.registered { background: #e5f4e9; color: #39794e; }
  .status-badge.reserve { background: #fff0cf; color: #8b6214; }
  .status-badge.not_joined, .status-badge.error { background: #fde6e8; color: #a9434b; }
  .status-badge.no_event, .status-badge.disabled { background: #eee9ed; color: #756a72; }
  .live-player-table { width: 100%; margin-top: .55rem; }
  .live-player-table td, .live-player-table th { padding: .38rem .4rem; }
  .live-player-error { color: #a9434b; font-size: .78rem; overflow-wrap: anywhere; }
  .status-error { margin-top: 1rem; color: #a9434b; background: #fdebed; border: 1px solid #f3c8cc; border-radius: 8px; padding: .65rem .8rem; }
  .operation-logs { margin: 0 0 2rem; padding: 0 0 1.4rem; border-bottom: 1px solid var(--border); }
  .log-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; }
  .log-head h2 { margin: 0; }
  .log-toolbar { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-top: .8rem; }
  .log-modes { display: inline-flex; min-width: 0; border: 1px solid var(--field-border); border-radius: 8px; overflow: hidden; background: #fff; }
  .log-mode { min-height: 38px; padding: .4rem .7rem; border-radius: 0; border-right: 1px solid var(--field-border); background: #fff; color: var(--muted); white-space: nowrap; box-shadow: none; }
  .log-mode:last-child { border-right: 0; }
  .log-mode.is-active { background: var(--accent-soft); color: #a9387e; }
  .log-controls { display: flex; gap: .5rem; align-items: center; }
  .log-auto { min-height: 38px; display: inline-flex; align-items: center; gap: .4rem; padding: .35rem .55rem; color: var(--muted); white-space: nowrap; cursor: pointer; }
  .log-list { margin-top: .8rem; border-top: 1px solid var(--border); }
  .log-empty { color: var(--muted); padding: 1rem 0; }
  .log-run { border-bottom: 1px solid var(--border); }
  .log-run > summary { list-style: none; display: grid; grid-template-columns: 9px minmax(0, 1fr) auto; gap: .65rem; align-items: center; padding: .75rem .15rem; cursor: pointer; }
  .log-run > summary::-webkit-details-marker { display: none; }
  .log-run-title { min-width: 0; font-weight: 700; overflow-wrap: anywhere; }
  .log-run-meta { color: var(--muted); font-size: .78rem; font-weight: 400; }
  .log-run-count { color: var(--muted); font-size: .78rem; white-space: nowrap; }
  .log-entries { padding: 0 0 .7rem 1rem; border-left: 1px solid var(--border); margin-left: .4rem; }
  .log-entry { display: grid; grid-template-columns: 72px 9px minmax(0, 1fr); gap: .55rem; align-items: start; padding: .45rem 0; }
  .log-time { color: var(--muted); font: .75rem/1.4 ui-monospace, Menlo, monospace; }
  .log-entry-main { min-width: 0; }
  .log-action { font-size: .84rem; font-weight: 700; overflow-wrap: anywhere; }
  .log-summary { color: var(--muted); font-size: .78rem; overflow-wrap: anywhere; }
  .log-technical { margin-top: .25rem; }
  .log-technical summary { color: var(--accent); cursor: pointer; font-size: .75rem; }
  .log-technical pre { margin: .3rem 0 0; padding: .55rem .65rem; font-size: .72rem; max-height: 220px; overflow: auto; }
  .log-load-error { color: #a9434b; padding: .8rem 0; }
  .browser-history { margin-top: .8rem; }
  .browser-history summary { cursor: pointer; color: var(--accent); font-weight: 650; }
  .browser-history table { margin-top: .5rem; }
  pre { background: var(--field); border: 1px solid var(--border); border-radius: 11px; padding: .8rem 1rem; overflow-x: auto; margin-top: 1rem; font-family: ui-monospace, Menlo, monospace; font-size: .82rem; white-space: pre-wrap; }
  .hint { color: var(--muted); font-size: .82rem; margin-top: 1.6rem; }
  code { background: var(--accent-soft); color: #b6478f; padding: .1rem .35rem; border-radius: 5px; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .3rem; }
  .days { display: flex; gap: .5rem; flex-wrap: wrap; margin: .6rem 0; }
  .day { display: inline-flex; align-items: center; gap: .4rem; background: var(--field); border: 1px solid var(--field-border); border-radius: 11px; padding: .4rem .7rem; cursor: pointer; user-select: none; }
  .day:has(input:checked) { background: var(--accent-soft); border-color: #efc6e0; color: #b6478f; }
  .day input { width: 16px; height: 16px; accent-color: var(--accent); }
  .times { display: flex; gap: 1.2rem; align-items: center; flex-wrap: wrap; margin-top: .4rem; }
  .times label { color: var(--muted); font-size: .9rem; display: inline-flex; gap: .5rem; align-items: center; }
  input[type=time] { background: var(--field); border: 1px solid var(--field-border); color: var(--ink); border-radius: 9px; padding: .4rem .5rem; font: inherit; }
  .pause-panel { display: flex; gap: 1rem; align-items: center; justify-content: space-between; margin-top: 1rem; padding: .8rem 1rem; border: 1px solid #edc67f; border-radius: 8px; background: #fff5db; color: #684b18; }
  .pause-panel[hidden] { display: none; }
  .pause-panel.is-clear { border-color: #b9d8c4; background: #eef8f1; color: #356146; }
  .pause-panel.is-expired { border-color: var(--border); background: var(--field); color: var(--muted); }
  .pause-title { font-weight: 700; }
  .pause-details { font-size: .86rem; margin-top: .1rem; overflow-wrap: anywhere; }
  .btn-resume { flex: 0 0 auto; background: #fff; color: #8a5c08; border: 1px solid #e6c06f; }
  .btn-resume[hidden] { display: none; }
  .pause-panel.is-expired .btn-resume { color: #b6478f; border-color: #eccbe6; }
  @media (max-width: 640px) {
    body { padding: 1rem .5rem; }
    main { padding: 1.25rem 1rem 1.5rem; border-radius: 16px; }
    .table-scroll table { min-width: 720px; }
    .actions { align-items: stretch; }
    .actions button { flex: 1 1 220px; }
    .status { width: 100%; margin-left: 0; }
    .pause-panel { align-items: stretch; flex-direction: column; }
    .btn-resume { width: 100%; }
    .status-head { align-items: stretch; flex-direction: column; }
    .btn-refresh { width: 100%; }
    .status-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .status-metric:nth-child(2) { border-right: 0; }
    .status-metric:nth-child(-n+2) { border-bottom: 1px solid var(--border); }
    .live-group-head { flex-direction: column; gap: .25rem; }
    .group-row { grid-template-columns: minmax(0, 1fr) 36px 36px; }
    .group-row [data-group-id] { grid-column: 1 / -1; }
    .group-enabled { grid-column: 1; }
    .team-row { grid-template-columns: 58px minmax(0, 1fr) 18px minmax(0, 1fr) 32px; }
    .log-head { align-items: stretch; flex-direction: column; }
    .log-toolbar { align-items: stretch; flex-direction: column; }
    .log-modes { display: grid; grid-template-columns: 1fr 1fr; width: 100%; }
    .log-mode { border-bottom: 1px solid var(--field-border); }
    .log-mode:nth-child(2) { border-right: 0; }
    .log-mode:nth-child(n+3) { border-bottom: 0; }
    .log-controls { display: grid; grid-template-columns: 1fr 1fr; }
    .log-controls > * { min-width: 0; width: 100%; }
    .log-run > summary { grid-template-columns: 9px minmax(0, 1fr); }
    .log-run-count { grid-column: 2; }
    .log-entry { grid-template-columns: 58px 9px minmax(0, 1fr); }
  }
</style>
</head>
<body>
<main>
  <section class="app-status" aria-labelledby="appStatusTitle">
    <div class="status-head">
      <div>
        <h2 id="appStatusTitle">Состояние приложения</h2>
        <div class="status-updated" id="statusUpdated">Загружаю актуальные данные…</div>
      </div>
      <button class="btn-refresh" id="refreshStatus" type="button">↻ Обновить</button>
    </div>
    <div class="status-summary" id="statusSummary">
      <div class="status-metric"><div class="status-label">Автозапись</div><div class="status-value"><span class="status-dot"></span><span>Проверяю…</span></div></div>
      <div class="status-metric"><div class="status-label">Группы</div><div class="status-value"><span class="status-dot"></span><span>—</span></div></div>
      <div class="status-metric"><div class="status-label">События</div><div class="status-value"><span class="status-dot"></span><span>—</span></div></div>
      <div class="status-metric"><div class="status-label">Browser Run</div><div class="status-value"><span class="status-dot"></span><span>—</span></div></div>
    </div>
    <div class="live-groups" id="liveGroups"></div>
    <details class="browser-history" id="browserHistory" hidden>
      <summary>Последние запуски браузера</summary>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Начало</th><th>Длительность</th><th>Завершение</th></tr></thead>
          <tbody id="browserRuns"></tbody>
        </table>
      </div>
    </details>
    <div class="status-error" id="statusLoadError" hidden></div>
  </section>

  <section class="operation-logs" aria-labelledby="operationLogsTitle">
    <div class="log-head">
      <div>
        <h2 id="operationLogsTitle">Журнал работы</h2>
        <div class="status-updated" id="logsUpdated">Загружаю последние шаги…</div>
      </div>
    </div>
    <div class="log-toolbar">
      <div class="log-modes" role="group" aria-label="Режим журнала">
        <button class="log-mode is-active" type="button" data-log-view="join" aria-pressed="true">Запись игроков</button>
        <button class="log-mode" type="button" data-log-view="problems" aria-pressed="false">Проблемы</button>
        <button class="log-mode" type="button" data-log-view="events" aria-pressed="false">События</button>
        <button class="log-mode" type="button" data-log-view="all" aria-pressed="false">Все проверки</button>
      </div>
      <div class="log-controls">
        <label class="log-auto"><input type="checkbox" id="logsAutoRefresh" checked>Авто</label>
        <button class="btn-refresh" id="refreshLogs" type="button">↻ Обновить</button>
      </div>
    </div>
    <div class="log-list" id="operationLogs"></div>
    <div class="log-load-error" id="logsLoadError" hidden></div>
  </section>

  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th class="col-priority">Приоритет</th>
          <th>Имя (как в Racket)</th>
          <th>Email / логин</th>
          <th>Пароль</th>
          <th class="col-enabled">Записывать</th>
          <th class="col-remove"></th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </div>

  <button class="btn-add" id="add">+ Добавить человека</button>

  <h2>Группы Racket</h2>
  <p class="sub" style="margin:.2rem 0 .4rem">ID групп, в которых нужно искать события и запускать автозапись. Можно вставить ID или полную ссылку. Сними галочку «Мониторить», чтобы временно выключить группу без удаления.</p>
  <div class="group-list" id="groups"></div>
  <button class="btn-add" id="addGroup">+ Добавить группу</button>

  <h2>🗓️ Расписание</h2>
  <p class="sub" style="margin:.2rem 0 .4rem">В какие дни недели и в какое время (по Лиссабону) запускать автозапись. Если ни один день не отмечен — скрипт не запускается.</p>
  <div class="days" id="days"></div>
  <div class="times">
    <label>Начало <input type="time" id="startTime"></label>
    <label>Конец <input type="time" id="endTime"></label>
  </div>
  <div class="pause-panel" id="pausePanel" hidden>
    <div>
      <div class="pause-title" id="pauseTitle"></div>
      <div class="pause-details" id="pauseDetails"></div>
    </div>
    <button class="btn-resume" id="resumeMonitoring" type="button">Снять паузу</button>
  </div>

  <div class="actions">
    <button class="btn-save" id="save">Сохранить</button>
    <button class="btn-test" id="test">Тест: записать в тестовую группу</button>
    <span class="status" id="status"></span>
  </div>

  <pre id="output" hidden></pre>

  <p class="hint">Пароли хранятся в Cloudflare KV в открытом виде (иначе авторизация невозможна). Страница защищена <code>JOIN_SECRET</code>. Тест использует тестовую группу <code>IenuPng40UmpsU</code> и выполняет реальную запись через API Racket.</p>
</main>

<script>
const SECRET = ${embed(secret)};
let people = ${embed(roster)};
let schedule = ${embed(schedule)};
let groups = ${embed(groups)};
let latestApplicationStatus = null;

const DAY_LABELS = [["mon","Пн"],["tue","Вт"],["wed","Ср"],["thu","Чт"],["fri","Пт"],["sat","Сб"],["sun","Вс"]];

const rowsEl = document.getElementById("rows");
const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");
const daysEl = document.getElementById("days");
const startEl = document.getElementById("startTime");
const endEl = document.getElementById("endTime");
const groupsEl = document.getElementById("groups");
const pausePanelEl = document.getElementById("pausePanel");
const pauseTitleEl = document.getElementById("pauseTitle");
const pauseDetailsEl = document.getElementById("pauseDetails");
const resumeMonitoringEl = document.getElementById("resumeMonitoring");
const refreshStatusEl = document.getElementById("refreshStatus");
const statusUpdatedEl = document.getElementById("statusUpdated");
const statusSummaryEl = document.getElementById("statusSummary");
const liveGroupsEl = document.getElementById("liveGroups");
const browserHistoryEl = document.getElementById("browserHistory");
const browserRunsEl = document.getElementById("browserRuns");
const statusLoadErrorEl = document.getElementById("statusLoadError");
const operationLogsEl = document.getElementById("operationLogs");
const logsUpdatedEl = document.getElementById("logsUpdated");
const logsLoadErrorEl = document.getElementById("logsLoadError");
const refreshLogsEl = document.getElementById("refreshLogs");
const logsAutoRefreshEl = document.getElementById("logsAutoRefresh");
const logModeEls = Array.from(document.querySelectorAll("[data-log-view]"));
let operationLogs = [];
let activeLogView = "join";
const openLogRunIdsByView = new Map();
const openLogEntryIds = new Set();
const initializedLogViews = new Set();

function openLogRunIds() {
  if (!openLogRunIdsByView.has(activeLogView)) {
    openLogRunIdsByView.set(activeLogView, new Set());
  }
  return openLogRunIdsByView.get(activeLogView);
}

const LOG_ACTION_LABELS = {
  cron_started: "Cron запущен",
  cron_finished: "Cron завершён",
  cron_failed: "Cron завершился с ошибкой",
  cron_skipped: "Cron пропущен",
  monitor_polling_healthy: "Мониторинг работает",
  monitor_polling_skipped: "Мониторинг пропущен",
  monitor_check_started: "Начата проверка события",
  monitor_check_finished: "Проверка события завершена",
  monitor_check_failed: "Проверка события завершилась с ошибкой",
  monitor_scheduler_kick_failed: "Планировщик мониторинга недоступен",
  group_checks_started: "Начата проверка групп",
  group_check_finished: "Группа проверена",
  group_check_failed: "Проверка группы не удалась",
  event_notification_evaluated: "Проверено изменение событий",
  autojoin_event_selected: "Выбрано событие для автозаписи",
  autojoin_skipped: "Автозапись пропущена",
  autojoin_failed: "Автозапись завершилась с ошибкой",
  autojoin_completed: "Автозапись завершена",
  autojoin_waiting_for_participants: "Ожидаем нужное число участников",
  autojoin_waiting_for_date: "Ожидаем дату найденного события",
  copy_discovery_finished: "Поиск копий событий завершён",
  copy_discovery_failed: "Не удалось проверить копии событий",
  autojoin_participation_check_failed: "Не удалось проверить число участников",
  join_coordinator_prepared: "Очередь события подготовлена",
  join_coordinator_prepare_failed: "Не удалось подготовить очередь",
  join_person_started: "Начата запись игрока",
  join_person_finished: "Запись игрока завершена",
  racket_auth_started: "Начата авторизация Racket",
  racket_auth_finished: "Авторизация Racket завершена",
  racket_partner_auth_started: "Начата авторизация партнёра",
  racket_partner_auth_finished: "Авторизация партнёра завершена",
  participation_precheck_started: "Проверяется текущая запись",
  participation_precheck_finished: "Текущая запись проверена",
  firestore_join_attempt: "Запрос записи в Firestore",
  firestore_team_join_attempt: "Запрос записи пары в Firestore",
  participation_verification_started: "Проверяется результат PATCH",
  participation_verification_finished: "Результат PATCH проверен",
  api_path_failed: "API-путь завершился с ошибкой",
  browser_fallback_started: "Запущен browser fallback",
  browser_acquired: "Browser Run получен",
  browser_acquisition_failed: "Browser Run недоступен",
  browser_context_created: "Создан изолированный browser context",
  browser_page_created: "Создана страница браузера",
  browser_navigation_started: "Открывается страница группы",
  browser_navigation_finished: "Страница группы открыта",
  browser_login_button_clicked: "Нажата кнопка Log in to join",
  browser_login_form_filled: "Форма логина заполнена",
  browser_login_submitted: "Форма логина отправлена",
  browser_login_finished: "Браузерная авторизация завершена",
  browser_event_opened: "Карточка события открыта",
  browser_participation_precheck: "Список игроков проверен в браузере",
  browser_capacity_checked: "Вместимость события проверена",
  browser_join_clicked: "Нажата кнопка Join",
  browser_checkout_confirmation: "Checkout подтверждён",
  browser_final_verification: "Браузерная запись проверена",
  browser_context_closed: "Browser context закрыт",
  browser_step_failed: "Шаг браузера завершился с ошибкой",
  join_batch_finished: "Очередь игроков завершена",
  telegram_notification_started: "Отправляется Telegram-сообщение",
  telegram_notification_finished: "Telegram-сообщение отправлено",
  telegram_notification_failed: "Telegram-сообщение не отправлено",
  telegram_notification_skipped: "Telegram-сообщение пропущено",
  settings_saved: "Настройки сохранены",
  manual_join_started: "Ручная запись запущена",
  manual_join_failed: "Ручная запись завершилась с ошибкой",
  manual_group_check_started: "Ручная проверка запущена",
  manual_group_check_finished: "Ручная проверка завершена",
  status_snapshot: "Состояние приложения обновлено",
  status_snapshot_failed: "Не удалось обновить состояние",
};

const LOG_DETAIL_LABELS = {
  groupId: "группа",
  eventId: "событие",
  eventTitle: "ивент",
  name: "игрок",
  phase: "этап",
  route: "путь",
  outcome: "результат",
  status: "статус",
  coordinatorStatus: "очередь",
  readStatus: "GET",
  writeStatus: "PATCH",
  attempt: "попытка",
  joined: "записан",
  joinedCount: "записано",
  totalCount: "всего",
  playerCount: "игроков",
  partnerMode: "партнёр",
  partnerName: "имя партнёра",
  teamId: "пара",
  eventCount: "событий",
  durationMs: "время",
  readDurationMs: "GET время",
  writeDurationMs: "PATCH время",
  verificationDurationMs: "проверка",
  apiPathDurationMs: "API время",
  intervalMs: "интервал",
  reason: "причина",
  error: "ошибка",
};

const PLAYER_STATUS_LABELS = {
  registered: "Записан",
  reserve: "В резерве",
  not_joined: "Не записан",
  no_event: "Нет события",
  disabled: "Выключен",
  error: "Ошибка",
};

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatLisbonDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString("ru-RU", {
    timeZone: "Europe/Lisbon",
    dateStyle: "short",
    timeStyle: "medium",
  });
}

function formatLogValue(key, value) {
  if (value == null) return "—";
  if (/(?:DurationMs$|^durationMs$|^intervalMs$)/.test(key) && typeof value === "number") {
    return value >= 1000 ? (value / 1000).toFixed(1) + " с" : value + " мс";
  }
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function conciseLogDetails(details) {
  const keys = [
    "groupId", "eventTitle", "eventId", "name", "phase", "route", "outcome",
    "status", "coordinatorStatus", "attempt", "readStatus", "writeStatus",
    "joined", "joinedCount", "totalCount", "playerCount", "eventCount",
    "registeredCount", "minParticipants", "preparingEventIds", "copyQueryCount",
    "durationMs", "readDurationMs", "writeDurationMs", "verificationDurationMs",
    "apiPathDurationMs", "reason", "error",
  ];
  return keys
    .filter((key) => details[key] !== undefined)
    .map((key) => (LOG_DETAIL_LABELS[key] || key) + ": " + formatLogValue(key, details[key]))
    .join(" · ");
}

function logRunTitle(entries) {
  const selected = entries.find((entry) => entry.action === "autojoin_event_selected");
  const completed = entries.find((entry) => entry.action === "autojoin_completed");
  const failed = entries.find((entry) => entry.level === "error");
  if (failed) return "Проблема: " + (LOG_ACTION_LABELS[failed.action] || failed.action);
  if (completed) return "Автозапись успешно завершена";
  if (selected) return "Обработка события " + (selected.details.eventTitle || selected.details.eventId || "");
  const trigger = entries[0]?.trigger || "запуск";
  if (trigger === "cron") return "Плановая проверка";
  if (trigger === "alarm-10s") return "Быстрая проверка (10 секунд)";
  if (trigger === "discovery-minute") return "Поиск новых событий (раз в минуту)";
  if (trigger === "cron-watchdog") return "Контрольная проверка";
  if (trigger === "/status") return "Обновление состояния";
  if (trigger === "/join-test") return "Тестовая запись";
  if (trigger === "/join") return "Ручная запись";
  return trigger;
}

function renderOperationLogs() {
  const runs = new Map();
  operationLogs.forEach((entry) => {
    const id = entry.runId || entry.id;
    if (!runs.has(id)) runs.set(id, []);
    runs.get(id).push(entry);
  });

  if (!runs.size) {
    const emptyMessages = {
      join: "Попыток записи игроков в сохранённом журнале нет.",
      problems: "Ошибок и предупреждений в сохранённом журнале нет.",
      events: "Появлений событий в сохранённом журнале нет.",
      all: "Журнал пока пуст.",
    };
    operationLogsEl.innerHTML = '<div class="log-empty">' +
      escapeHtml(emptyMessages[activeLogView] || emptyMessages.all) + '</div>';
    return;
  }

  const expandedRunIds = openLogRunIds();
  if (!initializedLogViews.has(activeLogView)) {
    expandedRunIds.add(String(runs.keys().next().value));
    initializedLogViews.add(activeLogView);
  }

  operationLogsEl.innerHTML = Array.from(runs.entries()).map(([runId, entries], runIndex) => {
    const chronologicalEntries = entries.slice().sort((a, b) =>
      (a.sequence || 0) - (b.sequence || 0) ||
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const tone = entries.some((entry) => entry.level === "error")
      ? "is-bad"
      : entries.some((entry) => entry.level === "warn") ? "is-warn" : "is-good";
    const newest = new Date(chronologicalEntries[chronologicalEntries.length - 1].timestamp);
    const oldest = new Date(chronologicalEntries[0].timestamp);
    const elapsed = Math.max(0, newest.getTime() - oldest.getTime());
    const runMeta = formatLisbonDate(oldest.toISOString()) +
      " · " + (entries[0].trigger || "—") +
      (elapsed ? " · " + formatLogValue("durationMs", elapsed) : "") +
      " · " + String(runId).slice(0, 24);
    const entryMarkup = chronologicalEntries.map((entry) => {
      const summary = conciseLogDetails(entry.details || {});
      const technical = escapeHtml(JSON.stringify(entry.details || {}, null, 2));
      const entryId = String(entry.id || "");
      return '<div class="log-entry"><div class="log-time">' +
        escapeHtml(new Date(entry.timestamp).toLocaleTimeString("ru-RU", { timeZone: "Europe/Lisbon" })) +
        '</div><span class="status-dot ' +
        (entry.level === "error" ? "is-bad" : entry.level === "warn" ? "is-warn" : "is-good") +
        '"></span><div class="log-entry-main"><div class="log-action">' +
        escapeHtml(LOG_ACTION_LABELS[entry.action] || entry.action) +
        '</div>' + (summary ? '<div class="log-summary">' + escapeHtml(summary) + '</div>' : '') +
        '<details class="log-technical" data-log-entry-id="' + escapeHtml(entryId) + '"' +
        (openLogEntryIds.has(entryId) ? ' open' : '') +
        '><summary>Технические данные</summary><pre>' + technical +
        '</pre></details></div></div>';
    }).join("");
    const normalizedRunId = String(runId);
    return '<details class="log-run" data-log-run-id="' + escapeHtml(normalizedRunId) + '"' +
      (expandedRunIds.has(normalizedRunId) ? " open" : "") +
      '><summary><span class="status-dot ' + tone + '"></span><div><div class="log-run-title">' +
      escapeHtml(logRunTitle(entries)) + '</div><div class="log-run-meta">' + escapeHtml(runMeta) +
      '</div></div><span class="log-run-count">' + entries.length + ' шагов</span></summary>' +
      '<div class="log-entries">' + entryMarkup + '</div></details>';
  }).join("");
}

operationLogsEl.addEventListener("toggle", (event) => {
  const details = event.target;
  if (!details || details.tagName !== "DETAILS") return;
  if (details.classList.contains("log-run")) {
    const runId = details.dataset.logRunId;
    if (!runId) return;
    if (details.open) openLogRunIds().add(runId);
    else openLogRunIds().delete(runId);
  }
  if (details.classList.contains("log-technical")) {
    const entryId = details.dataset.logEntryId;
    if (!entryId) return;
    if (details.open) openLogEntryIds.add(entryId);
    else openLogEntryIds.delete(entryId);
  }
}, true);

async function refreshOperationLogs() {
  refreshLogsEl.disabled = true;
  logsLoadErrorEl.hidden = true;
  try {
    const response = await fetch("/logs?secret=" + encodeURIComponent(SECRET) +
      "&limit=1000&view=" + encodeURIComponent(activeLogView), {
      headers: { "cache-control": "no-cache" },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
    operationLogs = data.logs || [];
    logsUpdatedEl.textContent = "Обновлено " + formatLisbonDate(new Date().toISOString()) +
      " · найдено запусков: " + data.matchedRunCount +
      " · шагов: " + operationLogs.length;
    renderOperationLogs();
  } catch (error) {
    logsUpdatedEl.textContent = "Не удалось загрузить журнал";
    logsLoadErrorEl.hidden = false;
    logsLoadErrorEl.textContent = String(error);
  } finally {
    refreshLogsEl.disabled = false;
  }
}

function setStatusMetric(index, text, tone) {
  const metric = statusSummaryEl.children[index];
  metric.classList.remove("is-good", "is-warn", "is-bad");
  metric.classList.add(tone);
  metric.querySelector(".status-value span:last-child").textContent = text;
}

function getGroupRuntimeSummary(groupStatus, groupEnabled, monitorState) {
  if (!groupEnabled) {
    return {
      title: "Мониторинг и автозапись выключены",
      details: "Cron пропускает эту группу.",
      tone: "is-warn",
      badge: "Выключена",
      badgeClass: "disabled",
    };
  }

  if (!groupStatus) {
    return {
      title: "Проверяю состояние…",
      details: "Жду актуальные данные приложения.",
      tone: "",
      badge: "Проверка",
      badgeClass: "disabled",
    };
  }

  if (!groupStatus.ok) {
    return {
      title: "Автозапись не готова",
      details: "Не удалось прочитать события: " + (groupStatus.error || "неизвестная ошибка"),
      tone: "is-bad",
      badge: "Ошибка",
      badgeClass: "error",
    };
  }

  const state = {
    active: {
      title: "Автозапись включена сейчас",
      tone: "is-good",
      badge: "Работает",
      badgeClass: "registered",
    },
    paused: {
      title: "Автозапись на паузе",
      tone: "is-warn",
      badge: "На паузе",
      badgeClass: "reserve",
    },
    disabled: {
      title: "Автозапись выключена расписанием",
      tone: "is-bad",
      badge: "Выключена",
      badgeClass: "disabled",
    },
    outside_schedule: {
      title: "Автозапись настроена и ждёт расписания",
      tone: "is-warn",
      badge: "Ждёт расписания",
      badgeClass: "reserve",
    },
  }[monitorState] || {
    title: "Состояние автозаписи неизвестно",
    tone: "is-warn",
    badge: "Неизвестно",
    badgeClass: "disabled",
  };

  if (!groupStatus.event) {
    return {
      ...state,
      details: "Подходящих событий сейчас нет. Когда событие появится, cron поставит игроков в очередь.",
      badge: monitorState === "active" ? "Ждём событие" : state.badge,
      badgeClass: monitorState === "active" ? "no_event" : state.badgeClass,
    };
  }

  const activePlayers = groupStatus.players.filter((player) => player.status !== "disabled");
  const joinedPlayers = activePlayers.filter((player) =>
    player.status === "registered" || player.status === "reserve"
  );
  const pendingCount = activePlayers.length - joinedPlayers.length;
  const queueStarted = groupStatus.hasStartedAutoJoin;
  const eventName = groupStatus.event.title || groupStatus.event.date || groupStatus.event.id;
  const minimum = groupStatus.minParticipants ?? 10;
  if (!queueStarted && pendingCount && groupStatus.event.registeredCount != null &&
      groupStatus.event.registeredCount < minimum) {
    return {
      ...state,
      details: eventName + ": участников " + groupStatus.event.registeredCount +
        "/" + minimum + ". Резерв не учитывается. Проверяем каждые 10 секунд по расписанию.",
      badge: "Ждём участников",
      badgeClass: "reserve",
    };
  }
  if (!activePlayers.length) {
    return {
      ...state,
      details: eventName + ": событие найдено, но нет включённых игроков.",
      badge: "Нет игроков",
      badgeClass: "disabled",
    };
  }
  const details = eventName + ": записаны " + joinedPlayers.length + "/" + activePlayers.length +
    (pendingCount ? ", ожидают " + pendingCount : ", все готовы") + ". " +
    (queueStarted
      ? "Очередь автозаписи для этого события уже запускалась."
      : "Cron ещё не запускал очередь автозаписи для этого события.");

  if (monitorState === "active") {
    return {
      ...state,
      details,
      badge: pendingCount ? "Записать: " + pendingCount : "Все записаны",
      badgeClass: pendingCount ? "reserve" : "registered",
    };
  }

  return { ...state, details };
}

function renderGroupRuntimeStates() {
  groupsEl.querySelectorAll(".group-row").forEach((row, index) => {
    const group = groups[index];
    const groupStatus = latestApplicationStatus?.groups.find((item) => item.groupId === group.id);
    const summary = getGroupRuntimeSummary(
      groupStatus,
      group.enabled !== false,
      latestApplicationStatus?.monitor.state,
    );
    const runtime = row.querySelector("[data-group-runtime]");
    if (!runtime) return;
    const dot = runtime.querySelector(".status-dot");
    dot.classList.remove("is-good", "is-warn", "is-bad");
    if (summary.tone) dot.classList.add(summary.tone);
    runtime.querySelector(".group-runtime-title").textContent = summary.title;
    runtime.querySelector(".group-runtime-details").textContent = summary.details;
  });
}

function renderApplicationStatus(data) {
  latestApplicationStatus = data;
  const monitorLabels = {
    active: "Включена сейчас",
    paused: "На паузе",
    disabled: "Выключена",
    outside_schedule: "Ждёт расписания",
  };
  const monitorTone = data.monitor.state === "active"
    ? "is-good"
    : data.monitor.state === "disabled"
      ? "is-bad"
      : "is-warn";
  setStatusMetric(0, monitorLabels[data.monitor.state] || data.monitor.state, monitorTone);

  const healthyGroups = data.groups.filter((group) => group.ok).length;
  setStatusMetric(
    1,
    healthyGroups + "/" + data.monitor.enabledGroupCount + " отвечают",
    healthyGroups === data.monitor.enabledGroupCount ? "is-good" : "is-bad",
  );

  const eventCount = data.groups.filter((group) => group.event).length;
  setStatusMetric(
    2,
    eventCount ? "Найдено: " + eventCount : "Нет подходящих",
    eventCount ? "is-good" : "is-warn",
  );

  const browserWait = data.browser.timeUntilNextAllowedBrowserAcquisition;
  const browserText = data.browser.state === "available"
    ? "Доступен"
    : data.browser.state === "limited"
      ? "Ожидание" + (browserWait ? " " + Math.ceil(browserWait / 1000) + " с" : "")
      : "Статус неизвестен";
  setStatusMetric(
    3,
    browserText,
    data.browser.state === "available" ? "is-good" : data.browser.state === "limited" ? "is-warn" : "is-bad",
  );

  statusUpdatedEl.textContent =
    "Обновлено " + formatLisbonDate(data.checkedAt) +
    " · игроков включено: " + data.monitor.enabledPlayerCount +
    " · активных browser sessions: " + data.browser.activeSessionCount;

  if (!data.groups.length) {
    liveGroupsEl.innerHTML = '<div class="live-group-meta">Нет включённых групп.</div>';
  } else {
    liveGroupsEl.innerHTML = data.groups.map((group) => {
      if (!group.ok) {
        return '<div class="live-group">' +
          '<div class="live-group-head"><div><div class="live-group-title">' + escapeHtml(group.groupId) + '</div>' +
          '<div class="live-group-meta">Firestore недоступен</div></div><span class="status-badge error">Ошибка</span></div>' +
          '<div class="live-player-error">' + escapeHtml(group.error || "Неизвестная ошибка") + '</div></div>';
      }

      const event = group.event;
      const configuredGroup = groups.find((item) => item.id === group.groupId);
      const summary = getGroupRuntimeSummary(
        group,
        configuredGroup?.enabled !== false,
        data.monitor.state,
      );
      const eventMarkup = event
        ? '<div class="event-line"><div class="event-title">' + escapeHtml(event.title || event.date || event.id) + '</div>' +
          '<div class="live-group-meta">' + escapeHtml(event.date || "Дата не указана") +
          ' · игроков ' + escapeHtml(event.registeredCount == null ? "?" : event.registeredCount) +
          '/' + escapeHtml(event.slots == null ? "?" : event.slots) +
          ' · резерв ' + escapeHtml(event.reserveCount == null ? "?" : event.reserveCount) +
          ' · ' + (group.hasStartedAutoJoin ? "очередь автозаписи уже запускалась" : "cron ещё не запускал автозапись") +
          '</div></div>'
        : '<div class="event-line live-group-meta">Подходящих событий сейчас нет.</div>';
      const playerRows = group.players.map((player) =>
        '<tr><td>' + escapeHtml(player.name || player.id) + '</td><td><span class="status-badge ' +
        escapeHtml(player.status) + '">' + escapeHtml(PLAYER_STATUS_LABELS[player.status] || player.status) + '</span>' +
        (player.error ? '<div class="live-player-error">' + escapeHtml(player.error) + '</div>' : '') +
        '</td></tr>'
      ).join("");

      return '<div class="live-group"><div class="live-group-head"><div>' +
        '<div class="live-group-title"><a href="' + escapeHtml(group.groupUrl) + '" target="_blank" rel="noreferrer">' + escapeHtml(group.groupId) + '</a></div>' +
        '<div class="live-group-meta">Firestore отвечает · будущих событий: ' + escapeHtml(group.upcomingEventCount) + '</div>' +
        '</div><span class="status-badge ' + escapeHtml(summary.badgeClass) + '">' + escapeHtml(summary.badge) + '</span></div>' + eventMarkup +
        '<table class="live-player-table"><thead><tr><th>Игрок</th><th>Фактический статус</th></tr></thead><tbody>' + playerRows + '</tbody></table></div>';
    }).join("");
  }

  renderGroupRuntimeStates();

  const runs = data.browser.recentRuns || [];
  browserHistoryEl.hidden = runs.length === 0;
  browserRunsEl.innerHTML = runs.map((run) =>
    '<tr><td>' + escapeHtml(formatLisbonDate(run.startedAt)) + '</td>' +
    '<td>' + escapeHtml((run.durationMs / 1000).toFixed(1)) + ' с</td>' +
    '<td>' + escapeHtml(run.closeReason || "—") + '</td></tr>'
  ).join("");

  statusLoadErrorEl.hidden = !data.browser.error;
  statusLoadErrorEl.textContent = data.browser.error
    ? "Browser Run: " + data.browser.error
    : "";
}

async function refreshApplicationStatus() {
  refreshStatusEl.disabled = true;
  statusLoadErrorEl.hidden = true;
  statusUpdatedEl.textContent = "Обновляю Firestore и Browser Run…";
  try {
    const res = await fetch("/status?secret=" + encodeURIComponent(SECRET), {
      headers: { "cache-control": "no-cache" },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    renderApplicationStatus(data);
  } catch (err) {
    statusUpdatedEl.textContent = "Не удалось обновить состояние";
    statusLoadErrorEl.hidden = false;
    statusLoadErrorEl.textContent = String(err);
    setStatusMetric(0, "Ошибка проверки", "is-bad");
  } finally {
    refreshStatusEl.disabled = false;
  }
}

refreshStatusEl.addEventListener("click", refreshApplicationStatus);
refreshLogsEl.addEventListener("click", refreshOperationLogs);
logModeEls.forEach((button) => {
  button.addEventListener("click", () => {
    activeLogView = button.dataset.logView;
    logModeEls.forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    refreshOperationLogs();
  });
});
window.setInterval(() => {
  if (logsAutoRefreshEl.checked && document.visibilityState === "visible") {
    refreshOperationLogs();
  }
}, 10000);

function renderGroups() {
  groupsEl.innerHTML = "";
  groups.forEach((group, i) => {
    const row = document.createElement("div");
    row.className = "group-row";
    row.innerHTML =
      '<input type="text" data-group-id="' + i + '" aria-label="ID группы Racket">' +
      '<label class="group-enabled"><input type="checkbox" data-group-enabled="' + i + '">Мониторить</label>' +
      '<button class="btn-reset-state" type="button" data-reset-group="' + i + '" title="Заново проверить запись для текущего события" aria-label="Заново проверить запись для текущего события">↻</button>' +
      '<button class="btn-remove" type="button" data-remove-group="' + i + '" title="Удалить группу" aria-label="Удалить группу">×</button>' +
      '<div class="group-runtime" data-group-runtime="' + i + '">' +
        '<span class="status-dot"></span><div class="group-runtime-text">' +
          '<div class="group-runtime-title">Проверяю состояние…</div>' +
          '<div class="group-runtime-details">Жду актуальные данные приложения.</div>' +
        '</div></div>' +
      '<div class="group-options">' +
        '<label class="group-option"><input type="checkbox" data-group-singles="' + i + '">Обычные события</label>' +
        '<label class="group-option"><input type="checkbox" data-group-doubles="' + i + '">Парные события</label>' +
        '<label class="group-option">Записывать при <input type="number" min="0" max="10000" step="1" data-group-min-participants="' + i + '" aria-label="Минимум участников для автозаписи" style="width:5rem"> участниках</label>' +
        '<span class="hint">Без резерва. 0 — записывать сразу.</span>' +
      '</div>' +
      '<div class="doubles-config" data-doubles-config="' + i + '">' +
        '<div class="team-list" data-team-list="' + i + '"></div>' +
        '<button class="btn-add-team" type="button" data-add-team="' + i + '">+ Добавить пару</button>' +
      '</div>';
    row.querySelector("[data-group-id]").value = group.id;
    row.querySelector("[data-group-enabled]").checked = group.enabled !== false;
    row.querySelector("[data-group-singles]").checked = group.joinSingles !== false;
    row.querySelector("[data-group-doubles]").checked = group.joinDoubles === true;
    row.querySelector("[data-group-min-participants]").value = group.minParticipants ?? 10;
    row.querySelector("[data-doubles-config]").hidden = group.joinDoubles !== true;
    groupsEl.appendChild(row);
    renderDoublesTeams(row, group, i);
  });
  renderGroupRuntimeStates();
}

function personOptions(selectedId, includePlaceholder) {
  let options = includePlaceholder
    ? '<option value="">Placeholder — партнёр пока неизвестен</option>'
    : '<option value="">Выберите игрока</option>';
  options += people.map((person) =>
    '<option value="' + escapeHtml(person.id) + '"' +
      (person.id === selectedId ? ' selected' : '') + '>' +
      escapeHtml(person.name || person.email) + '</option>'
  ).join("");
  return options;
}

function renderDoublesTeams(row, group, groupIndex) {
  const list = row.querySelector("[data-team-list]");
  const teams = group.doublesTeams || [];
  list.innerHTML = teams.length ? teams.map((team, teamIndex) =>
    '<div class="team-row" data-team-row="' + teamIndex + '" data-team-id="' + escapeHtml(team.id) + '">' +
      '<div class="team-priority"><span class="priority-number">№ ' + (teamIndex + 1) + '</span>' +
        '<button class="btn-move" type="button" data-move-team="up" data-group-index="' + groupIndex + '" data-team-index="' + teamIndex + '"' + (teamIndex === 0 ? ' disabled' : '') + ' aria-label="Поднять пару">↑</button>' +
        '<button class="btn-move" type="button" data-move-team="down" data-group-index="' + groupIndex + '" data-team-index="' + teamIndex + '"' + (teamIndex === teams.length - 1 ? ' disabled' : '') + ' aria-label="Опустить пару">↓</button></div>' +
      '<select data-team-leader aria-label="Кто выполняет запись">' + personOptions(team.leaderId, false) + '</select>' +
      '<span class="team-plus">+</span>' +
      '<select data-team-partner aria-label="Партнёр">' + personOptions(team.partnerId || "", true) + '</select>' +
      '<button class="btn-remove" type="button" data-remove-team="' + teamIndex + '" data-group-index="' + groupIndex + '" aria-label="Удалить пару">×</button>' +
    '</div>'
  ).join("") : '<div class="group-runtime-details">Добавьте хотя бы одну пару. Верхняя записывается первой.</div>';
}

function collectGroups() {
  groups = Array.from(groupsEl.querySelectorAll(".group-row"))
    .map((row) => ({
      id: row.querySelector("[data-group-id]").value.trim(),
      enabled: row.querySelector("[data-group-enabled]").checked,
      joinSingles: row.querySelector("[data-group-singles]").checked,
      joinDoubles: row.querySelector("[data-group-doubles]").checked,
      minParticipants: Number(row.querySelector("[data-group-min-participants]").value),
      doublesTeams: Array.from(row.querySelectorAll("[data-team-row]")).map((teamRow) => ({
        id: teamRow.dataset.teamId || crypto.randomUUID(),
        leaderId: teamRow.querySelector("[data-team-leader]").value,
        partnerId: teamRow.querySelector("[data-team-partner]").value || null,
        enabled: true,
      })),
    }))
    .filter((group) => group.id);
}

function renderSchedule() {
  daysEl.innerHTML = "";
  DAY_LABELS.forEach(([key, label]) => {
    const l = document.createElement("label");
    l.className = "day";
    l.innerHTML = '<input type="checkbox" data-day="' + key + '">' + label;
    l.querySelector("input").checked = !!(schedule.days && schedule.days[key]);
    daysEl.appendChild(l);
  });
  startEl.value = schedule.startTime || "00:00";
  endEl.value = schedule.endTime || "23:59";
}

function collectSchedule() {
  const days = {};
  daysEl.querySelectorAll("input[data-day]").forEach((el) => { days[el.dataset.day] = el.checked; });
  const pausedUntil = schedule.pausedUntil;
  schedule = { days, startTime: startEl.value || "00:00", endTime: endEl.value || "23:59" };
  if (pausedUntil) schedule.pausedUntil = pausedUntil;
}

function renderPause() {
  const until = schedule.pausedUntil;
  const affectedGroups = groups
    .filter((group) => group.enabled)
    .map((group) => group.id);
  const groupsText = affectedGroups.join(", ") || "нет включённых групп";

  if (!until) {
    pausePanelEl.hidden = false;
    pausePanelEl.classList.add("is-clear");
    pausePanelEl.classList.remove("is-expired");
    pauseTitleEl.textContent = "Мониторинг не приостановлен";
    pauseDetailsEl.textContent =
      "pausedUntil: не задан. Включённые группы: " + groupsText + ".";
    resumeMonitoringEl.hidden = true;
    return;
  }

  const date = new Date(until);
  const active = Number.isFinite(date.getTime()) && date.getTime() > Date.now();
  const formatted = date.toLocaleString("ru-RU", {
    timeZone: "Europe/Lisbon",
    dateStyle: "medium",
    timeStyle: "short",
  });

  pausePanelEl.hidden = false;
  pausePanelEl.classList.remove("is-clear");
  pausePanelEl.classList.toggle("is-expired", !active);
  pauseTitleEl.textContent = active
    ? "Мониторинг приостановлен"
    : "Срок паузы уже закончился";
  pauseDetailsEl.textContent =
    "Группы: " + groupsText +
    ". До: " + formatted + " (Лиссабон).";
  resumeMonitoringEl.hidden = false;
  resumeMonitoringEl.textContent = active ? "Снять паузу" : "Удалить отметку";
}

function render() {
  rowsEl.innerHTML = "";
  people.forEach((p, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td class="col-priority"><span class="priority-controls">' +
        '<span class="priority-number">№ ' + (i + 1) + '</span>' +
        '<button class="btn-move" type="button" data-move="-1" data-i="' + i + '" title="Поднять приоритет" aria-label="Поднять приоритет">↑</button>' +
        '<button class="btn-move" type="button" data-move="1" data-i="' + i + '" title="Понизить приоритет" aria-label="Понизить приоритет">↓</button>' +
      '</span></td>' +
      '<td><input type="text" data-f="name" data-i="' + i + '"></td>' +
      '<td><input type="email" data-f="email" data-i="' + i + '"></td>' +
      '<td><input type="password" data-f="password" data-i="' + i + '"></td>' +
      '<td class="col-enabled"><input type="checkbox" data-f="enabled" data-i="' + i + '"></td>' +
      '<td class="col-remove"><button class="btn-remove" data-remove="' + i + '" title="Удалить">×</button></td>';
    tr.querySelector('[data-f=name]').value = p.name || "";
    tr.querySelector('[data-f=email]').value = p.email || "";
    tr.querySelector('[data-f=password]').value = p.password || "";
    tr.querySelector('[data-f=enabled]').checked = p.enabled !== false;
    tr.querySelector('[data-move="-1"]').disabled = i === 0;
    tr.querySelector('[data-move="1"]').disabled = i === people.length - 1;
    rowsEl.appendChild(tr);
  });
}

function collect() {
  rowsEl.querySelectorAll("input").forEach((el) => {
    const i = Number(el.dataset.i), f = el.dataset.f;
    people[i][f] = f === "enabled" ? el.checked : el.value;
  });
}

rowsEl.addEventListener("click", (e) => {
  const moveButton = e.target.closest("[data-move]");
  if (moveButton) {
    collect();
    const from = Number(moveButton.dataset.i);
    const to = from + Number(moveButton.dataset.move);
    if (to >= 0 && to < people.length) {
      const [person] = people.splice(from, 1);
      people.splice(to, 0, person);
      render();
      statusEl.textContent = "Приоритет изменён. Нажми «Сохранить».";
    }
    return;
  }

  const btn = e.target.closest("[data-remove]");
  if (!btn) return;
  collect();
  people.splice(Number(btn.dataset.remove), 1);
  render();
});

document.getElementById("add").addEventListener("click", () => {
  collect();
  people.push({ id: crypto.randomUUID(), name: "", email: "", password: "", enabled: true });
  render();
});

groupsEl.addEventListener("click", (e) => {
  const addTeamButton = e.target.closest("[data-add-team]");
  if (addTeamButton) {
    collectGroups();
    const groupIndex = Number(addTeamButton.dataset.addTeam);
    const group = groups[groupIndex];
    if (!group) return;
    const usedIds = new Set(
      group.doublesTeams.flatMap((team) =>
        [team.leaderId, team.partnerId].filter(Boolean)
      ),
    );
    const leader = people.find((person) => person.enabled && !usedIds.has(person.id)) ||
      people.find((person) => person.enabled) || people[0];
    group.doublesTeams.push({
      id: crypto.randomUUID(),
      leaderId: leader?.id || "",
      partnerId: null,
      enabled: true,
    });
    renderGroups();
    return;
  }

  const moveTeamButton = e.target.closest("[data-move-team]");
  if (moveTeamButton) {
    collectGroups();
    const groupIndex = Number(moveTeamButton.dataset.groupIndex);
    const teamIndex = Number(moveTeamButton.dataset.teamIndex);
    const direction = moveTeamButton.dataset.moveTeam === "up" ? -1 : 1;
    const targetIndex = teamIndex + direction;
    const teams = groups[groupIndex]?.doublesTeams;
    if (!teams || targetIndex < 0 || targetIndex >= teams.length) return;
    [teams[teamIndex], teams[targetIndex]] = [teams[targetIndex], teams[teamIndex]];
    renderGroups();
    return;
  }

  const removeTeamButton = e.target.closest("[data-remove-team]");
  if (removeTeamButton) {
    collectGroups();
    const groupIndex = Number(removeTeamButton.dataset.groupIndex);
    groups[groupIndex]?.doublesTeams.splice(Number(removeTeamButton.dataset.removeTeam), 1);
    renderGroups();
    return;
  }

  const resetButton = e.target.closest("[data-reset-group]");
  if (resetButton) {
    collectGroups();
    const group = groups[Number(resetButton.dataset.resetGroup)];
    if (!group?.id) return;
    if (!window.confirm(
      "Сбросить done для активного события группы " + group.id +
      "? На следующем cron запись будет проверена заново."
    )) return;

    resetButton.disabled = true;
    statusEl.textContent = "Сбрасываю состояние записи…";
    post("/join-state/reset-group", { groupId: group.id })
      .then((result) => {
        statusEl.textContent =
          "Состояние event " + result.eventId +
          " сброшено. Следующий cron попробует записать игроков заново.";
      })
      .catch((err) => {
        statusEl.textContent = "Не удалось сбросить состояние: " + err;
      })
      .finally(() => {
        resetButton.disabled = false;
      });
    return;
  }

  const button = e.target.closest("[data-remove-group]");
  if (!button) return;
  collectGroups();
  groups.splice(Number(button.dataset.removeGroup), 1);
  renderGroups();
});

groupsEl.addEventListener("change", (e) => {
  const teamSelect = e.target.closest("[data-team-leader], [data-team-partner]");
  if (teamSelect) {
    teamSelect.closest("[data-team-row]").dataset.teamId = crypto.randomUUID();
  }
  const doublesToggle = e.target.closest("[data-group-doubles]");
  if (!doublesToggle) return;
  const row = doublesToggle.closest(".group-row");
  row.querySelector("[data-doubles-config]").hidden = !doublesToggle.checked;
});

document.getElementById("addGroup").addEventListener("click", () => {
  collectGroups();
  groups.push({
    id: "",
    enabled: true,
    joinSingles: true,
    joinDoubles: false,
    doublesTeams: [],
  });
  renderGroups();
  groupsEl.querySelector(".group-row:last-child [data-group-id]")?.focus();
});

resumeMonitoringEl.addEventListener("click", async () => {
  resumeMonitoringEl.disabled = true;
  statusEl.textContent = "Снимаю паузу…";
  try {
    const result = await post("/schedule/resume", {});
    schedule = result.schedule;
    renderPause();
    statusEl.textContent = "Пауза снята. Мониторинг продолжится по расписанию.";
    await refreshApplicationStatus();
  } catch (err) {
    statusEl.textContent = "Не удалось снять паузу: " + err;
  } finally {
    resumeMonitoringEl.disabled = false;
  }
});

async function post(path, body) {
  const res = await fetch(path + "?secret=" + encodeURIComponent(SECRET), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || ("HTTP " + res.status));
  return result;
}

document.getElementById("save").addEventListener("click", async () => {
  collect();
  collectSchedule();
  collectGroups();
  statusEl.textContent = "Сохраняю…";
  try {
    const r = await post("/players", { people, schedule, groups });
    groups = r.groups;
    renderGroups();
    schedule = r.schedule;
    renderPause();
    const activeDays = Object.values(r.schedule.days).filter(Boolean).length;
    const enabledGroups = r.groups.filter((group) => group.enabled).length;
    statusEl.textContent = "Сохранено: " + r.count + " чел., групп включено: " + enabledGroups + "/" + r.groups.length + ", активных дней: " + activeDays + ".";
    await refreshApplicationStatus();
  } catch (err) {
    statusEl.textContent = "Ошибка сохранения: " + err;
  }
});

document.getElementById("test").addEventListener("click", async () => {
  collect();
  collectSchedule();
  collectGroups();
  statusEl.textContent = "Сохраняю и запускаю тест… (может занять до минуты)";
  outputEl.hidden = true;
  try {
    await post("/players", { people, schedule, groups });
    const r = await post("/join-test", {});
    outputEl.hidden = false;
    outputEl.textContent = JSON.stringify(r, null, 2);
    statusEl.textContent = r.ok ? "✅ Записано: " + (r.joinedCount || 0) + "/" + (r.totalCount || 0) : "⚠️ См. результат ниже";
    await refreshApplicationStatus();
  } catch (err) {
    statusEl.textContent = "Ошибка теста: " + err;
  }
});

render();
renderSchedule();
renderGroups();
renderPause();
refreshApplicationStatus();
refreshOperationLogs();
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function sendTelegramMessage(env: Env, chatId: string, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.log("Telegram bot token is not configured.");
    return;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
  }
}

async function sendTelegramPhoto(
  env: Env,
  chatId: string,
  image: Uint8Array,
  caption?: string,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.log("Telegram bot token is not configured.");
    return;
  }

  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) {
    form.append("caption", caption.slice(0, 1024));
  }
  form.append("photo", new Blob([image as unknown as BlobPart], { type: "image/png" }), "screenshot.png");

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`,
    { method: "POST", body: form },
  );

  if (!response.ok) {
    console.error(`Telegram sendPhoto failed: ${response.status} ${await response.text()}`);
  }
}

async function notifyIfEventsAppeared(
  env: Env,
  result: CheckResult,
  log: OperationalLogger,
): Promise<void> {
  const stateKey = `${LAST_HAS_EVENTS_KEY}:${result.groupId}`;
  let previousValue = await env.MONITOR_STATE.get(stateKey);
  if (previousValue === null && result.groupId === fallbackGroupId(env)) {
    previousValue = await env.MONITOR_STATE.get(LAST_HAS_EVENTS_KEY);
    if (previousValue !== null) {
      await env.MONITOR_STATE.put(stateKey, previousValue);
    }
  }
  const currentValue = eventNotificationState(result.events);
  const stateChanged = previousValue !== currentValue;

  log("event_notification_evaluated", {
    groupId: result.groupId,
    eventIds: result.events.map((event) => event.id),
    stateChanged,
    hasEvents: result.hasEvents,
  });

  if (stateChanged) {
    await env.MONITOR_STATE.put(stateKey, currentValue);
  }

  if (!result.hasEvents || !stateChanged) {
    log("telegram_notification_skipped", {
      groupId: result.groupId,
      reason: !result.hasEvents ? "No events." : "Event set did not change.",
    });
    return;
  }

  // Upgrade the old boolean state without sending a duplicate notification
  // for events that were already announced before this deployment.
  if (previousValue === "true") {
    log("telegram_notification_skipped", {
      groupId: result.groupId,
      reason: "Migrated legacy boolean event state without duplicate notification.",
    });
    return;
  }

  const chatId = await env.MONITOR_STATE.get(TELEGRAM_CHAT_ID_KEY);

  if (!chatId) {
    console.log("Events appeared, but Telegram chat_id is not registered yet.");
    log("telegram_notification_skipped", {
      groupId: result.groupId,
      reason: "Telegram chat ID is not configured.",
    }, "warn");
    return;
  }

  const startedAt = Date.now();
  log("telegram_notification_started", {
    groupId: result.groupId,
    eventIds: result.events.map((event) => event.id),
  });
  try {
    await sendTelegramMessage(
      env,
      chatId,
      formatEventsTelegramMessage(result, result.groupConfig),
    );
    log("telegram_notification_finished", {
      groupId: result.groupId,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    log("telegram_notification_failed", {
      groupId: result.groupId,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }, "error");
    throw error;
  }
}

// Joins one configured event through its per-event Durable Object. Concurrent
// cron/manual calls return "busy" without launching another browser.
async function autoJoinEvent(
  env: Env,
  targetGroupId: string,
  targetGroupUrl: string,
  detectedEvent: EventSummary,
  groupConfig: MonitoredGroup,
  log: OperationalLogger,
): Promise<AutoJoinStatus> {
  const people = buildJoinCandidates(
    await getRoster(env),
    detectedEvent,
    groupConfig,
  );
  if (!people.length) {
    log("autojoin_skipped", {
      groupId: targetGroupId,
      eventId: detectedEvent.id,
      reason: isDoublesEvent(detectedEvent)
        ? "No valid enabled doubles teams are configured."
        : "No enabled players with credentials.",
    }, "warn");
    return "terminal";
  }

  try {
    const minimum = normalizeMinParticipants(groupConfig.minParticipants);
    const coordinator = new JoinCoordinatorClient(
      env.JOIN_COORDINATOR.get(env.JOIN_COORDINATOR.idFromName(detectedEvent.id)),
    );
    const state = await coordinator.getState();
    // Once a batch has started, a later departure must not prevent retries.
    const started = Boolean(state.running) || state.joinedIds.length > 0 ||
      Object.values(state.attemptsByPerson).some((attempts) => attempts > 0);
    if (minimum > 0 && !started && !state.done) {
      const participation = detectedEvent.registeredCount === undefined
        ? await getEventParticipationSnapshot(detectedEvent.id)
        : { registeredCount: detectedEvent.registeredCount, reserveCount: detectedEvent.reserveCount ?? 0 };
      if (participation.registeredCount < minimum) {
        log("autojoin_waiting_for_participants", {
          groupId: targetGroupId,
          eventId: detectedEvent.id,
          registeredCount: participation.registeredCount,
          reserveCount: participation.reserveCount,
          minParticipants: minimum,
          intervalMs: MONITOR_POLL_INTERVAL_MS,
        });
        return "retry";
      }
    }
  } catch (error) {
    log("autojoin_participation_check_failed", {
      groupId: targetGroupId,
      eventId: detectedEvent.id,
      error: error instanceof Error ? error.message : String(error),
    }, "error");
    return "retry";
  }

  log("autojoin_event_selected", {
    groupId: targetGroupId,
    eventId: detectedEvent.id,
    eventTitle: detectedEvent.title,
    eventDate: detectedEvent.date,
    playerCount: people.length,
  });

  const chatId = await env.MONITOR_STATE.get(TELEGRAM_CHAT_ID_KEY);
  let outcome: Awaited<ReturnType<typeof joinFirstAvailableEvent>>;

  try {
    const debugScreenshots = env.JOIN_DEBUG_SCREENSHOTS === "true";
    outcome = await joinFirstAvailableEvent(
      targetGroupId,
      targetGroupUrl,
      env,
      debugScreenshots,
      false,
      log,
      detectedEvent,
      groupConfig,
    );
  } catch (error) {
    console.error("Auto-join coordinator failed:", error);
    log("autojoin_failed", {
      groupId: targetGroupId,
      eventId: detectedEvent.id,
      error: error instanceof Error ? error.message : String(error),
    }, "error");
    return "retry";
  }

  if (!("coordinatorStatus" in outcome) || !outcome.event) {
    return "retry";
  }
  if (outcome.coordinatorStatus === "busy" || outcome.coordinatorStatus === "complete") {
    log("autojoin_skipped", {
      groupId: targetGroupId,
      eventId: outcome.event.id,
      reason: outcome.coordinatorStatus === "busy"
        ? "Another invocation owns the event lease."
        : "All enabled players are already complete.",
      coordinatorStatus: outcome.coordinatorStatus,
    });
    return outcome.coordinatorStatus === "complete" ? "complete" : "retry";
  }

  const eventLabel = outcome.event.title || outcome.event.date || outcome.event.id;
  const state = outcome.coordinatorState;
  const joinedIds = state?.joinedIds || [];

  if (outcome.completedNow) {
    const joinedNames = people.map((person) => person.name || person.email).join(", ");
    console.log(`Auto-join complete for ${outcome.event.id}: ${joinedNames}`);
    log("autojoin_completed", {
      groupId: targetGroupId,
      eventId: outcome.event.id,
      joinedCount: outcome.joinedCount,
      totalCount: outcome.totalCount,
    });
    if (chatId) {
      await sendTelegramMessage(
        env,
        chatId,
        `✅ Записал на ивент ${eventLabel}: ${joinedNames}.\n${targetGroupUrl}`,
      );
    }
    return "complete";
  }

  const stillMissing = people.filter((person) => !joinedIds.includes(person.id));
  const reason =
    outcome.reason ||
    outcome.results
      .filter((result) => !result.ok)
      .map((result) => `${result.name || result.email}: ${result.reason || "?"}`)
      .join("; ") ||
    "неизвестно";
  console.warn(`Auto-join incomplete for ${outcome.event.id}: ${reason}`);

  const missingAttempts = stillMissing.map(
    (person) => state?.attemptsByPerson[person.id] || 0,
  );
  const firstFailure = missingAttempts.some((attempts) => attempts === 1);
  const exhausted =
    outcome.coordinatorStatus === "exhausted" ||
    (missingAttempts.length > 0 &&
      missingAttempts.every((attempts) => attempts >= MAX_JOIN_ATTEMPTS));

  // Notify on the first per-person failure and when all remaining people exhaust
  // their retry budget. Busy cron ticks never produce Telegram noise.
  if (chatId && (firstFailure || exhausted)) {
    const missingNames = stillMissing.map((person) => person.name || person.email).join(", ");
    const suffix = exhausted
      ? `Больше не пытаюсь после ${MAX_JOIN_ATTEMPTS} попыток на человека.`
      : "Продолжаю попытки только для оставшихся.";
    await sendTelegramMessage(
      env,
      chatId,
      `⚠️ Ивент ${eventLabel}: не записаны ${missingNames}. ${reason}\n${suffix} ${targetGroupUrl}`,
    );
  }
  return exhausted ? "terminal" : "retry";
}

async function autoJoinIfEventAppeared(
  env: Env,
  targetGroupId: string,
  targetGroupUrl: string,
  detectedEvents: EventSummary[],
  groupConfig: MonitoredGroup,
  log: OperationalLogger,
  onEventStatus?: (event: EventSummary, status: AutoJoinStatus) => void,
  preserveKnownEvents = false,
): Promise<AutoJoinStatus> {
  const events = detectedEvents.filter((event) =>
    isEventEnabledForGroup(event, groupConfig)
  );
  if (!events.length) {
    await saveActiveJoinEventIds(env, targetGroupId, []);
    log("autojoin_skipped", {
      groupId: targetGroupId,
      eventIds: detectedEvents.map((event) => event.id),
      reason: "All detected event types are disabled in group settings.",
    });
    return "terminal";
  }

  await saveActiveJoinEventIds(
    env,
    targetGroupId,
    preserveKnownEvents
      ? [...await getActiveJoinEventIds(env, targetGroupId), ...events.map((event) => event.id)]
      : events.map((event) => event.id),
  );

  const statuses: AutoJoinStatus[] = [];
  for (const event of events) {
    const status = await autoJoinEvent(
      env,
      targetGroupId,
      targetGroupUrl,
      event,
      groupConfig,
      log,
    );
    statuses.push(status);
    onEventStatus?.(event, status);
  }
  if (statuses.includes("retry")) return "retry";
  return statuses.every((status) => status === "complete") ? "complete" : "terminal";
}

interface PendingMonitorEvent {
  groupId: string;
  event: EventSummary;
}

interface MonitorCheckOutcome {
  pendingEvents: PendingMonitorEvent[];
  copySeeds: CopySeedsByGroup;
  groupCount: number;
  eventCount: number;
  hadErrors: boolean;
}

const noopOperationalLogger: OperationalLogger = () => undefined;

async function executeMonitorCheck(
  env: Env,
  ctx: WaitUntilContext,
  options: {
    trigger: string;
    scheduledTime: number;
    persistRoutineLog: boolean;
    discover: boolean;
    pendingEvents: PendingMonitorEvent[];
    copySeeds: CopySeedsByGroup;
  },
): Promise<MonitorCheckOutcome> {
  const startedAt = Date.now();
  const runId = `monitor-${options.scheduledTime}-${crypto.randomUUID().slice(0, 8)}`;
  const groups = (await getMonitoredGroups(env)).filter((group) => group.enabled);
  const copySeeds = { ...options.copySeeds };
  const pending = new Map(options.pendingEvents
    .filter((item) => groups.some((group) => group.id === item.groupId))
    .map((item) => [`${item.groupId}:${item.event.id}`, item]));
  const results: CheckResult[] = options.discover
    ? await checkMonitoredGroupEvents(env, groups)
    : await Promise.all(groups.filter((group) =>
      Array.from(pending.values()).some((item) => item.groupId === group.id)
    ).map(async (group): Promise<CheckResult> => {
      const base = {
        checkedAt: new Date().toISOString(),
        groupId: group.id,
        groupUrl: groupUrl(group.id),
        groupConfig: group,
        source: "firestore" as const,
      };
      try {
        const events = (await Promise.all(Array.from(pending.values())
          .filter((item) => item.groupId === group.id)
          .map((item) => readKnownEvent(group.id, item.event.id))))
          .filter((event) => event !== null);
        const ready = events.filter((event) => event.date);
        return { ...base, ok: true, events: ready, preparingEvents: events.filter((event) => !event.date),
          hasEvents: ready.length > 0,
          emptyStateTextFound: !ready.length, visibleTextPreview: "Known events read directly by ID." };
      } catch (error) {
        return { ...base, ok: false, events: [], hasEvents: false,
          emptyStateTextFound: false, visibleTextPreview: "Known event read failed.",
          error: error instanceof Error ? error.message : String(error) };
      }
    }));
  if (options.discover) {
    await Promise.all(results.filter((result) => result.ok).map(async (result) => {
      const candidates = new Map(result.events.map((event) => [event.id, event]));
      try {
        const discovered = await discoverEventCopies(result.groupId, copySeeds[result.groupId] || [],
          getLisbonDateTimeString());
        copySeeds[result.groupId] = discovered.seeds;
        result.copyQueryCount = discovered.copyQueryCount;
        for (const event of discovered.candidates) {
          if (!candidates.has(event.id)) candidates.set(event.id, event);
        }
      } catch (error) {
        result.copyDiscoveryError = error instanceof Error ? error.message : String(error);
      }
      // Keep undated candidates from the durable queue even when they no longer
      // appear in the parent queries or discovery temporarily fails.
      for (const item of pending.values()) {
        if (item.groupId !== result.groupId || candidates.has(item.event.id)) continue;
        try {
          const event = await readKnownEvent(result.groupId, item.event.id);
          if (event) candidates.set(event.id, event);
        } catch (error) {
          result.copyDiscoveryError = error instanceof Error ? error.message : String(error);
        }
      }
      result.events = Array.from(candidates.values()).filter((event) => event.date)
        .sort((a, b) => a.date!.localeCompare(b.date!));
      result.preparingEvents = Array.from(candidates.values()).filter((event) => !event.date);
      result.hasEvents = result.events.length > 0;
      result.emptyStateTextFound = !result.hasEvents;
    }));
  }
  const hadErrors = results.some((result) => !result.ok || result.copyDiscoveryError);
  const eventCount = results.reduce((count, result) => count + result.events.length, 0);
  const preparingCount = results.reduce((count, result) => count + (result.preparingEvents?.length || 0), 0);
  const interesting = hadErrors || eventCount > 0 || preparingCount > 0;
  const log = interesting || options.persistRoutineLog
    ? createOperationalLogger(env, ctx, { runId, trigger: options.trigger })
    : noopOperationalLogger;

  if (!results.length) {
    if (options.persistRoutineLog) {
      log("monitor_polling_skipped", {
        reason: "No enabled monitored groups configured.",
        intervalMs: MONITOR_POLL_INTERVAL_MS,
      }, "warn");
    }
    return {
      pendingEvents: [],
      copySeeds,
      groupCount: 0,
      eventCount: 0,
      hadErrors: false,
    };
  }

  if (!interesting) {
    for (const result of results) {
      await notifyIfEventsAppeared(env, result, noopOperationalLogger);
    }
    if (options.persistRoutineLog) {
      log("monitor_polling_healthy", {
        groupCount: results.length,
        intervalMs: options.discover ? MONITOR_DISCOVERY_INTERVAL_MS : MONITOR_POLL_INTERVAL_MS,
        durationMs: Date.now() - startedAt,
      });
    }
    console.log(`No Racket events found in ${results.length} monitored group(s).`);
    return {
      pendingEvents: [],
      copySeeds,
      groupCount: results.length,
      eventCount: 0,
      hadErrors: false,
    };
  }

  log("monitor_check_started", {
    intervalMs: options.discover ? MONITOR_DISCOVERY_INTERVAL_MS : MONITOR_POLL_INTERVAL_MS,
    discovery: options.discover,
    scheduledTime: options.scheduledTime,
  });
  for (const result of results) {
    if (!result.ok) {
      log("group_check_failed", {
        groupId: result.groupId,
        error: result.error,
      }, "error");
      console.error(
        `Racket event check failed for group ${result.groupId}: ${result.error || "unknown error"}`,
      );
      continue;
    }

    if (result.copyDiscoveryError) {
      log("copy_discovery_failed", { groupId: result.groupId, error: result.copyDiscoveryError }, "error");
    }
    for (const [key, item] of pending) {
      if (item.groupId === result.groupId && !result.copyDiscoveryError) pending.delete(key);
    }

    log("group_check_finished", {
      groupId: result.groupId,
      hasEvents: result.hasEvents,
      eventCount: result.events.length,
      durationMs: Date.now() - startedAt,
    });
    if (options.discover) await notifyIfEventsAppeared(env, result, log);

    const groupConfig = result.groupConfig || {
      id: result.groupId, enabled: true, joinSingles: true, joinDoubles: false, doublesTeams: [],
    };
    if (options.discover) log("copy_discovery_finished", {
      groupId: result.groupId, seedCount: copySeeds[result.groupId]?.length || 0,
      copyQueryCount: result.copyQueryCount, eventIds: result.events.map((event) => event.id),
      preparingEventIds: result.preparingEvents?.map((event) => event.id) || [],
    });
    for (const event of result.preparingEvents || []) {
      if (!isEventEnabledForGroup(event, groupConfig)) continue;
      pending.set(`${result.groupId}:${event.id}`, { groupId: result.groupId, event });
      log("autojoin_waiting_for_date", { groupId: result.groupId, eventId: event.id,
        eventTitle: event.title, intervalMs: MONITOR_POLL_INTERVAL_MS });
    }

    if (!result.hasEvents) {
      continue;
    }

    await autoJoinIfEventAppeared(
      env,
      result.groupId,
      result.groupUrl,
      result.events,
      groupConfig,
      log,
      (event, status) => {
        pending.delete(`${result.groupId}:${event.id}`);
        if (status === "retry") pending.set(`${result.groupId}:${event.id}`, {
          groupId: result.groupId, event,
        });
      },
      !options.discover,
    );
  }

  log("monitor_check_finished", {
    groupCount: results.length,
    eventCount,
    pendingEventCount: pending.size,
    durationMs: Date.now() - startedAt,
  });
  return {
    pendingEvents: Array.from(pending.values()),
    copySeeds,
    groupCount: results.length,
    eventCount,
    hadErrors,
  };
}

export class MonitorScheduler {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET") {
      const schedule = await getSchedule(this.env);
      const windowKey = monitoringWindowKey(schedule);
      const [alarmAt, pending, lastDiscoveryAt] = await Promise.all([
        this.state.storage.getAlarm(),
        this.state.storage.get<PendingMonitorEvent[]>(MONITOR_PENDING_EVENTS_KEY),
        this.state.storage.get<number>(MONITOR_LAST_DISCOVERY_KEY),
      ]);
      return jsonResponse({
        active: Boolean(windowKey),
        mode: !windowKey
          ? "idle"
          : pending?.length ? "10s" : "minute",
        alarmAt,
        windowKey,
        pendingEventCount: pending?.length || 0,
        lastDiscoveryAt: lastDiscoveryAt ?? null,
        discoveryIntervalMs: MONITOR_DISCOVERY_INTERVAL_MS,
        participantIntervalMs: MONITOR_POLL_INTERVAL_MS,
      });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, { status: 405 });
    }

    if (url.pathname === "/reset-fast") {
      await this.state.storage.delete(MONITOR_LAST_DISCOVERY_KEY);
      await this.state.storage.deleteAlarm();
    }

    const schedule = await getSchedule(this.env);
    const windowKey = monitoringWindowKey(schedule);
    if (!windowKey) {
      await this.state.storage.deleteAlarm();
      return jsonResponse({ ok: true, active: false, mode: "idle" });
    }

    const [alarmAt, pending] = await Promise.all([
      this.state.storage.getAlarm(),
      this.state.storage.get<PendingMonitorEvent[]>(MONITOR_PENDING_EVENTS_KEY),
    ]);
    if (alarmAt === null) {
      await this.state.storage.setAlarm(Date.now() + 100);
    }
    return jsonResponse({
      ok: true,
      active: true,
      mode: pending?.length ? "10s" : "minute",
      alarmAt: alarmAt ?? Date.now() + 100,
    });
  }

  async alarm(): Promise<void> {
    const alarmStartedAt = Date.now();
    const schedule = await getSchedule(this.env);
    const windowKey = monitoringWindowKey(schedule, new Date(alarmStartedAt));
    if (!windowKey) return;

    let pending = await this.state.storage.get<PendingMonitorEvent[]>(MONITOR_PENDING_EVENTS_KEY) || [];
    let lastDiscoveryAt = await this.state.storage.get<number>(MONITOR_LAST_DISCOVERY_KEY);
    const discover = lastDiscoveryAt === undefined ||
      alarmStartedAt - lastDiscoveryAt >= MONITOR_DISCOVERY_INTERVAL_MS;
    if (discover) {
      lastDiscoveryAt = alarmStartedAt;
      await this.state.storage.put(MONITOR_LAST_DISCOVERY_KEY, lastDiscoveryAt);
    }
    const minuteBucket = Math.floor(alarmStartedAt / 60_000);
    const previousRoutineLogMinute = await this.state.storage.get<number>(
      MONITOR_ROUTINE_LOG_MINUTE_KEY,
    );
    const persistRoutineLog = previousRoutineLogMinute !== minuteBucket;
    if (persistRoutineLog) {
      await this.state.storage.put(MONITOR_ROUTINE_LOG_MINUTE_KEY, minuteBucket);
    }

    try {
      const outcome = await executeMonitorCheck(this.env, this.state, {
        trigger: discover ? "discovery-minute" : "alarm-10s",
        scheduledTime: alarmStartedAt,
        persistRoutineLog,
        discover,
        pendingEvents: pending,
        copySeeds: await this.state.storage.get<CopySeedsByGroup>(MONITOR_COPY_SEEDS_KEY) || {},
      });
      pending = outcome.pendingEvents;
      await this.state.storage.put(MONITOR_PENDING_EVENTS_KEY, pending);
      await this.state.storage.put(MONITOR_COPY_SEEDS_KEY, outcome.copySeeds);
    } catch (error) {
      const runId = `alarm-${alarmStartedAt}-${crypto.randomUUID().slice(0, 8)}`;
      const log = createOperationalLogger(this.env, this.state, {
        runId,
        trigger: discover ? "discovery-minute" : "alarm-10s",
      });
      log("monitor_check_failed", {
        intervalMs: discover ? MONITOR_DISCOVERY_INTERVAL_MS : MONITOR_POLL_INTERVAL_MS,
        durationMs: Date.now() - alarmStartedAt,
        error: error instanceof Error ? error.message : String(error),
      }, "error");
      console.error("Racket monitor alarm failed:", error);
    }

    const discoveryAlarmAt = Math.max(Date.now() + 100,
      (lastDiscoveryAt ?? alarmStartedAt) + MONITOR_DISCOVERY_INTERVAL_MS);
    await this.state.storage.setAlarm(pending.length
      ? Math.min(nextMonitorAlarmAt(alarmStartedAt), discoveryAlarmAt)
      : discoveryAlarmAt);
  }
}

async function kickMonitorScheduler(env: Env): Promise<void> {
  const id = env.MONITOR_SCHEDULER.idFromName(MONITOR_SCHEDULER_NAME);
  const response = await env.MONITOR_SCHEDULER.get(id).fetch(
    "https://monitor-scheduler.internal/start",
    { method: "POST" },
  );
  if (!response.ok) {
    throw new Error(`Monitor scheduler failed (${response.status}): ${await response.text()}`);
  }
}

async function getMonitorSchedulerState(env: Env) {
  const id = env.MONITOR_SCHEDULER.idFromName(MONITOR_SCHEDULER_NAME);
  const response = await env.MONITOR_SCHEDULER.get(id).fetch("https://monitor-scheduler.internal/");
  if (!response.ok) throw new Error(`Monitor scheduler status failed (${response.status}).`);
  return response.json<{
    active: boolean;
    mode: string;
    pendingEventCount: number;
    lastDiscoveryAt: number | null;
    discoveryIntervalMs: number;
    participantIntervalMs: number;
    alarmAt: number | null;
  }>();
}

async function resetMonitorFastPolling(env: Env): Promise<void> {
  const id = env.MONITOR_SCHEDULER.idFromName(MONITOR_SCHEDULER_NAME);
  const response = await env.MONITOR_SCHEDULER.get(id).fetch(
    "https://monitor-scheduler.internal/reset-fast",
    { method: "POST" },
  );
  if (!response.ok) {
    throw new Error(`Monitor scheduler reset failed (${response.status}): ${await response.text()}`);
  }
}

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const secret = request.headers.get("x-telegram-bot-api-secret-token");
    if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return jsonResponse({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  const update = (await request.json()) as TelegramUpdate;
  const chatId = update.message?.chat?.id;

  if (!chatId) {
    return jsonResponse({ ok: true, ignored: true });
  }

  const chatIdString = String(chatId);
  const previousChatId = await env.MONITOR_STATE.get(TELEGRAM_CHAT_ID_KEY);

  if (previousChatId !== chatIdString) {
    await env.MONITOR_STATE.put(TELEGRAM_CHAT_ID_KEY, chatIdString);
  }

  await sendTelegramMessage(
    env,
    chatIdString,
    "Готово. Я буду писать сюда, когда события появятся в Padel PORTAL.",
  );

  return jsonResponse({ ok: true });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const runId = `http-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const log = createOperationalLogger(env, ctx, {
      runId,
      trigger: url.pathname,
    });

    if (url.pathname === "/telegram") {
      return handleTelegramWebhook(request, env);
    }

    if (url.pathname === "/check") {
      const startedAt = Date.now();
      log("manual_group_check_started");
      const groups = await checkMonitoredGroupEvents(env);
      const events = groups.flatMap((result) =>
        result.events.map((event) => ({
          ...event,
          groupId: result.groupId,
          groupUrl: result.groupUrl,
        })),
      );
      const result = {
        checkedAt: new Date().toISOString(),
        hasEvents: groups.some((group) => group.hasEvents),
        emptyStateTextFound:
          groups.length > 0 &&
          groups.every((group) => group.ok && group.emptyStateTextFound),
        source: "firestore" as const,
        groupCount: groups.length,
        failedGroupCount: groups.filter((group) => !group.ok).length,
        groups,
        events,
        visibleTextPreview: groups.length
          ? `Firestore checked ${groups.length} group(s) and returned ${events.length} upcoming event(s).`
          : "No enabled monitored groups configured.",
      };
      console.log("Manual Racket event check:", JSON.stringify(result));
      log("manual_group_check_finished", {
        groupCount: result.groupCount,
        failedGroupCount: result.failedGroupCount,
        eventCount: events.length,
        durationMs: Date.now() - startedAt,
      }, result.failedGroupCount ? "warn" : "info");
      return jsonResponse(result);
    }

    if (url.pathname === "/logs") {
      const unauthorizedResponse = requireJoinSecret(request, env);
      if (unauthorizedResponse) return unauthorizedResponse;
      if (request.method !== "GET") {
        return jsonResponse(
          { ok: false, error: "Method not allowed" },
          { status: 405 },
        );
      }
      const limit = Math.min(
        1000,
        Math.max(1, Number(url.searchParams.get("limit")) || 500),
      );
      const requestedView = url.searchParams.get("view");
      const view: OperationLogView = ["join", "problems", "events", "all"].includes(
        requestedView || "",
      ) ? requestedView as OperationLogView : "join";
      const id = env.OPERATION_LOGS.idFromName("global");
      return new OperationLogStoreClient(env.OPERATION_LOGS.get(id)).read(limit, view);
    }

    if (url.pathname === "/status") {
      const unauthorizedResponse = requireJoinSecret(request, env);
      if (unauthorizedResponse) {
        return unauthorizedResponse;
      }
      if (request.method !== "GET") {
        return jsonResponse(
          { ok: false, error: "Method not allowed" },
          { status: 405 },
        );
      }

      try {
        return jsonResponse(await getApplicationStatus(env, log));
      } catch (error) {
        log(
          "status_snapshot_failed",
          { error: error instanceof Error ? error.message : String(error) },
          "error",
        );
        return jsonResponse(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 500 },
        );
      }
    }

    if (url.pathname === "/players") {
      const unauthorizedResponse = requireJoinSecret(request, env);
      if (unauthorizedResponse) {
        return unauthorizedResponse;
      }

      if (request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as {
          people?: unknown;
          schedule?: unknown;
          groups?: unknown;
          groupIds?: unknown;
        };
        const people = Array.isArray(body.people)
          ? body.people.map(normalizePerson).filter((person): person is Person => person !== null)
          : [];
        const schedule = normalizeSchedule(body.schedule);
        const [savedSchedule, savedGroups] = await Promise.all([
          getSchedule(env),
          getMonitoredGroups(env),
        ]);
        const submittedSchedule =
          body.schedule && typeof body.schedule === "object"
            ? (body.schedule as Record<string, unknown>)
            : {};
        if (
          !Object.prototype.hasOwnProperty.call(submittedSchedule, "pausedUntil") &&
          savedSchedule.pausedUntil
        ) {
          schedule.pausedUntil = savedSchedule.pausedUntil;
        }

        const submittedGroups =
          body.groups !== undefined ? body.groups : body.groupIds;
        if (submittedGroups !== undefined && !Array.isArray(submittedGroups)) {
          return jsonResponse(
            { ok: false, error: "groups must be an array." },
            { status: 400 },
          );
        }
        const invalidGroups = Array.isArray(submittedGroups)
          ? submittedGroups.filter((value) => {
              const record =
                value && typeof value === "object"
                  ? (value as Record<string, unknown>)
                  : null;
              const idValue = record ? record.id : value;
              if (
                record &&
                record.enabled !== undefined &&
                typeof record.enabled !== "boolean"
              ) {
                return true;
              }
              return (
                typeof idValue !== "string" ||
                (idValue.trim() !== "" &&
                  normalizeMonitoredGroupId(idValue) === null)
              );
            })
          : [];
        if (invalidGroups.length) {
          return jsonResponse(
            {
              ok: false,
              error: "Invalid Racket group ID, URL, or enabled value.",
            },
            { status: 400 },
          );
        }
        const groups =
          submittedGroups === undefined
            ? savedGroups
            : normalizeMonitoredGroups(submittedGroups);
        const doublesSettingsError = validateDoublesTeamSettings(groups, people);
        if (doublesSettingsError) {
          return jsonResponse(
            { ok: false, error: doublesSettingsError },
            { status: 400 },
          );
        }

        await Promise.all([
          saveRoster(env, people),
          saveSchedule(env, schedule),
          saveMonitoredGroups(env, groups),
        ]);
        ctx.waitUntil(
          kickMonitorScheduler(env).catch((error) => {
            console.error("Could not refresh monitor scheduler after settings save:", error);
          }),
        );
        console.log(
          `Settings saved: ${people.length} people; ${groups.filter((group) => group.enabled).length}/${groups.length} groups enabled; schedule days: ${JSON.stringify(schedule.days)}.`,
        );
        log("settings_saved", {
          playerCount: people.length,
          enabledPlayerCount: people.filter((person) => person.enabled).length,
          groupCount: groups.length,
          enabledGroupCount: groups.filter((group) => group.enabled).length,
          scheduleDays: Object.entries(schedule.days)
            .filter(([, enabled]) => enabled)
            .map(([day]) => day),
          startTime: schedule.startTime,
          endTime: schedule.endTime,
        });
        return jsonResponse({
          ok: true,
          count: people.length,
          groups,
          groupIds: groups.map((group) => group.id),
          schedule,
        });
      }

      const secret = request.headers.get("x-join-secret") || url.searchParams.get("secret") || "";
      const [roster, schedule, groups] = await Promise.all([
        getRoster(env),
        getSchedule(env),
        getMonitoredGroups(env),
      ]);
      return renderRosterPage(roster, schedule, groups, secret);
    }

    if (url.pathname === "/schedule/resume") {
      const unauthorizedResponse = requireJoinSecret(request, env);
      if (unauthorizedResponse) {
        return unauthorizedResponse;
      }
      if (request.method !== "POST") {
        return jsonResponse({ ok: false, error: "Method not allowed" }, { status: 405 });
      }

      const schedule = await getSchedule(env);
      delete schedule.pausedUntil;
      await saveSchedule(env, schedule);
      ctx.waitUntil(
        kickMonitorScheduler(env).catch((error) => {
          console.error("Could not restart monitor scheduler after resume:", error);
        }),
      );
      console.log("Monitoring pause removed.");
      return jsonResponse({ ok: true, schedule });
    }

    if (url.pathname === "/join-state/reset-group") {
      const unauthorizedResponse = requireJoinSecret(request, env);
      if (unauthorizedResponse) {
        return unauthorizedResponse;
      }
      if (request.method !== "POST") {
        return jsonResponse({ ok: false, error: "Method not allowed" }, { status: 405 });
      }

      const body = (await request.json().catch(() => ({}))) as { groupId?: unknown };
      const groupId = normalizeMonitoredGroupId(body.groupId);
      if (!groupId) {
        return jsonResponse(
          { ok: false, error: "A valid groupId is required." },
          { status: 400 },
        );
      }

      const eventIds = await getActiveJoinEventIds(env, groupId);
      if (!eventIds.length) {
        return jsonResponse(
          { ok: false, error: "No active event state exists for this group yet." },
          { status: 404 },
        );
      }

      try {
        await Promise.all(eventIds.map((eventId) => {
          const coordinatorId = env.JOIN_COORDINATOR.idFromName(eventId);
          const coordinator = new JoinCoordinatorClient(
            env.JOIN_COORDINATOR.get(coordinatorId),
          );
          return coordinator.reset();
        }));
        await resetMonitorFastPolling(env);
      } catch (error) {
        return jsonResponse(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 409 },
        );
      }

      console.log(`Join state reset manually for group ${groupId}, events ${eventIds.join(", ")}.`);
      return jsonResponse({
        ok: true,
        groupId,
        eventId: eventIds[0],
        eventIds,
      });
    }

    if (url.pathname === "/join-state") {
      const unauthorizedResponse = requireJoinSecret(request, env);
      if (unauthorizedResponse) {
        return unauthorizedResponse;
      }

      const eventId = url.searchParams.get("event")?.trim();
      if (!eventId) {
        return jsonResponse(
          { ok: false, error: "The event query parameter is required." },
          { status: 400 },
        );
      }

      const coordinatorId = env.JOIN_COORDINATOR.idFromName(eventId);
      const coordinator = new JoinCoordinatorClient(env.JOIN_COORDINATOR.get(coordinatorId));
      const state: JoinCoordinatorState = await coordinator.getState();
      return jsonResponse({ ok: true, eventId, state });
    }

    if (url.pathname === "/join-test" || url.pathname === "/join") {
      const unauthorizedResponse = requireJoinSecret(request, env);
      if (unauthorizedResponse) {
        return unauthorizedResponse;
      }

      const isTest = url.pathname === "/join-test";
      const requestedGroupValue = url.searchParams.get("group");
      const requestedGroupId = normalizeMonitoredGroupId(requestedGroupValue);
      if (!isTest && requestedGroupValue !== null && !requestedGroupId) {
        return jsonResponse(
          { ok: false, error: "Invalid Racket group ID or URL." },
          { status: 400 },
        );
      }
      const monitoredGroupIds = isTest
        ? []
        : enabledMonitoredGroupIds(await getMonitoredGroups(env));
      const targetGroupId = isTest
        ? TEST_GROUP_ID
        : requestedGroupId || monitoredGroupIds[0];
      if (!targetGroupId) {
        return jsonResponse(
          { ok: false, error: "No monitored groups configured." },
          { status: 400 },
        );
      }
      const targetGroupUrl = isTest ? TEST_GROUP_URL : groupUrl(targetGroupId);

      try {
        log("manual_join_started", {
          groupId: targetGroupId,
          test: isTest,
        });
        // Manual runs must reconcile with Racket every time. In particular,
        // test organizers can remove players while keeping the same event id.
        const result = await joinFirstAvailableEvent(
          targetGroupId,
          targetGroupUrl,
          env,
          true,
          true,
          log,
        );
        console.log(`Manual Racket join (${url.pathname}):`, JSON.stringify(result));
        return jsonResponse(result);
      } catch (error) {
        log("manual_join_failed", {
          groupId: targetGroupId,
          error: error instanceof Error ? error.message : String(error),
        }, "error");
        console.error(`Manual Racket join (${url.pathname}) failed:`, error);
        return jsonResponse(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 500 },
        );
      }
    }

    return renderHomePage(env);
  },

  async scheduled(controller, env, ctx): Promise<void> {
    const schedule = await getSchedule(env);
    if (!isWithinSchedule(schedule)) {
      return;
    }

    ctx.waitUntil(
      kickMonitorScheduler(env).catch((error) => {
        const runId = `cron-${controller.scheduledTime}-${crypto.randomUUID().slice(0, 8)}`;
        const log = createOperationalLogger(env, ctx, { runId, trigger: "cron" });
        log("monitor_scheduler_kick_failed", {
          cron: controller.cron,
          scheduledTime: controller.scheduledTime,
          error: error instanceof Error ? error.message : String(error),
        }, "error");
        console.error("Could not start monitor scheduler:", error);
      }),
    );

    console.log(`Monitor scheduler accepted cron ${controller.cron}`);
  },
} satisfies ExportedHandler<Env>;
