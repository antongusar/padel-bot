export type OperationLogLevel = "info" | "warn" | "error";

export interface OperationLogEntry {
  id: string;
  timestamp: string;
  level: OperationLogLevel;
  action: string;
  sequence?: number;
  runId?: string;
  trigger?: string;
  details: Record<string, unknown>;
}

export interface OperationLogInput {
  timestamp?: string;
  level?: OperationLogLevel;
  action?: string;
  sequence?: number;
  runId?: string;
  trigger?: string;
  details?: Record<string, unknown>;
}

export type OperationLogView = "join" | "problems" | "events" | "all";

const LOG_PREFIX = "log:";
const COUNT_KEY = "meta:count";
const MAX_STORED_LOGS = 10_000;
const MAX_STRING_LENGTH = 1000;
const MAX_ARRAY_LENGTH = 50;
const MAX_OBJECT_KEYS = 80;
const MAX_DEPTH = 5;
const SENSITIVE_KEY_PATTERN =
  /password|passwd|token|authorization|cookie|secret|credential|email/i;

export function operationLogMatchesView(
  entry: Pick<OperationLogEntry, "action" | "level" | "details">,
  view: OperationLogView,
): boolean {
  if (view === "all") return true;
  if (view === "problems") return entry.level === "warn" || entry.level === "error";
  if (view === "join") {
    return entry.action === "join_person_started" || entry.action === "manual_join_started" ||
      entry.action === "autojoin_waiting_for_participants" || entry.action === "autojoin_waiting_for_date";
  }
  return (
    (entry.action === "group_check_finished" && entry.details.hasEvents === true) ||
    (entry.action === "event_notification_evaluated" && entry.details.stateChanged === true) ||
    /^telegram_notification_(started|finished|failed)$/.test(entry.action) ||
    /^autojoin_(event_selected|completed|failed|waiting_for_date)$/.test(entry.action)
  );
}

function safeString(value: unknown, maxLength = MAX_STRING_LENGTH): string {
  return String(value ?? "").slice(0, maxLength);
}

function sanitizeValue(value: unknown, depth: number, key = ""): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[redacted]";
  if (depth > MAX_DEPTH) return "[truncated]";
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return safeString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, MAX_OBJECT_KEYS)
        .map(([childKey, childValue]) => [
          childKey,
          sanitizeValue(childValue, depth + 1, childKey),
        ]),
    );
  }
  return safeString(value);
}

export function sanitizeLogDetails(
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return sanitizeValue(details, 0) as Record<string, unknown>;
}

export function normalizeOperationLog(
  input: OperationLogInput,
): OperationLogEntry | null {
  const action = safeString(input.action, 120).trim();
  if (!action) return null;
  const timestamp = new Date(input.timestamp || Date.now()).toISOString();
  const level: OperationLogLevel = ["info", "warn", "error"].includes(
    input.level || "",
  )
    ? input.level!
    : "info";

  return {
    id: crypto.randomUUID(),
    timestamp,
    level,
    action,
    sequence: Number.isFinite(input.sequence)
      ? Math.max(0, Math.floor(input.sequence!))
      : undefined,
    runId: input.runId ? safeString(input.runId, 100) : undefined,
    trigger: input.trigger ? safeString(input.trigger, 60) : undefined,
    details: sanitizeLogDetails(input.details),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export class OperationLogStore {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method === "POST") {
      const input = (await request.json().catch(() => ({}))) as OperationLogInput;
      const entry = normalizeOperationLog(input);
      if (!entry) return json({ error: "action is required" }, 400);

      await this.state.storage.put(
        `${LOG_PREFIX}${entry.timestamp}:${String(entry.sequence || 0).padStart(6, "0")}:${entry.id}`,
        entry,
      );
      const count = (await this.state.storage.get<number>(COUNT_KEY)) || 0;
      const nextCount = count + 1;
      await this.state.storage.put(COUNT_KEY, nextCount);
      if (nextCount > MAX_STORED_LOGS) {
        await this.prune(nextCount - MAX_STORED_LOGS);
      }
      return json({ ok: true, id: entry.id });
    }

    if (request.method === "GET") {
      const url = new URL(request.url);
      const limit = Math.min(
        MAX_STORED_LOGS,
        Math.max(1, Number(url.searchParams.get("limit")) || 300),
      );
      const level = url.searchParams.get("level");
      const action = url.searchParams.get("action");
      const runId = url.searchParams.get("runId");
      const requestedView = url.searchParams.get("view");
      const view: OperationLogView = ["join", "problems", "events", "all"].includes(
        requestedView || "",
      )
        ? requestedView as OperationLogView
        : "all";
      const values = await this.state.storage.list<OperationLogEntry>({
        prefix: LOG_PREFIX,
        reverse: true,
        limit: MAX_STORED_LOGS,
      });
      const allLogs = Array.from(values.values())
        .filter((entry) => !level || entry.level === level)
        .filter((entry) => !action || entry.action === action)
        .filter((entry) => !runId || entry.runId === runId);
      const matchedRunIds = Array.from(new Set(
        allLogs
          .filter((entry) => operationLogMatchesView(entry, view))
          .map((entry) => entry.runId || entry.id),
      ));
      const matchedRunIdSet = new Set(matchedRunIds);
      const logs = allLogs
        .filter((entry) => matchedRunIdSet.has(entry.runId || entry.id))
        .slice(0, limit);
      return json({
        logs,
        view,
        matchedRunCount: matchedRunIds.length,
        storedCount: values.size,
        maxStored: MAX_STORED_LOGS,
      });
    }

    if (request.method === "DELETE") {
      const values = await this.state.storage.list({ prefix: LOG_PREFIX });
      await this.state.storage.delete([...values.keys(), COUNT_KEY]);
      return json({ ok: true, deleted: values.size });
    }

    return json({ error: "Method not allowed" }, 405);
  }

  private async prune(removeCount: number): Promise<void> {
    const oldest = await this.state.storage.list({
      prefix: LOG_PREFIX,
      limit: removeCount,
    });
    if (oldest.size) await this.state.storage.delete([...oldest.keys()]);
    const currentCount = Math.max(
      0,
      ((await this.state.storage.get<number>(COUNT_KEY)) || 0) - oldest.size,
    );
    await this.state.storage.put(COUNT_KEY, currentCount);
  }
}

export class OperationLogStoreClient {
  constructor(private readonly stub: DurableObjectStub) {}

  async append(input: OperationLogInput): Promise<void> {
    const response = await this.stub.fetch("https://operation-logs/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error(`Operation log append failed: ${response.status}`);
    }
  }

  read(limit = 300, view: OperationLogView = "all"): Promise<Response> {
    return this.stub.fetch(
      `https://operation-logs/?limit=${limit}&view=${encodeURIComponent(view)}`,
    );
  }
}
