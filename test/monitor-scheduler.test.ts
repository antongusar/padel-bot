import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MonitorScheduler, type Schedule } from "../src/index";
import { JoinCoordinatorClient } from "../src/join-coordinator";

vi.mock("@cloudflare/puppeteer", () => ({
  launch: vi.fn().mockRejectedValue(new Error("Browser fallback disabled in tests")),
  history: vi.fn(),
  limits: vi.fn(),
  sessions: vi.fn(),
}));

const SCHEDULE_KEY = "schedule";
const MONITORED_GROUPS_KEY = "monitored_groups";
const MONITOR_POLL_INTERVAL_MS = 10_000;

function alwaysActiveSchedule(enabled: boolean): Schedule {
  return {
    days: {
      mon: enabled,
      tue: enabled,
      wed: enabled,
      thu: enabled,
      fri: enabled,
      sat: enabled,
      sun: enabled,
    },
    startTime: "00:00",
    endTime: "23:59",
  };
}

describe("ten-second monitor scheduler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function participantMonitor(
    test: (controls: {
      tick: () => Promise<void>;
      state: () => ReturnType<JoinCoordinatorClient["getState"]>;
      setCount: (count: number) => void;
      hide: () => void;
      hideInitially: () => void;
      setDate: (ready: boolean) => void;
      failCopies: (failed: boolean) => void;
      clearSeedGroup: () => void;
      failRead: (failed: boolean) => void;
      writes: () => number;
      logins: () => number;
      copyQueries: () => number;
      dropSession: () => Promise<void>;
      failLogins: (failed: boolean) => void;
      requests: () => { group: number; direct: number };
      advance: (ms: number) => void;
      complete: () => Promise<void>;
      addEvent: () => void;
      mode: () => Promise<string>;
      durableQueue: () => Promise<number>;
      restart: () => Promise<void>;
    }) => Promise<void>,
  ) {
    const groupId = `threshold-${crypto.randomUUID()}`;
    const eventId = `event-${crypto.randomUUID()}`;
    const keys = [SCHEDULE_KEY, MONITORED_GROUPS_KEY, "roster"];
    const previous = await Promise.all(keys.map((key) => env.MONITOR_STATE.get(key)));
    const stub = env.MONITOR_SCHEDULER.getByName(groupId);
    const coordinator = new JoinCoordinatorClient(env.JOIN_COORDINATOR.getByName(eventId));
    let count = 9;
    let hidden = false;
    let readFailed = false;
    let writes = 0;
    let logins = 0;
    let copyQueries = 0;
    let loginsFail = false;
    let groupRequests = 0;
    let directRequests = 0;
    let additionalEvent = false;
    let copyScenario = false;
    let dated = true;
    let copiesFailed = false;
    let seedInGroup = true;
    // Keep test alarms ahead of the real clock; only runDurableObjectAlarm
    // should trigger them, including when other test files are running.
    let time = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
    const product = (id = eventId) => ({
      name: `projects/racket-id/databases/(default)/documents/IProducts/${id}`,
      createTime: new Date(time).toISOString(),
      fields: {
        type: { stringValue: "event" },
        creator: { stringValue: "event-admin" },
        copiedFrom: { stringValue: `${eventId}-parent` },
        group: { stringValue: hidden ? "" : groupId },
        status: { stringValue: "instance" },
        ...dated ? { date: { stringValue: "9999-01-01 14:00:00" } } : {},
        title: { stringValue: "Test event" },
        slots: { integerValue: "32" },
        users: { mapValue: { fields: Object.fromEntries(
          Array.from({ length: count }, (_, i) => [`user-${i}`, { mapValue: {} }]),
        ) } },
        reserves: { arrayValue: { values: Array.from(
          { length: 20 }, (_, i) => ({ stringValue: `reserve-${i}` }),
        ) } },
      },
    });
    const authorized = (init?: RequestInit) =>
      new Headers(init?.headers).get("authorization") === "Bearer racket-token";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("documents:runQuery")) {
        const query = JSON.parse(String(init?.body)).structuredQuery;
        if (query.select) {
          if (query.where.fieldFilter.field.fieldPath === "copiedFrom") {
            copyQueries++;
            // Production Firestore rules reject anonymous copiedFrom queries.
            if (!authorized(init)) return response([{ error: { code: 403, status: "PERMISSION_DENIED" } }], 403);
            if (copiesFailed) return response({ error: "unavailable" }, 503);
            const filter = query.where.fieldFilter;
            const parents = filter.value.arrayValue?.values.map((v: { stringValue: string }) => v.stringValue)
              || [filter.value.stringValue];
            return response(copyScenario && parents.includes(`${eventId}-parent`)
              ? [{ document: product() }] : []);
          }
          return response(copyScenario && seedInGroup ? [{ document: {
            ...product(`${eventId}-parent`), fields: {
              type: { stringValue: "event" }, status: { stringValue: "instance" },
              group: { stringValue: groupId }, creator: { stringValue: "event-admin" },
              date: { stringValue: "2000-01-01 14:00:00" },
            },
          } }] : []);
        }
        groupRequests++;
        return response(hidden ? [] : [
          { document: product() },
          ...additionalEvent ? [{ document: product(`${eventId}-new`) }] : [],
        ]);
      }
      if (url.includes(`/IProducts/${eventId}`)) {
        const id = url.includes(`${eventId}-new?`) ? `${eventId}-new` : eventId;
        if (init?.method === "PATCH") {
          // Every registration attempt reaches the write; fail it so the
          // coordinator records an attempt without completing the event.
          writes++;
          return response({ error: { code: 503, status: "UNAVAILABLE" } }, 503);
        }
        if (authorized(init)) return response({ ...product(id), updateTime: "2026-01-01T00:00:00Z" });
        directRequests++;
        return readFailed ? response({ error: "unavailable" }, 503) : response(product(id));
      }
      if (url.endsWith("/preloginUser")) {
        logins++;
        return response(loginsFail
          ? { result: { success: false, error: "Wrong password" } }
          : { result: { success: true, userIds: ["racket-player"] } });
      }
      if (url.endsWith("/loginUser")) {
        return response({ result: { success: true, jwt: "custom-token" } });
      }
      if (url.includes("accounts:signInWithCustomToken")) {
        return response({
          idToken: "racket-token",
          refreshToken: "refresh-token",
          expiresIn: "3600",
          localId: "firebase-player",
        });
      }
      throw new Error(`Unexpected test request: ${url}`);
    });
    try {
      await env.MONITOR_STATE.put(SCHEDULE_KEY, JSON.stringify(alwaysActiveSchedule(true)));
      await env.MONITOR_STATE.put(MONITORED_GROUPS_KEY, JSON.stringify([
        { id: groupId, enabled: true, minParticipants: 10 },
      ]));
      await env.MONITOR_STATE.put("roster", JSON.stringify([
        { id: "player", name: "Player", email: "test@example.com", password: "test", enabled: true },
      ]));
      await stub.fetch("https://monitor-scheduler.internal/start", { method: "POST" });
      await test({
        tick: async () => {
          time += 10_000;
          expect(await runDurableObjectAlarm(stub)).toBe(true);
        },
        state: () => coordinator.getState(),
        setCount: (value) => { count = value; },
        hide: () => { hidden = true; },
        hideInitially: () => { hidden = true; copyScenario = true; },
        setDate: (value) => { dated = value; },
        failCopies: (value) => { copiesFailed = value; },
        clearSeedGroup: () => { seedInGroup = false; },
        failRead: (value) => { readFailed = value; },
        writes: () => writes,
        logins: () => logins,
        copyQueries: () => copyQueries,
        dropSession: () => env.MONITOR_STATE.delete("racket_auth:player"),
        failLogins: (value) => { loginsFail = value; },
        requests: () => ({ group: groupRequests, direct: directRequests }),
        advance: (ms) => { time += ms; },
        addEvent: () => { additionalEvent = true; },
        complete: async () => {
          const lease = await coordinator.begin(["player"], 10);
          if (lease.status !== "acquired") throw new Error("Could not acquire test lease");
          await coordinator.markJoined(lease.token, "player");
          await coordinator.finish(lease.token, ["player"]);
        },
        mode: async () => {
          const res = await stub.fetch("https://monitor-scheduler.internal/");
          return (await res.json<{ mode: string }>()).mode;
        },
        durableQueue: async () => {
          const res = await stub.fetch("https://monitor-scheduler.internal/");
          return (await res.json<{ pendingEventCount: number }>()).pendingEventCount;
        },
        restart: async () => {
          time += 10_000;
          await runInDurableObject(stub, async (_instance, state) => {
            await state.storage.deleteAlarm();
            await new MonitorScheduler(state, env).alarm();
          });
        },
      });
    } finally {
      for (let i = 0; i < keys.length; i++) {
        if (previous[i] === null) await env.MONITOR_STATE.delete(keys[i]);
        else await env.MONITOR_STATE.put(keys[i], previous[i]!);
      }
      await Promise.all([
        `active_join_event:${groupId}`, `active_join_events:${groupId}`, `last_has_events:${groupId}`,
        "racket_auth:player", "racket_auth_backoff:player",
      ].map((key) => env.MONITOR_STATE.delete(key)));
    }
  }

  it("waits at nine despite inherited reserves, and starts at ten even after hiding", async () => {
    await participantMonitor(async (monitor) => {
      await monitor.tick();
      await monitor.tick();
      expect(monitor.writes()).toBe(0);
      expect((await monitor.state()).attemptsByPerson).toEqual({});
      expect(await monitor.mode()).toBe("10s");
      // Discovery, then one ten-second probe plus the pending event read.
      expect(monitor.requests()).toEqual({ group: 2, direct: 1 });

      monitor.hide();
      monitor.setCount(10);
      await monitor.tick();
      expect(monitor.writes()).toBe(1);
      expect((await monitor.state()).attemptsByPerson).toEqual({ player: 1 });
      expect(await monitor.mode()).toBe("10s");

      monitor.setCount(9);
      await monitor.tick();
      expect(monitor.writes()).toBe(2);
      expect((await monitor.state()).attemptsByPerson).toEqual({ player: 2 });
      expect(monitor.requests()).toEqual({ group: 4, direct: 3 });
      // Discovery and both join attempts share one cached Racket session.
      expect(monitor.logins()).toBe(1);
    });
  });

  it("does not attempt registration on a failed participant read and recovers next tick", async () => {
    await participantMonitor(async (monitor) => {
      await monitor.tick();
      monitor.setCount(10);
      monitor.failRead(true);
      await monitor.tick();
      expect(monitor.writes()).toBe(0);
      expect((await monitor.state()).attemptsByPerson).toEqual({});
      expect(await monitor.mode()).toBe("10s");

      monitor.failRead(false);
      await monitor.tick();
      expect(monitor.writes()).toBe(1);
      expect((await monitor.state()).attemptsByPerson).toEqual({ player: 1 });
    });
  });

  it("finds an initially hidden undated copy with an authenticated query, persists it, and joins only after date and threshold", async () => {
    await participantMonitor(async (monitor) => {
      monitor.hideInitially();
      monitor.setDate(false);
      monitor.setCount(10);
      await monitor.tick();
      // Parent, then the found copy itself; the mock rejects them unless signed in.
      expect(monitor.copyQueries()).toBe(2);
      expect(await monitor.mode()).toBe("10s");
      expect(await monitor.durableQueue()).toBe(1);
      expect(monitor.writes()).toBe(0);
      expect((await monitor.state()).attemptsByPerson).toEqual({});
      await monitor.restart();
      expect(monitor.requests()).toEqual({ group: 2, direct: 1 });

      // The source disappears and queries fail; the persisted ID must survive
      // both the next minute's discovery and a subsequent direct read failure.
      monitor.clearSeedGroup();
      monitor.failCopies(true);
      monitor.advance(60_000);
      await monitor.tick();
      expect(await monitor.durableQueue()).toBe(1);
      monitor.failRead(true);
      await monitor.tick();
      expect(await monitor.durableQueue()).toBe(1);
      expect(monitor.writes()).toBe(0);

      monitor.failRead(false);
      monitor.setDate(true);
      monitor.setCount(9);
      await monitor.tick();
      expect(monitor.writes()).toBe(0);
      monitor.setCount(10);
      await monitor.tick();
      expect(monitor.writes()).toBe(1);
      expect((await monitor.state()).attemptsByPerson).toEqual({ player: 1 });
    });
  });

  it("retains historical parents after they are removed from the group", async () => {
    await participantMonitor(async (monitor) => {
      monitor.hideInitially();
      await monitor.tick();
      monitor.clearSeedGroup();
      monitor.advance(60_000);
      await monitor.tick();
      expect(await monitor.durableQueue()).toBe(1);
      expect(monitor.writes()).toBe(0);
      monitor.setCount(10);
      await monitor.tick();
      expect(monitor.writes()).toBe(1);
    });
  });

  it("only probes the group after completion and handles a newly published event on the next ten-second tick", async () => {
    await participantMonitor(async (monitor) => {
      await monitor.tick();
      await monitor.complete();
      await monitor.tick();
      expect(await monitor.mode()).toBe("minute");
      expect(monitor.requests()).toEqual({ group: 2, direct: 1 });

      // An idle tick costs a single group query and no event reads.
      await monitor.tick();
      expect(monitor.requests()).toEqual({ group: 3, direct: 1 });

      // No minute has passed: the probe itself must trigger full discovery.
      monitor.addEvent();
      await monitor.tick();
      expect(monitor.requests()).toEqual({ group: 5, direct: 1 });
      expect(await monitor.mode()).toBe("10s");
      await monitor.tick();
      expect(monitor.requests()).toEqual({ group: 6, direct: 2 });
      expect(monitor.writes()).toBe(0);
      expect(monitor.logins()).toBe(1);
    });
  });

  it("renews player sessions in idle ticks and backs off after a failed login", async () => {
    await participantMonitor(async (monitor) => {
      await monitor.tick();
      await monitor.complete();
      await monitor.tick();
      expect(monitor.logins()).toBe(1);

      await monitor.dropSession();
      await monitor.tick();
      expect(monitor.logins()).toBe(2);
      await monitor.tick();
      expect(monitor.logins()).toBe(2);

      monitor.failLogins(true);
      await monitor.dropSession();
      await monitor.tick();
      expect(monitor.logins()).toBe(3);
      // A wrong password must not be retried every ten seconds.
      await monitor.tick();
      await monitor.tick();
      expect(monitor.logins()).toBe(3);
    });
  });

  it("reschedules an empty check and stops outside the configured window", async () => {
    const previousSchedule = await env.MONITOR_STATE.get(SCHEDULE_KEY);
    const previousGroups = await env.MONITOR_STATE.get(MONITORED_GROUPS_KEY);
    const groupId = `scheduler-test-${crypto.randomUUID()}`;
    const stub = env.MONITOR_SCHEDULER.getByName(groupId);

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    try {
      await env.MONITOR_STATE.put(
        SCHEDULE_KEY,
        JSON.stringify(alwaysActiveSchedule(true)),
      );
      await env.MONITOR_STATE.put(
        MONITORED_GROUPS_KEY,
        JSON.stringify([{ id: groupId, enabled: true }]),
      );

      const started = await stub.fetch("https://monitor-scheduler.internal/start", {
        method: "POST",
      });
      expect(started.ok).toBe(true);
      expect(await runDurableObjectAlarm(stub)).toBe(true);

      const afterAlarm = await stub.fetch("https://monitor-scheduler.internal/");
      const active = await afterAlarm.json<{
        mode: string;
        alarmAt: number | null;
      }>();
      expect(active.mode).toBe("minute");
      expect(active.alarmAt).not.toBeNull();
      expect(active.alarmAt! - Date.now()).toBeGreaterThan(0);
      // Every tick probes the group, so the next alarm is ten seconds away.
      expect(active.alarmAt! - Date.now()).toBeLessThanOrEqual(
        MONITOR_POLL_INTERVAL_MS + 100,
      );
      expect(active.alarmAt! - Date.now()).toBeGreaterThan(5_000);

      const alarmBeforeWatchdog = active.alarmAt;
      await stub.fetch("https://monitor-scheduler.internal/start", { method: "POST" });
      const afterWatchdog = await stub.fetch("https://monitor-scheduler.internal/");
      expect((await afterWatchdog.json<{ alarmAt: number | null }>()).alarmAt)
        .toBe(alarmBeforeWatchdog);

      await env.MONITOR_STATE.put(
        SCHEDULE_KEY,
        JSON.stringify(alwaysActiveSchedule(false)),
      );
      await stub.fetch("https://monitor-scheduler.internal/start", { method: "POST" });
      const stopped = await stub.fetch("https://monitor-scheduler.internal/");
      expect(await stopped.json()).toMatchObject({
        active: false,
        mode: "idle",
        alarmAt: null,
      });
    } finally {
      if (previousSchedule === null) await env.MONITOR_STATE.delete(SCHEDULE_KEY);
      else await env.MONITOR_STATE.put(SCHEDULE_KEY, previousSchedule);
      if (previousGroups === null) await env.MONITOR_STATE.delete(MONITORED_GROUPS_KEY);
      else await env.MONITOR_STATE.put(MONITORED_GROUPS_KEY, previousGroups);
    }
  });
});
