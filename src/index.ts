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
import { joinEventViaApi } from "./racket-api-join";

export { JoinCoordinator } from "./join-coordinator";

interface Env {
  MONITOR_STATE: KVNamespace;
  JOIN_COORDINATOR: DurableObjectNamespace;
  BROWSER: BrowserRun;
  GROUP_ID?: string;
  JOIN_DEBUG_SCREENSHOTS?: string;
  JOIN_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

interface CheckResult {
  checkedAt: string;
  ok: boolean;
  groupId: string;
  groupUrl: string;
  hasEvents: boolean;
  emptyStateTextFound: boolean;
  source: "firestore";
  events: EventSummary[];
  visibleTextPreview: string;
  error?: string;
}

interface EventSummary {
  id: string;
  title?: string;
  date?: string;
  teamSignup?: boolean;
  fixedTeams?: boolean;
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

interface FirestoreDocument {
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
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

type JoinOutcome = { ok: boolean; reason?: string };

interface Person {
  id: string;
  name: string;
  email: string;
  password: string;
  enabled: boolean;
}

export interface MonitoredGroup {
  id: string;
  enabled: boolean;
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

type OperationalLogLevel = "info" | "warn" | "error";

function operationalLog(
  action: string,
  details: Record<string, unknown> = {},
  level: OperationalLogLevel = "info",
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
        teamSignup: fieldBool(document.fields, "teamSignup"),
        fixedTeams: fieldBool(document.fields, "fixedTeams"),
      };
    });
}

// Team-signup / fixed-teams events need a partner in the Registration Checkout
// ("Add partner..."), which the join flow does not handle — skip them. The
// Firestore flags are the reliable signal; the title match is a fallback.
const NON_JOINABLE_TITLE_PATTERN = /doubles/i;

function isJoinableEvent(event: EventSummary): boolean {
  if (event.teamSignup || event.fixedTeams) {
    return false;
  }
  return !NON_JOINABLE_TITLE_PATTERN.test(event.title || "");
}

function pickJoinableEvent(events: EventSummary[]): EventSummary | undefined {
  return events.find(isJoinableEvent);
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
    groups.push({
      id,
      enabled: record ? record.enabled !== false : true,
    });
  }
  return groups;
}

export function enabledMonitoredGroupIds(
  groups: MonitoredGroup[],
): string[] {
  return groups.filter((group) => group.enabled).map((group) => group.id);
}

function fallbackGroupId(env: Env): string | null {
  return normalizeMonitoredGroupId(env.GROUP_ID);
}

