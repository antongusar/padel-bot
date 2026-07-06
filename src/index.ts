import { launch, type Browser, type Page, type ElementHandle } from "@cloudflare/puppeteer";

interface Env {
  MONITOR_STATE: KVNamespace;
  BROWSER: BrowserRun;
  GROUP_URL: string;
  RACKET_EMAIL?: string;
  RACKET_PASSWORD?: string;
  RACKET_PLAYER_NAMES?: string;
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
const JOIN_STATE_PREFIX = "join:";
const MAX_JOIN_ATTEMPTS = 10;

type JoinOutcome = { ok: boolean; reason?: string };

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

function isMondayInLisbon(date = new Date()): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Lisbon",
    weekday: "short",
  }).format(date);

  return weekday === "Mon";
}

function fieldString(fields: Record<string, { stringValue?: string }> | undefined, field: string) {
  return fields?.[field]?.stringValue;
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
      };
    });
}

async function checkGroupEvents(env: Env): Promise<CheckResult> {
  const groupUrl = env.GROUP_URL || DEFAULT_GROUP_URL;
  const events = await queryGroupEvents(GROUP_ID);

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
    throw new Error("JOIN_SECRET is not configured.");
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

async function signInToRacket(env: Env): Promise<FirebaseAuthResult> {
  if (!env.RACKET_EMAIL || !env.RACKET_PASSWORD) {
    throw new Error("RACKET_EMAIL and RACKET_PASSWORD must be configured.");
  }

  const email = env.RACKET_EMAIL.trim();
  const password = env.RACKET_PASSWORD.trim();
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

  return (await response.json()) as FirebaseAuthResult;
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

  if (users[auth.localId]) {
    return { joined: true, status: "registered" };
  }

  if (reserves.includes(auth.localId)) {
    return { joined: true, status: "reserve" };
  }

  return { joined: false, status: "not_joined" };
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

// Extracts the joined-players text region (between "Sort by join date" and the
// "Reserves"/"Invitations" boundary) and checks whether any of the expected
// names appears there. Region slicing is more robust than picking a container,
// and it excludes reserves and the page header.
function playersRegionProbe(names: string[]) {
  const body = document.body?.innerText || "";
  const startIndex = body.search(/sort by join date/i);
  const region = startIndex === -1 ? body : body.slice(startIndex);
  const endIndex = region.search(/\bReserves\b|\bInvitations\b/i);
  const players = (endIndex === -1 ? region : region.slice(0, endIndex))
    .replace(/\s+/g, " ")
    .trim();

  const lower = players.toLowerCase();
  const matched = names.find((name) => name && lower.includes(name.toLowerCase())) || "";

  return { found: Boolean(matched), matchedName: matched, region: players.slice(0, 500) };
}

// Confirms the join on the already-open event page by finding the expected
// player name(s) in the joined-players list — not by counting, since a real
// event fills up from many people at once.
async function verifyJoinInBrowser(
  page: Page,
  names: string[],
): Promise<{ joined: boolean; matchedName: string; region: string }> {
  const result = await pollPageAction(
    async () => {
      const probe = await page.evaluate(playersRegionProbe, names);
      return probe.found ? probe : null;
    },
    8000,
    1000,
  );

  if (result) {
    return { joined: true, matchedName: result.matchedName, region: result.region };
  }

  const finalProbe = await page.evaluate(playersRegionProbe, names);
  return { joined: false, matchedName: "", region: finalProbe.region };
}

async function joinFirstAvailableEvent(groupId: string, groupUrl: string, env: Env, debug = false) {
  const auth = await signInToRacket(env);
  const displayName = await getRacketDisplayName(auth).catch(() => null);
  const configuredNames = (env.RACKET_PLAYER_NAMES || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const expectedNames = uniqueStrings([displayName || "", ...configuredNames]);
  const events = await queryGroupEvents(groupId, 10);

  if (!events.length) {
    return {
      ok: false,
      reason: "No upcoming events found.",
      events,
    };
  }

  const event = events[0];
  const existingStatus = await getJoinStatus(event.id, auth);

  if (existingStatus.joined) {
    return {
      ok: true,
      alreadyJoined: true,
      groupUrl,
      event,
      userId: auth.localId,
      status: existingStatus.status,
    };
  }

  if (!env.BROWSER) {
    throw new Error("BROWSER binding is not configured.");
  }

  let browser: Browser | undefined;
  let page: Page | undefined;

  const debugChatId = debug ? await env.MONITOR_STATE.get(TELEGRAM_CHAT_ID_KEY) : null;
  const debugShot = async (label: string) => {
    if (!debugChatId || !env.TELEGRAM_BOT_TOKEN || !page) return;
    try {
      const image = (await page.screenshot({ type: "png" })) as Uint8Array;
      await sendTelegramPhoto(env, debugChatId, image, `${label}\n${page.url()}`);
    } catch (error) {
      console.error("Debug screenshot failed:", error);
    }
  };

  try {
    browser = await launch(env.BROWSER, { keep_alive: 60000 });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(groupUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    const loginButton = await tryClickByText(page, [{ text: "Log in to join", exact: true }], 15000);
    if (!loginButton) {
      await debugShot("Ошибка: не нашёл кнопку «Log in to join»");
      return {
        ok: false,
        reason: "Could not find the Log in to join button.",
        event,
        debug: await collectBrowserDebug(page),
      };
    }

    await fillLoginForm(page, env.RACKET_EMAIL!.trim(), env.RACKET_PASSWORD!.trim());
    await debugShot("1/5 Заполнил форму логина");

    const loginSubmit = await tryClickByText(page, [{ text: "Log in", exact: true }], 15000, true);
    if (!loginSubmit) {
      await debugShot("Ошибка: не нашёл кнопку отправки логина");
      return {
        ok: false,
        reason: "Could not find the login submit button.",
        event,
        debug: await collectBrowserDebug(page),
      };
    }

    const loginResult = await waitForLoginResult(page);
    if (!loginResult || loginResult.startsWith("login-error:")) {
      await debugShot(`Ошибка логина: ${loginResult || "не завершился"}`);
      return {
        ok: false,
        reason: loginResult || "Racket login did not complete in the browser.",
        event,
        debug: await collectBrowserDebug(page),
      };
    }

    await sleep(1500);
    await debugShot("2/5 Залогинился");

    const eventClicked = await tryClickEventCard(page, event, 12000);
    if (!eventClicked) {
      await debugShot("Ошибка: не нашёл карточку ивента");
      return {
        ok: false,
        reason: "Could not find the first event card in the browser.",
        event,
        debug: await collectBrowserDebug(page),
      };
    }

    await sleep(1500);
    await debugShot("3/5 Открыл ивент");

    const joinClicked = await tryClickByText(
      page,
      [
        { text: "Join", exact: true },
        { text: "Join event" },
        { text: "Join game" },
        { text: "Join activity" },
      ],
      15000,
    );
    if (!joinClicked) {
      await debugShot("Ошибка: не нашёл кнопку «Join»");
      return {
        ok: false,
        reason: "Could not find the Join button on the event page.",
        event,
        eventClicked,
        debug: await collectBrowserDebug(page),
      };
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

    await sleep(1500);

    // Verify by finding the user personally in the players list (by uid or
    // display name), not by counting — a real event fills up from many people.
    // Firestore is only a secondary fallback.
    const browserCheck = await verifyJoinInBrowser(page, expectedNames);
    const status = browserCheck.joined
      ? await getJoinStatus(event.id, auth).catch(() => ({ joined: false, status: "not_joined" as const }))
      : await waitForJoinStatus(event.id, auth);
    const joined = browserCheck.joined || status.joined;
    const verifiedVia = browserCheck.joined
      ? `browser:${browserCheck.matchedName}`
      : status.joined
        ? "firestore"
        : "none";

    await debugShot(
      joined
        ? `5/5 Готово: запись подтверждена (${verifiedVia})`
        : "5/5 Join нажат, но имя не найдено в списке игроков",
    );

    return {
      ok: joined,
      reason: joined
        ? undefined
        : "Join button was clicked, but the user was not found in the players list (nor Firestore).",
      groupUrl,
      event,
      joinedAt: joined ? getLisbonDateTimeString() : undefined,
      userId: auth.localId,
      displayName,
      expectedNames,
      status: joined ? (status.joined ? status.status : "registered") : "not_joined",
      verifiedVia,
      playersList: browserCheck.region,
      browserSteps: {
        loginButton,
        loginSubmit,
        eventClicked,
        joinClicked,
        confirmClicked,
        finalUrl: await page.url(),
      },
      debug: joined ? undefined : await collectBrowserDebug(page),
    };
  } finally {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
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
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1rem;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f1115; color: #e6e6e6;
    display: flex; justify-content: center;
  }
  main { width: 100%; max-width: 760px; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 .6rem; border-bottom: 1px solid #262a33; padding-bottom: .3rem; }
  .sub { color: #9aa0ab; margin: 0 0 1.5rem; }
  a { color: #6ea8fe; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  code { background: #1b1f27; padding: .1rem .35rem; border-radius: 4px; font-size: .88em; }
  pre { background: #1b1f27; padding: .8rem 1rem; border-radius: 8px; overflow-x: auto; border: 1px solid #262a33; }
  table { width: 100%; border-collapse: collapse; margin-top: .4rem; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid #262a33; vertical-align: top; }
  th { color: #9aa0ab; font-weight: 600; }
  .tag { display: inline-block; padding: .05rem .45rem; border-radius: 999px; font-size: .75rem; background: #223; color: #9cf; margin-left: .4rem; }
  ul { padding-left: 1.2rem; } li { margin: .2rem 0; }
  .foot { margin-top: 2.5rem; color: #6b7280; font-size: .82rem; }
</style>
</head>
<body>
<main>
  <h1>🎾 Racket Events Monitor</h1>
  <p class="sub">Cloudflare Worker: следит за группой в Racket, по понедельникам записывает на появившийся ивент и шлёт скриншоты в Telegram.</p>

  <h2>Что происходит</h2>
  <ul>
    <li>Крон срабатывает <strong>каждую минуту по понедельникам</strong> (Europe/Lisbon).</li>
    <li>Каждый запуск — дешёвая проверка событий через <strong>Firestore</strong> (без браузера).</li>
    <li>Как только появляется ивент — воркер логинится в Racket и <strong>записывает тебя</strong> через реальный браузер (Cloudflare Browser Rendering).</li>
    <li>Запись подтверждается по имени в списке игроков на самой странице ивента.</li>
    <li>Идемпотентность — через KV-флаг <code>join:&lt;eventId&gt;</code>: успех → <code>done</code>, браузер больше не запускается. Неудача → до ${MAX_JOIN_ATTEMPTS} повторов.</li>
    <li>Уведомления и пошаговые скриншоты приходят в Telegram-бот.</li>
  </ul>

  <h2>Эндпоинты</h2>
  <table>
    <tr><th>Путь</th><th>Что делает</th></tr>
    <tr><td><code>/check</code></td><td>Ручная проверка событий через Firestore. Возвращает JSON, браузер не запускает.</td></tr>
    <tr><td><code>/join</code> <span class="tag">secret</span></td><td>Записаться на первый ивент <strong>реальной</strong> группы. Со скриншотами в Telegram.</td></tr>
    <tr><td><code>/join-test</code> <span class="tag">secret</span></td><td>То же, но в <strong>тестовой</strong> группе.</td></tr>
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
    <tr><td>Крон</td><td><code>* 23 * * SUN</code>, <code>* * * * MON</code> (UTC; код сам пропускает всё, кроме понедельника в Лиссабоне)</td></tr>
    <tr><td>KV-ключи</td><td><code>telegram_chat_id</code>, <code>last_has_events</code>, <code>join:&lt;eventId&gt;</code></td></tr>
  </table>

  <p class="foot">Подробности — в <code>README.md</code>. Скриншоты автозаписи можно выключить в <code>src/index.ts</code> (флаг <code>debug</code> у вызова <code>joinFirstAvailableEvent</code> в автозаписи).</p>
</main>
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

// Joins the first upcoming event of the real group when one appears. Idempotent
// across the every-minute cron via a per-event KV flag: "done" once joined, or a
// failed-attempt counter that caps retries so a persistent failure can't burn
// browser minutes all day.
async function autoJoinIfEventAppeared(env: Env): Promise<void> {
  const groupUrl = env.GROUP_URL || DEFAULT_GROUP_URL;
  const events = await queryGroupEvents(GROUP_ID, 10);

  if (!events.length) {
    return;
  }

  const event = events[0];
  const stateKey = `${JOIN_STATE_PREFIX}${event.id}`;
  const state = await env.MONITOR_STATE.get(stateKey);

  if (state === "done") {
    return;
  }

  const failCount = state ? Number(state) || 0 : 0;
  if (failCount >= MAX_JOIN_ATTEMPTS) {
    return;
  }

  const chatId = await env.MONITOR_STATE.get(TELEGRAM_CHAT_ID_KEY);
  let result: JoinOutcome;

  try {
    // debug=true for now: stream step screenshots to Telegram so you can watch
    // the automated join work. Flip to false later to stop the screenshots.
    result = (await joinFirstAvailableEvent(GROUP_ID, groupUrl, env, true)) as JoinOutcome;
  } catch (error) {
    result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const eventLabel = event.date || event.id;

  if (result.ok) {
    await env.MONITOR_STATE.put(stateKey, "done");
    console.log("Auto-join succeeded:", JSON.stringify(result));
    if (chatId) {
      await sendTelegramMessage(env, chatId, `✅ Записал тебя на ивент ${eventLabel}.\n${groupUrl}`);
    }
    return;
  }

  const attempts = failCount + 1;
  await env.MONITOR_STATE.put(stateKey, String(attempts));
  console.warn(`Auto-join attempt ${attempts} failed: ${result.reason || "unknown"}`);

  // Notify only on the first failure and when giving up, to avoid per-minute spam.
  if (chatId && (attempts === 1 || attempts >= MAX_JOIN_ATTEMPTS)) {
    const suffix =
      attempts >= MAX_JOIN_ATTEMPTS
        ? `Больше не пытаюсь (${attempts} попыток). Запишись вручную:`
        : "Пробую ещё каждую минуту. Если что — запишись вручную:";
    await sendTelegramMessage(
      env,
      chatId,
      `⚠️ Ивент ${eventLabel} появился, но записать не вышло: ${result.reason || "unknown"}\n${suffix} ${groupUrl}`,
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

    if (url.pathname === "/join-test" || url.pathname === "/join") {
      const unauthorizedResponse = requireJoinSecret(request, env);
      if (unauthorizedResponse) {
        return unauthorizedResponse;
      }

      const isTest = url.pathname === "/join-test";
      const targetGroupId = isTest ? TEST_GROUP_ID : GROUP_ID;
      const targetGroupUrl = isTest ? TEST_GROUP_URL : env.GROUP_URL || DEFAULT_GROUP_URL;

      try {
        const result = await joinFirstAvailableEvent(targetGroupId, targetGroupUrl, env, true);
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
    if (!isMondayInLisbon()) {
      console.log(`Scheduled check skipped outside Monday in Europe/Lisbon for cron ${controller.cron}`);
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
