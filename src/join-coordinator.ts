const STATE_KEY = "join-state";
export const JOIN_LEASE_MS = 3 * 60 * 1000;

export interface JoinCoordinatorState {
  joinedIds: string[];
  attemptsByPerson: Record<string, number>;
  done: boolean;
  running?: {
    token: string;
    expiresAt: number;
  };
  lastError?: string;
  updatedAt: number;
}

export type BeginJoinResult =
  | {
      status: "acquired";
      token: string;
      remainingIds: string[];
      joinedIds: string[];
      attemptsByPerson: Record<string, number>;
      leaseExpiresAt: number;
    }
  | {
      status: "busy";
      joinedIds: string[];
      leaseExpiresAt: number;
    }
  | {
      status: "complete" | "exhausted";
      joinedIds: string[];
      exhaustedIds: string[];
      attemptsByPerson: Record<string, number>;
    };

interface CoordinatorRequest {
  action?: string;
  token?: string;
  personId?: string;
  personIds?: string[];
  maxAttempts?: number;
  now?: number;
  lastError?: string;
}

function emptyState(now = Date.now()): JoinCoordinatorState {
  return {
    joinedIds: [],
    attemptsByPerson: {},
    done: false,
    updatedAt: now,
  };
}

function normalizeState(raw: unknown, now = Date.now()): JoinCoordinatorState {
  if (!raw || typeof raw !== "object") return emptyState(now);
  const record = raw as Partial<JoinCoordinatorState>;
  const attemptsByPerson =
    record.attemptsByPerson && typeof record.attemptsByPerson === "object"
      ? Object.fromEntries(
          Object.entries(record.attemptsByPerson).map(([id, attempts]) => [
            id,
            Math.max(0, Number(attempts) || 0),
          ]),
        )
      : {};

  return {
    joinedIds: Array.isArray(record.joinedIds)
      ? Array.from(new Set(record.joinedIds.map(String).filter(Boolean)))
      : [],
    attemptsByPerson,
    done: record.done === true,
    running:
      record.running &&
      typeof record.running.token === "string" &&
      Number.isFinite(record.running.expiresAt)
        ? {
            token: record.running.token,
            expiresAt: Number(record.running.expiresAt),
          }
        : undefined,
    lastError: typeof record.lastError === "string" ? record.lastError : undefined,
    updatedAt: Number(record.updatedAt) || now,
  };
}

function uniqueIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map(String).map((value) => value.trim()).filter(Boolean)));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export class JoinCoordinator {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      return json(normalizeState(await this.state.storage.get(STATE_KEY)));
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const body = (await request.json().catch(() => ({}))) as CoordinatorRequest;
    const now = Number(body.now) || Date.now();

    return this.state.storage.transaction(async (txn) => {
      const current = normalizeState(await txn.get(STATE_KEY), now);

      switch (body.action) {
        case "begin":
          return this.begin(txn, current, body, now);
        case "heartbeat":
          return this.heartbeat(txn, current, body, now);
        case "start-person":
          return this.startPerson(txn, current, body, now);
        case "mark-joined":
          return this.markJoined(txn, current, body, now);
        case "finish":
          return this.finish(txn, current, body, now);
        case "reset":
          if (current.running && current.running.expiresAt > now) {
            return json({ error: "Join is already running for this event" }, 409);
          }
          await txn.delete(STATE_KEY);
          return json({ ok: true });
        default:
          return json({ error: "Unknown coordinator action" }, 400);
      }
    });
  }

  private async begin(
    txn: DurableObjectTransaction,
    current: JoinCoordinatorState,
    body: CoordinatorRequest,
    now: number,
  ): Promise<Response> {
    const personIds = uniqueIds(body.personIds);
    const maxAttempts = Math.max(1, Number(body.maxAttempts) || 1);

    if (current.running && current.running.expiresAt > now) {
      return json({
        status: "busy",
        joinedIds: current.joinedIds,
        leaseExpiresAt: current.running.expiresAt,
      } satisfies BeginJoinResult);
    }

    const missingIds = personIds.filter((id) => !current.joinedIds.includes(id));
    if (!missingIds.length) {
      const next = { ...current, done: true, running: undefined, updatedAt: now };
      await txn.put(STATE_KEY, next);
      return json({
        status: "complete",
        joinedIds: next.joinedIds,
        exhaustedIds: [],
        attemptsByPerson: next.attemptsByPerson,
      } satisfies BeginJoinResult);
    }

    const remainingIds = missingIds.filter(
      (id) => (current.attemptsByPerson[id] || 0) < maxAttempts,
    );
    const exhaustedIds = missingIds.filter(
      (id) => (current.attemptsByPerson[id] || 0) >= maxAttempts,
    );

    if (!remainingIds.length) {
      const next = { ...current, done: false, running: undefined, updatedAt: now };
      await txn.put(STATE_KEY, next);
      return json({
        status: "exhausted",
        joinedIds: next.joinedIds,
        exhaustedIds,
        attemptsByPerson: next.attemptsByPerson,
      } satisfies BeginJoinResult);
    }

    const token = crypto.randomUUID();
    const expiresAt = now + JOIN_LEASE_MS;
    const next: JoinCoordinatorState = {
      ...current,
      done: false,
      running: { token, expiresAt },
      lastError: undefined,
      updatedAt: now,
    };
    await txn.put(STATE_KEY, next);

    return json({
      status: "acquired",
      token,
      remainingIds,
      joinedIds: next.joinedIds,
      attemptsByPerson: next.attemptsByPerson,
      leaseExpiresAt: expiresAt,
    } satisfies BeginJoinResult);
  }

  private async heartbeat(
    txn: DurableObjectTransaction,
    current: JoinCoordinatorState,
    body: CoordinatorRequest,
    now: number,
  ): Promise<Response> {
    const ownerError = this.ownerError(current, body.token, now);
    if (ownerError) return ownerError;

    const next = this.renew(current, now);
    await txn.put(STATE_KEY, next);
    return json({ ok: true, leaseExpiresAt: next.running!.expiresAt });
  }

  private async startPerson(
    txn: DurableObjectTransaction,
    current: JoinCoordinatorState,
    body: CoordinatorRequest,
    now: number,
  ): Promise<Response> {
    const ownerError = this.ownerError(current, body.token, now);
    if (ownerError) return ownerError;
    if (!body.personId) return json({ error: "personId is required" }, 400);

    const next = this.renew(current, now);
    next.attemptsByPerson = {
      ...next.attemptsByPerson,
      [body.personId]: (next.attemptsByPerson[body.personId] || 0) + 1,
    };
    await txn.put(STATE_KEY, next);
    return json({
      ok: true,
      attempts: next.attemptsByPerson[body.personId],
      leaseExpiresAt: next.running!.expiresAt,
    });
  }

  private async markJoined(
    txn: DurableObjectTransaction,
    current: JoinCoordinatorState,
    body: CoordinatorRequest,
    now: number,
  ): Promise<Response> {
    const ownerError = this.ownerError(current, body.token, now);
    if (ownerError) return ownerError;
    if (!body.personId) return json({ error: "personId is required" }, 400);

    const next = this.renew(current, now);
    next.joinedIds = Array.from(new Set([...next.joinedIds, body.personId]));
    await txn.put(STATE_KEY, next);
    return json({
      ok: true,
      joinedIds: next.joinedIds,
      leaseExpiresAt: next.running!.expiresAt,
    });
  }

  private async finish(
    txn: DurableObjectTransaction,
    current: JoinCoordinatorState,
    body: CoordinatorRequest,
    now: number,
  ): Promise<Response> {
    const ownerError = this.ownerError(current, body.token, now);
    if (ownerError) return ownerError;

    const personIds = uniqueIds(body.personIds);
    const done = personIds.length > 0 && personIds.every((id) => current.joinedIds.includes(id));
    const next: JoinCoordinatorState = {
      ...current,
      done,
      running: undefined,
      lastError: body.lastError || undefined,
      updatedAt: now,
    };
    await txn.put(STATE_KEY, next);
    return json(next);
  }

  private ownerError(
    current: JoinCoordinatorState,
    token: string | undefined,
    now: number,
  ): Response | null {
    if (!current.running || current.running.expiresAt <= now) {
      return json({ error: "Join lease expired" }, 409);
    }
    if (!token || current.running.token !== token) {
      return json({ error: "Join lease is owned by another invocation" }, 409);
    }
    return null;
  }

  private renew(current: JoinCoordinatorState, now: number): JoinCoordinatorState {
    return {
      ...current,
      running: {
        token: current.running!.token,
        expiresAt: now + JOIN_LEASE_MS,
      },
      updatedAt: now,
    };
  }
}

export class JoinCoordinatorClient {
  constructor(private readonly stub: DurableObjectStub) {}

  begin(personIds: string[], maxAttempts: number, now?: number): Promise<BeginJoinResult> {
    return this.call<BeginJoinResult>({
      action: "begin",
      personIds,
      maxAttempts,
      now,
    });
  }

  heartbeat(token: string, now?: number): Promise<{ ok: true; leaseExpiresAt: number }> {
    return this.call({ action: "heartbeat", token, now });
  }

  startPerson(
    token: string,
    personId: string,
    now?: number,
  ): Promise<{ ok: true; attempts: number; leaseExpiresAt: number }> {
    return this.call({ action: "start-person", token, personId, now });
  }

  markJoined(
    token: string,
    personId: string,
    now?: number,
  ): Promise<{ ok: true; joinedIds: string[]; leaseExpiresAt: number }> {
    return this.call({ action: "mark-joined", token, personId, now });
  }

  finish(
    token: string,
    personIds: string[],
    lastError?: string,
    now?: number,
  ): Promise<JoinCoordinatorState> {
    return this.call({
      action: "finish",
      token,
      personIds,
      lastError,
      now,
    });
  }

  getState(): Promise<JoinCoordinatorState> {
    return this.request<JoinCoordinatorState>("GET");
  }

  reset(): Promise<{ ok: true }> {
    return this.call({ action: "reset" });
  }

  private call<T>(body: CoordinatorRequest): Promise<T> {
    return this.request<T>("POST", body);
  }

  private async request<T>(method: string, body?: CoordinatorRequest): Promise<T> {
    const response = await this.stub.fetch("https://join-coordinator.internal/", {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();

    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error || text;
      } catch {
        // Keep the response body as the error message.
      }
      throw new Error(`Join coordinator failed (${response.status}): ${message}`);
    }

    return JSON.parse(text) as T;
  }
}