export function monitoredGroupsFromStoredValue(
  raw: string | null,
  fallbackId: string | null,
): MonitoredGroup[] {
  const fallback = fallbackId ? [{ id: fallbackId, enabled: true }] : [];
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

async function checkGroupEvents(groupId: string): Promise<CheckResult> {
  const targetGroupUrl = groupUrl(groupId);
  const events = await queryGroupEvents(groupId);

  return {
    checkedAt: new Date().toISOString(),
    ok: true,
    groupId,
    groupUrl: targetGroupUrl,
    hasEvents: events.length > 0,
    emptyStateTextFound: events.length === 0,
    source: "firestore",
    events,
    visibleTextPreview: events.length
      ? `Firestore returned ${events.length} upcoming event(s).`
      : "Firestore returned no upcoming events.",
  };
}

async function checkMonitoredGroupEvents(env: Env): Promise<CheckResult[]> {
  const groupIds = enabledMonitoredGroupIds(await getMonitoredGroups(env));
  return Promise.all(
    groupIds.map(async (groupId) => {
      try {
        return await checkGroupEvents(groupId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          checkedAt: new Date().toISOString(),
          ok: false,
          groupId,
          groupUrl: groupUrl(groupId),
          hasEvents: false,
          emptyStateTextFound: false,
          source: "firestore" as const,
          events: [],
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

async function getPeopleToJoin(env: Env): Promise<Person[]> {
  const roster = await getRoster(env);
  // KV array order is the join priority: the first enabled person is joined first.
  return roster.filter(
    (person) => person.enabled && person.email && person.password,
  );
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

async function getApplicationStatus(env: Env) {
  const checkedAt = new Date();
  const [schedule, roster, configuredGroups, browser] = await Promise.all([
    getSchedule(env),
    getRoster(env),
    getMonitoredGroups(env),
    getBrowserRunSnapshot(env),
  ]);
  const enabledGroups = configuredGroups.filter((group) => group.enabled);
  const checks = await Promise.all(
    enabledGroups.map(async (group) => {
      try {
        return await checkGroupEvents(group.id);
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
    .map((check) => pickJoinableEvent(check.events))
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
    checks.map(async (check) => {
      const event = pickJoinableEvent(check.events);
      const [activeEventId, participation] = await Promise.all([
        env.MONITOR_STATE.get(`${ACTIVE_JOIN_EVENT_KEY}:${check.groupId}`),
        event
          ? getEventParticipationSnapshot(event.id).catch(() => null)
          : Promise.resolve(null),
      ]);
      const players = roster.map((person) => {
        if (!person.enabled) {
          return { id: person.id, name: person.name, status: "disabled" };
        }
        if (!event) {
          return { id: person.id, name: person.name, status: "no_event" };
        }
        const auth = authByPerson.get(person.id);
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
        activeEventId,
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
      configuredGroupCount: configuredGroups.length,
      enabledGroupCount: enabledGroups.length,
      enabledPlayerCount: enabledPeople.length,
      liveChecksOk: groups.every((group) => group.ok),
    },
    browser,
    groups,
  };

  operationalLog("status_snapshot", {
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
): Promise<PersonJoinResult> {
  const context = await browser.createBrowserContext();
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
    await debugShot(`Ошибка: ${reason}`);
    return { id: person.id, name: person.name, email: person.email, ok: false, reason };
  };

  try {
    page = await context.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(groupUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await heartbeat();

    const loginButton = await tryClickByText(page, [{ text: "Log in to join", exact: true }], 15000);
    if (!loginButton) {
      return await fail("Не нашёл кнопку «Log in to join».");
    }

    await fillLoginForm(page, person.email.trim(), person.password.trim());
    await debugShot("1/5 Заполнил форму логина");

    const loginSubmit = await tryClickByText(page, [{ text: "Log in", exact: true }], 15000, true);
    if (!loginSubmit) {
      return await fail("Не нашёл кнопку отправки логина.");
    }

    const loginResult = await waitForLoginResult(page);
    if (!loginResult || loginResult.startsWith("login-error:")) {
      return await fail(loginResult || "Логин не завершился в браузере.");
    }

    await heartbeat();
    await sleep(1500);
    await debugShot("2/5 Залогинился");

    const eventClicked = await tryClickEventCard(page, event, 12000);
    if (!eventClicked) {
      return await fail("Не нашёл карточку ивента.");
    }

    await heartbeat();
    await sleep(1500);
    await debugShot("3/5 Открыл ивент");

    const names = uniqueStrings([person.name]);

    // Pre-check: if already in the players list, do not click Join again. This
    // keeps retries idempotent and handles events that hide "Join" once joined.
    const preCheck = await verifyJoinInBrowser(page, names);
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
    let joinClicked = await tryClickByText(page, joinCandidates, 1200);
    if (!joinClicked) {
      const capacity = await getEventCapacity(page);
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

    await sleep(1500);
    await debugShot("4/5 Нажал Join, открылся Registration Checkout");

    // The Registration Checkout modal confirms with its own "Join" button (last match in the DOM).
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
    await heartbeat();
    await sleep(1500);
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
    await page?.close().catch(() => undefined);
    await context.close().catch(() => undefined);
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
) {
  const events = await queryGroupEvents(groupId, 10);
  const event = pickJoinableEvent(events);

  if (!event) {
    return {
      ok: false,
      reason: events.length
        ? "Only doubles events found; skipping (needs a partner)."
        : "No upcoming events found.",
      event: undefined as EventSummary | undefined,
      results: [] as PersonJoinResult[],
    };
  }

  const people = await getPeopleToJoin(env);
  if (!people.length) {
    return {
      ok: false,
      reason: "No enabled players in the roster.",
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
      let auth: FirebaseAuthResult | null = null;
      try {
        auth = await signInToRacket(person.email, person.password);
        const status = await getJoinStatus(event.id, auth);
        if (status.joined) {
          return {
            id: person.id,
            name: person.name,
            email: person.email,
            ok: true,
            verified: true,
            verifiedVia: `firestore:${status.status}`,
            alreadyJoined: true,
            status: status.status,
          };
        }

        const apiJoin = await joinEventViaApi(
          event.id,
          auth,
          getLisbonDateTimeString(),
        );
        if (apiJoin.ok) {
          const verified = await getJoinStatus(event.id, auth);
          if (verified.joined) {
            return {
              id: person.id,
              name: person.name,
              email: person.email,
              ok: true,
              verified: true,
              verifiedVia: `api:${verified.status}`,
              alreadyJoined: apiJoin.alreadyJoined,
              status: verified.status,
            };
          }
          console.warn(
            `Racket API join was not visible after write for ${person.name || person.email}; falling back to browser.`,
          );
        } else {
          console.warn(
            `Racket API join unavailable for ${person.name || person.email}: ${apiJoin.reason || "unknown error"}; falling back to browser.`,
          );
        }
      } catch (error) {
        console.warn(
          `Racket API join failed for ${person.name || person.email}; falling back to browser:`,
          error,
        );
      }

      await heartbeat();
      if (!browser) {
        browser = await launch(env.BROWSER, { keep_alive: 60000 });
      }
      return joinEventForPerson(
        browser,
        event,
        person,
        groupUrl,
        env,
        debugChatId,
        heartbeat,
        auth,
      );
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

  operationalLog(
    "join_batch_finished",
    {
      groupId,
      eventId: event.id,
      coordinatorStatus: batch.status,
      completedNow: batch.completedNow,
      joinedCount,
      totalCount: people.length,
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
  input[type=text], input[type=email], input[type=password] { width: 100%; background: var(--field); border: 1px solid var(--field-border); color: var(--ink); border-radius: 9px; padding: .45rem .55rem; font: inherit; }
  input[type=text]:focus, input[type=email]:focus, input[type=password]:focus, input[type=time]:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(207, 111, 168, .18); }
  input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--accent); }
  .col-priority { width: 104px; text-align: center; white-space: nowrap; }
  .col-enabled { width: 60px; text-align: center; }
  .col-remove { width: 40px; text-align: center; }
  button { font: inherit; font-weight: 600; border: 0; border-radius: 11px; padding: .55rem 1.1rem; cursor: pointer; transition: filter .15s, box-shadow .15s; }
  button:hover { filter: brightness(1.03); }
  .btn-add { background: var(--accent-soft); color: #b6478f; margin-top: 1rem; }
  .group-list { display: grid; gap: .55rem; max-width: 560px; margin-top: .7rem; }
  .group-row { display: grid; grid-template-columns: minmax(0, 1fr) auto 36px 36px; gap: .55rem; align-items: center; }
  .group-row:has([data-group-enabled]:not(:checked)) [data-group-id] { opacity: .58; }
  .group-runtime { grid-column: 1 / -1; display: flex; align-items: flex-start; gap: .5rem; min-width: 0; padding: .1rem .15rem .35rem; }
  .group-runtime-text { min-width: 0; }
  .group-runtime-title { font-size: .84rem; font-weight: 700; }
  .group-runtime-details { color: var(--muted); font-size: .78rem; overflow-wrap: anywhere; }
  .group-enabled { display: inline-flex; align-items: center; gap: .4rem; color: var(--muted); font-size: .86rem; white-space: nowrap; cursor: pointer; }
  .group-row .btn-remove { width: 36px; height: 36px; padding: 0; }
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
  const queueStarted = groupStatus.activeEventId === groupStatus.event.id;
  const eventName = groupStatus.event.title || groupStatus.event.date || groupStatus.event.id;
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
          ' · ' + (group.activeEventId === event.id ? "очередь автозаписи уже запускалась" : "cron ещё не запускал автозапись") +
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
        '</div></div>';
    row.querySelector("[data-group-id]").value = group.id;
    row.querySelector("[data-group-enabled]").checked = group.enabled !== false;
    groupsEl.appendChild(row);
  });
  renderGroupRuntimeStates();
}

function collectGroups() {
  groups = Array.from(groupsEl.querySelectorAll(".group-row"))
    .map((row) => ({
      id: row.querySelector("[data-group-id]").value.trim(),
      enabled: row.querySelector("[data-group-enabled]").checked,
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

document.getElementById("addGroup").addEventListener("click", () => {
  collectGroups();
  groups.push({ id: "", enabled: true });
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

async function notifyIfEventsAppeared(env: Env, result: CheckResult): Promise<void> {
  const stateKey = `${LAST_HAS_EVENTS_KEY}:${result.groupId}`;
  let previousValue = await env.MONITOR_STATE.get(stateKey);
  if (previousValue === null && result.groupId === fallbackGroupId(env)) {
    previousValue = await env.MONITOR_STATE.get(LAST_HAS_EVENTS_KEY);
    if (previousValue !== null) {
      await env.MONITOR_STATE.put(stateKey, previousValue);
    }
  }
  const previousHasEvents = previousValue === "true";
  const currentValue = String(result.hasEvents);
  const stateChanged = previousValue !== currentValue;

  if (stateChanged) {
    await env.MONITOR_STATE.put(stateKey, currentValue);
  }

  if (!result.hasEvents || previousHasEvents) {
    return;
  }

  const chatId = await env.MONITOR_STATE.get(TELEGRAM_CHAT_ID_KEY);

  if (!chatId) {
    console.log("Events appeared, but Telegram chat_id is not registered yet.");
    return;
  }

  await sendTelegramMessage(
    env,
    chatId,
    `События появились в группе ${result.groupId}.\n${result.groupUrl}`,
  );
}

// Joins the first upcoming event through its per-event Durable Object. Concurrent
// cron/manual calls return "busy" without launching another browser.
async function autoJoinIfEventAppeared(
  env: Env,
  targetGroupId: string,
  targetGroupUrl: string,
  detectedEvents: EventSummary[],
): Promise<void> {
  const people = await getPeopleToJoin(env);
  if (!people.length) {
    return;
  }

  const detectedEvent = pickJoinableEvent(detectedEvents);
  if (!detectedEvent) {
    return;
  }

  const activeEventKey = `${ACTIVE_JOIN_EVENT_KEY}:${targetGroupId}`;
  const previousEventId = await env.MONITOR_STATE.get(activeEventKey);
  if (previousEventId !== detectedEvent.id) {
    const coordinatorId = env.JOIN_COORDINATOR.idFromName(detectedEvent.id);
    const coordinator = new JoinCoordinatorClient(env.JOIN_COORDINATOR.get(coordinatorId));
    try {
      await coordinator.reset();
      await env.MONITOR_STATE.put(activeEventKey, detectedEvent.id);
      console.log(
        `Prepared coordinator for event ${detectedEvent.id} in group ${targetGroupId}.`,
      );
    } catch (error) {
      console.warn(
        `Could not prepare coordinator for event ${detectedEvent.id}; retrying next cron:`,
        error,
      );
      return;
    }
  }

  const chatId = await env.MONITOR_STATE.get(TELEGRAM_CHAT_ID_KEY);
  let outcome: Awaited<ReturnType<typeof joinFirstAvailableEvent>>;

  try {
    const debugScreenshots = env.JOIN_DEBUG_SCREENSHOTS === "true";
    outcome = await joinFirstAvailableEvent(
      targetGroupId,
      targetGroupUrl,
      env,
      debugScreenshots,
    );
  } catch (error) {
    console.error("Auto-join coordinator failed:", error);
    return;
  }

  if (!("coordinatorStatus" in outcome) || !outcome.event) {
    return;
  }
  if (outcome.coordinatorStatus === "busy" || outcome.coordinatorStatus === "complete") {
    return;
  }

  const eventLabel = outcome.event.title || outcome.event.date || outcome.event.id;
  const state = outcome.coordinatorState;
  const joinedIds = state?.joinedIds || [];

  if (outcome.completedNow) {
    const joinedNames = people.map((person) => person.name || person.email).join(", ");
    console.log(`Auto-join complete for ${outcome.event.id}: ${joinedNames}`);
    if (chatId) {
      await sendTelegramMessage(
        env,
        chatId,
        `✅ Записал на ивент ${eventLabel}: ${joinedNames}.\n${targetGroupUrl}`,
      );
    }
    return;
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
      : "Пробую ещё каждую минуту только для оставшихся.";
    await sendTelegramMessage(
      env,
      chatId,
      `⚠️ Ивент ${eventLabel}: не записаны ${missingNames}. ${reason}\n${suffix} ${targetGroupUrl}`,
    );
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
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/telegram") {
      return handleTelegramWebhook(request, env);
    }

    if (url.pathname === "/check") {
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
      return jsonResponse(result);
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
        return jsonResponse(await getApplicationStatus(env));
      } catch (error) {
        operationalLog(
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

        await Promise.all([
          saveRoster(env, people),
          saveSchedule(env, schedule),
          saveMonitoredGroups(env, groups),
        ]);
        console.log(
          `Settings saved: ${people.length} people; ${groups.filter((group) => group.enabled).length}/${groups.length} groups enabled; schedule days: ${JSON.stringify(schedule.days)}.`,
        );
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

      const eventId = await env.MONITOR_STATE.get(`${ACTIVE_JOIN_EVENT_KEY}:${groupId}`);
      if (!eventId) {
        return jsonResponse(
          { ok: false, error: "No active event state exists for this group yet." },
          { status: 404 },
        );
      }

      const coordinatorId = env.JOIN_COORDINATOR.idFromName(eventId);
      const coordinator = new JoinCoordinatorClient(env.JOIN_COORDINATOR.get(coordinatorId));
      try {
        await coordinator.reset();
      } catch (error) {
        return jsonResponse(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 409 },
        );
      }

      console.log(`Join state reset manually for group ${groupId}, event ${eventId}.`);
      return jsonResponse({ ok: true, groupId, eventId });
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
        // Manual runs must reconcile with Racket every time. In particular,
        // test organizers can remove players while keeping the same event id.
        const result = await joinFirstAvailableEvent(
          targetGroupId,
          targetGroupUrl,
          env,
          true,
          true,
        );
        console.log(`Manual Racket join (${url.pathname}):`, JSON.stringify(result));
        return jsonResponse(result);
      } catch (error) {
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

    const cronStartedAt = Date.now();
    operationalLog("cron_started", { cron: controller.cron });

    ctx.waitUntil(
      (async () => {
        try {
          const results = await checkMonitoredGroupEvents(env);
          if (!results.length) {
            console.log("Scheduled check skipped: no enabled monitored groups configured.");
            return;
          }

          for (const result of results) {
            if (!result.ok) {
              operationalLog(
                "group_check_failed",
                { groupId: result.groupId, error: result.error },
                "error",
              );
              console.error(
                `Racket event check failed for group ${result.groupId}: ${result.error || "unknown error"}`,
              );
              continue;
            }
            operationalLog("group_check_finished", {
              groupId: result.groupId,
              hasEvents: result.hasEvents,
              eventCount: result.events.length,
              durationMs: Date.now() - cronStartedAt,
            });
            console.log(
              result.hasEvents ? "Racket events found:" : "No Racket events found:",
              JSON.stringify(result),
            );
            await notifyIfEventsAppeared(env, result);

            if (result.hasEvents) {
              await autoJoinIfEventAppeared(
                env,
                result.groupId,
                result.groupUrl,
                result.events,
              );
            }
          }
          operationalLog("cron_finished", {
            cron: controller.cron,
            groupCount: results.length,
            durationMs: Date.now() - cronStartedAt,
          });
        } catch (error) {
          operationalLog(
            "cron_failed",
            {
              cron: controller.cron,
              durationMs: Date.now() - cronStartedAt,
              error: error instanceof Error ? error.message : String(error),
            },
            "error",
          );
          console.error("Racket event check failed:", error);
        }
      })(),
    );

    console.log(`Scheduled check accepted for cron ${controller.cron}`);
  },
} satisfies ExportedHandler<Env>;
