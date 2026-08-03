import { launch, type Browser, type Page, type ElementHandle } from "@cloudflare/puppeteer";
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
  GROUP_URL: string;
  RACKET_EMAIL?: string;
  RACKET_PASSWORD?: string;
  RACKET_PLAYER_NAMES?: string;
  JOIN_DEBUG_SCREENSHOTS?: string;
  JOIN_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

interface CheckResult {
  checkedAt: string;
  groupUrl: string;
  hasEvents: boolean;
  emptyStateTextFound: boolean;
  source: "firestore";
  events: EventSummary[];
  visibleTextPreview: string;
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

const DEFAULT_GROUP_URL = "https://racket.id/groups/4Y4qCwClTWQPAM/";
const GROUP_ID = "4Y4qCwClTWQPAM";
const TEST_GROUP_ID = "IenuPng40UmpsU";
const TEST_GROUP_URL = "https://racket.id/groups/IenuPng40UmpsU";
const FIRESTORE_API_KEY = "AIzaSyBDPghSVKxu2gU-nPdyJJVgoLd7SSVZjZI";
const FIRESTORE_PROJECT_ID = "racket-id";
const LAST_HAS_EVENTS_KEY = "last_has_events";
const TELEGRAM_CHAT_ID_KEY = "telegram_chat_id";
const MAX_JOIN_ATTEMPTS = 10;
const ROSTER_KEY = "roster";
const SCHEDULE_KEY = "schedule";
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

type JoinOutcome = { ok: boolean; reason?: string };

interface Person {
  id: string;
  name: string;
  email: string;
  password: string;
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

async function checkGroupEvents(env: Env): Promise<CheckResult> {
  const groupUrl = env.GROUP_URL || DEFAULT_GROUP_URL;
  const events = await queryGroupEvents(env.GROUP_ID || GROUP_ID);

  return {
    checkedAt: new Date().toISOString(),
    groupUrl,
    hasEvents: events.length > 0,
    emptyStateTextFound: events.length === 0,
    source: "firestore",
    events,
    visibleTextPreview: events.length
      ? `Firestore returned ${events.length} upcoming event(s).`
      : "Firestore returned no upcoming events.",
  };
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

// Falls back to the single env-configured user when the roster is empty, so
// existing setups keep working without a roster.
function envFallbackPerson(env: Env): Person | null {
  if (!env.RACKET_EMAIL || !env.RACKET_PASSWORD) return null;
  const name = (env.RACKET_PLAYER_NAMES || "").split(",")[0]?.trim() || "";
  return {
    id: "env",
    name,
    email: env.RACKET_EMAIL.trim(),
    password: env.RACKET_PASSWORD.trim(),
    enabled: true,
  };
}

async function getPeopleToJoin(env: Env): Promise<Person[]> {
  const roster = await getRoster(env);
  // KV array order is the join priority: the first enabled person is joined first.
  const enabled = roster.filter((person) => person.enabled && person.email && person.password);
  if (enabled.length) return enabled;

  const fallback = envFallbackPerson(env);
  return fallback ? [fallback] : [];
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
  const groupUrl = env.GROUP_URL || DEFAULT_GROUP_URL;
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
  <p class="sub">Cloudflare Worker: следит за группой в Racket, по заданному расписанию записывает игроков на появившийся ивент и сообщает результат в Telegram.</p>

  <h2>Что происходит</h2>
  <ul>
    <li>Крон срабатывает <strong>каждую минуту</strong>, но работает только в <strong>окне расписания</strong> (дни и время задаются на <a href="/players">/players</a>). Ни один день не отмечен — скрипт не запускается.</li>
    <li>Каждый запуск в окне — дешёвая проверка событий через <strong>Firestore</strong> (без браузера).</li>
    <li>Как только появляется ивент — воркер авторизуется в Racket и <strong>записывает включённых игроков</strong> напрямую через Firestore API.</li>
    <li>Запись подтверждается по имени в списке игроков на самой странице ивента.</li>
    <li>Один Durable Object на событие не допускает параллельных запусков. После каждого успешного игрока его id сохраняется немедленно; повторы трогают только оставшихся. Лимит — ${MAX_JOIN_ATTEMPTS} попыток на человека.</li>
    <li>Browser Run остаётся только запасным вариантом для платных, клубных и нестандартных регистраций.</li>
    <li>Результаты приходят в Telegram-бот. Пошаговые скриншоты включены для ручных тестов и опциональны для cron.</li>
  </ul>

  <h2>Эндпоинты</h2>
  <table>
    <tr><th>Путь</th><th>Что делает</th></tr>
    <tr><td><code>/players</code> <span class="tag">secret</span></td><td>Страница управления игроками: кто записывается (логин, пароль, имя, галочка). Оттуда же — тест на тестовой группе.</td></tr>
    <tr><td><code>/check</code></td><td>Ручная проверка событий через Firestore. Возвращает JSON, браузер не запускает.</td></tr>
    <tr><td><code>/join</code> <span class="tag">secret</span></td><td>Записать всех включённых игроков на первый ивент <strong>реальной</strong> группы.</td></tr>
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
<pre>npx wrangler secret put RACKET_EMAIL          # логин Racket
npx wrangler secret put RACKET_PASSWORD       # пароль Racket
npx wrangler secret put RACKET_PLAYER_NAMES   # имена как в Racket, через запятую
npx wrangler secret put JOIN_SECRET           # защита /join и /join-test
npx wrangler secret put TELEGRAM_BOT_TOKEN    # токен бота
npx wrangler secret list                      # посмотреть список</pre>

  <h2>Как проверить запись вручную</h2>
<pre>curl "https://&lt;этот-домен&gt;/join?secret=&lt;JOIN_SECRET&gt;"</pre>
  <p class="sub" style="margin-top:.6rem">Внимание: это <strong>реально записывает</strong> на ближайший ивент, если он есть. В ответе смотри <code>ok</code>, <code>verifiedVia</code>, <code>playersList</code>.</p>

  <h2>Настройки</h2>
  <table>
    <tr><th>Группа</th><td><a href="${groupUrl}">${groupUrl}</a></td></tr>
    <tr><td>Крон</td><td><code>* * * * *</code> (каждую минуту; окно дней/времени задаётся на <a href="/players">/players</a>, часовой пояс Europe/Lisbon)</td></tr>
    <tr><td>KV-ключи</td><td><code>telegram_chat_id</code>, <code>last_has_events</code>, <code>roster</code>, <code>schedule</code></td></tr>
    <tr><td>Join state</td><td>Strongly consistent Durable Object, отдельный экземпляр для каждого <code>eventId</code>.</td></tr>
  </table>

  <h2>Как это устроено</h2>
  <p class="sub" style="margin:.2rem 0 .6rem">Крон срабатывает каждую минуту, но почти всегда мгновенно выходит — тяжёлая работа только в окне расписания и только когда есть ивент.</p>
<pre>каждую минуту:
  читаем расписание            // 1 чтение KV
  окно расписания сейчас?
    нет → выходим              // мгновенно, дёшево
    да  → проверяем события в Firestore   // без браузера
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
    <tr><td>Firestore</td><td>сотни чтений/сутки</td><td>бесплатная квота — 50k/сутки</td></tr>
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

function renderRosterPage(roster: Person[], schedule: Schedule, secret: string): Response {
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
  main { width: 100%; max-width: 860px; background: var(--card); border: 1px solid rgba(255,255,255,.6); border-radius: 24px; padding: 2rem 2rem 2.4rem; box-shadow: 0 18px 50px rgba(190, 120, 170, .22); }
  h1 { font-size: 1.5rem; margin: 0 0 .2rem; }
  .sub { color: var(--muted); margin: 0 0 1.4rem; }
  a { color: var(--accent); }
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
  .btn-save { background: var(--grad); color: #fff; box-shadow: 0 6px 18px rgba(197, 111, 206, .38); }
  .btn-test { background: #fff; color: #c56fce; border: 1.5px solid #eccbe6; }
  .btn-remove { background: transparent; color: #e2849b; font-size: 1.2rem; padding: .1rem .4rem; box-shadow: none; }
  .priority-controls { display: inline-grid; grid-template-columns: 28px 28px; gap: .25rem; justify-content: center; }
  .priority-number { grid-column: 1 / -1; color: var(--muted); font-size: .75rem; line-height: 1; }
  .btn-move { width: 28px; height: 28px; padding: 0; border-radius: 7px; background: var(--accent-soft); color: #b6478f; line-height: 1; }
  .btn-move:disabled { opacity: .35; cursor: default; filter: none; }
  .actions { display: flex; gap: .6rem; margin-top: 1.4rem; flex-wrap: wrap; align-items: center; }
  .status { margin-left: .4rem; color: var(--muted); }
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
</style>
</head>
<body>
<main>
  <h1>👥 Игроки</h1>
  <p class="sub">Кого записывать на ивент. Игроки записываются сверху вниз: кто выше, тот первый. Убери галочку «Записывать», чтобы временно пропускать человека — удалять не нужно. <a href="/">← на главную</a></p>

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

  <button class="btn-add" id="add">+ Добавить человека</button>

  <h2>🗓️ Расписание</h2>
  <p class="sub" style="margin:.2rem 0 .4rem">В какие дни недели и в какое время (по Лиссабону) запускать автозапись. Если ни один день не отмечен — скрипт не запускается.</p>
  <div class="days" id="days"></div>
  <div class="times">
    <label>Начало <input type="time" id="startTime"></label>
    <label>Конец <input type="time" id="endTime"></label>
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

const DAY_LABELS = [["mon","Пн"],["tue","Вт"],["wed","Ср"],["thu","Чт"],["fri","Пт"],["sat","Сб"],["sun","Вс"]];

const rowsEl = document.getElementById("rows");
const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");
const daysEl = document.getElementById("days");
const startEl = document.getElementById("startTime");
const endEl = document.getElementById("endTime");

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
  schedule = { days, startTime: startEl.value || "00:00", endTime: endEl.value || "23:59" };
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

async function post(path, body) {
  const res = await fetch(path + "?secret=" + encodeURIComponent(SECRET), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

document.getElementById("save").addEventListener("click", async () => {
  collect();
  collectSchedule();
  statusEl.textContent = "Сохраняю…";
  try {
    const r = await post("/players", { people, schedule });
    const activeDays = Object.values(r.schedule.days).filter(Boolean).length;
    statusEl.textContent = "Сохранено: " + r.count + " чел., активных дней: " + activeDays + ".";
  } catch (err) {
    statusEl.textContent = "Ошибка сохранения: " + err;
  }
});

document.getElementById("test").addEventListener("click", async () => {
  collect();
  collectSchedule();
  statusEl.textContent = "Сохраняю и запускаю тест… (может занять до минуты)";
  outputEl.hidden = true;
  try {
    await post("/players", { people, schedule });
    const r = await post("/join-test", {});
    outputEl.hidden = false;
    outputEl.textContent = JSON.stringify(r, null, 2);
    statusEl.textContent = r.ok ? "✅ Записано: " + (r.joinedCount || 0) + "/" + (r.totalCount || 0) : "⚠️ См. результат ниже";
  } catch (err) {
    statusEl.textContent = "Ошибка теста: " + err;
  }
});

render();
renderSchedule();
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
  const previousValue = await env.MONITOR_STATE.get(LAST_HAS_EVENTS_KEY);
  const previousHasEvents = previousValue === "true";
  const currentValue = String(result.hasEvents);
  const stateChanged = previousValue !== currentValue;

  if (stateChanged) {
    await env.MONITOR_STATE.put(LAST_HAS_EVENTS_KEY, currentValue);
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
    `События появились в Padel PORTAL.\n${result.groupUrl}`,
  );
}

// Joins the first upcoming event through its per-event Durable Object. Concurrent
// cron/manual calls return "busy" without launching another browser.
async function autoJoinIfEventAppeared(env: Env): Promise<void> {
  const groupId = env.GROUP_ID || GROUP_ID;
  const groupUrl = env.GROUP_URL || DEFAULT_GROUP_URL;
  const people = await getPeopleToJoin(env);
  if (!people.length) {
    return;
  }

  const chatId = await env.MONITOR_STATE.get(TELEGRAM_CHAT_ID_KEY);
  let outcome: Awaited<ReturnType<typeof joinFirstAvailableEvent>>;

  try {
    const debugScreenshots = env.JOIN_DEBUG_SCREENSHOTS === "true";
    outcome = await joinFirstAvailableEvent(groupId, groupUrl, env, debugScreenshots);
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
      await sendTelegramMessage(env, chatId, `✅ Записал на ивент ${eventLabel}: ${joinedNames}.\n${groupUrl}`);
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
      `⚠️ Ивент ${eventLabel}: не записаны ${missingNames}. ${reason}\n${suffix} ${groupUrl}`,
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
      const result = await checkGroupEvents(env);
      console.log("Manual Racket event check:", JSON.stringify(result));
      return jsonResponse(result);
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
        };
        const people = Array.isArray(body.people)
          ? body.people.map(normalizePerson).filter((person): person is Person => person !== null)
          : [];
        const schedule = normalizeSchedule(body.schedule);
        const savedSchedule = await getSchedule(env);
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
        await saveRoster(env, people);
        await saveSchedule(env, schedule);
        console.log(`Roster saved: ${people.length} people; schedule days: ${JSON.stringify(schedule.days)}.`);
        return jsonResponse({ ok: true, count: people.length, schedule });
      }

      const secret = request.headers.get("x-join-secret") || url.searchParams.get("secret") || "";
      const [roster, schedule] = await Promise.all([getRoster(env), getSchedule(env)]);
      return renderRosterPage(roster, schedule, secret);
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
      const targetGroupId = isTest ? TEST_GROUP_ID : env.GROUP_ID || GROUP_ID;
      const targetGroupUrl = isTest ? TEST_GROUP_URL : env.GROUP_URL || DEFAULT_GROUP_URL;

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

    ctx.waitUntil(
      (async () => {
        try {
          const result = await checkGroupEvents(env);
          console.log(
            result.hasEvents ? "Racket events found:" : "No Racket events found:",
            JSON.stringify(result),
          );
          await notifyIfEventsAppeared(env, result);

          if (result.hasEvents) {
            await autoJoinIfEventAppeared(env);
          }
        } catch (error) {
          console.error("Racket event check failed:", error);
        }
      })(),
    );

    console.log(`Scheduled check accepted for cron ${controller.cron}`);
  },
} satisfies ExportedHandler<Env>;
