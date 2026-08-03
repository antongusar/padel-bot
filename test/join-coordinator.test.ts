import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  JOIN_LEASE_MS,
  JoinCoordinatorClient,
} from "../src/join-coordinator";
import {
  runCoordinatedBatch,
  type CoordinatedResult,
} from "../src/join-runner";

interface TestPerson {
  id: string;
  name: string;
}

interface TestResult extends CoordinatedResult {
  name: string;
}

const people: TestPerson[] = [
  { id: "anton", name: "Anton" },
  { id: "vlad", name: "Vladyslav" },
  { id: "andrey", name: "Andrey" },
  { id: "mariana", name: "Mariana" },
];

function coordinator(eventId: string): JoinCoordinatorClient {
  return new JoinCoordinatorClient(env.JOIN_COORDINATOR.getByName(eventId));
}

function personError(person: TestPerson, error: unknown): TestResult {
  return {
    id: person.id,
    name: person.name,
    ok: false,
    reason: error instanceof Error ? error.message : String(error),
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("per-event join coordination", () => {
  let sequence = 0;

  beforeEach(() => {
    sequence += 1;
  });

  it("turns twenty simultaneous event ticks into one browser batch", async () => {
    const client = coordinator(`parallel-${sequence}`);
    const acquired = deferred();
    const release = deferred();
    let browserStarts = 0;
    const attempts: string[] = [];

    const runTick = () =>
      runCoordinatedBatch<TestPerson, TestResult>({
        coordinator: client,
        people,
        maxAttempts: 10,
        beforeBatch: async () => {
          browserStarts += 1;
          acquired.resolve();
          await release.promise;
        },
        joinPerson: async (person, heartbeat) => {
          attempts.push(person.id);
          await heartbeat();
          return { id: person.id, name: person.name, ok: true };
        },
        personError,
      });

    const first = runTick();
    await acquired.promise;
    const competing = Array.from({ length: 19 }, () => runTick());
    const competingResults = await Promise.all(competing);

    expect(competingResults.every((result) => result.status === "busy")).toBe(true);
    expect(browserStarts).toBe(1);

    release.resolve();
    const firstResult = await first;
    expect(firstResult.completedNow).toBe(true);
    expect(attempts).toEqual(people.map((person) => person.id));
    expect((await client.getState()).joinedIds).toEqual(
      people.map((person) => person.id),
    );
  });

  it("checkpoints each successful person and retries only the failures", async () => {
    const client = coordinator(`partial-${sequence}`);
    const firstAttempts: string[] = [];

    const first = await runCoordinatedBatch<TestPerson, TestResult>({
      coordinator: client,
      people,
      maxAttempts: 10,
      joinPerson: async (person) => {
        firstAttempts.push(person.id);
        if (person.id === "vlad") {
          expect((await client.getState()).joinedIds).toEqual(["anton"]);
        }
        const ok = person.id === "anton" || person.id === "vlad";
        return {
          id: person.id,
          name: person.name,
          ok,
          reason: ok ? undefined : "simulated full/error",
        };
      },
      personError,
    });

    expect(first.completedNow).toBe(false);
    expect(firstAttempts).toEqual(["anton", "vlad", "andrey", "mariana"]);
    expect((await client.getState()).joinedIds).toEqual(["anton", "vlad"]);

    const retryAttempts: string[] = [];
    const retry = await runCoordinatedBatch<TestPerson, TestResult>({
      coordinator: client,
      people,
      maxAttempts: 10,
      joinPerson: async (person) => {
        retryAttempts.push(person.id);
        return { id: person.id, name: person.name, ok: true };
      },
      personError,
    });

    expect(retryAttempts).toEqual(["andrey", "mariana"]);
    expect(retry.completedNow).toBe(true);
    expect((await client.getState()).joinedIds).toEqual([
      "anton",
      "vlad",
      "andrey",
      "mariana",
    ]);
  });

  it("keeps checkpoints after a crashed owner and rejects stale writes", async () => {
    const client = coordinator(`crash-${sequence}`);
    const personIds = people.map((person) => person.id);
    const startedAt = 10_000;
    const first = await client.begin(personIds, 10, startedAt);
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") throw new Error("Expected acquired lease");

    await client.startPerson(first.token, "anton", startedAt + 1);
    await client.markJoined(first.token, "anton", startedAt + 2);

    const whileRunning = await client.begin(personIds, 10, startedAt + 3);
    expect(whileRunning.status).toBe("busy");

    const recoveredAt = startedAt + 2 + JOIN_LEASE_MS + 1;
    const recovered = await client.begin(personIds, 10, recoveredAt);
    expect(recovered.status).toBe("acquired");
    if (recovered.status !== "acquired") throw new Error("Expected recovered lease");
    expect(recovered.remainingIds).toEqual(["vlad", "andrey", "mariana"]);

    await expect(
      client.markJoined(first.token, "vlad", recoveredAt + 1),
    ).rejects.toThrow("owned by another invocation");
    expect((await client.getState()).joinedIds).toEqual(["anton"]);
  });

  it("stops retrying only the person who exhausted their budget", async () => {
    const client = coordinator(`attempts-${sequence}`);
    const onePerson = [people[0]];
    let browserStarts = 0;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await runCoordinatedBatch<TestPerson, TestResult>({
        coordinator: client,
        people: onePerson,
        maxAttempts: 3,
        beforeBatch: async () => {
          browserStarts += 1;
        },
        joinPerson: async (person) => ({
          id: person.id,
          name: person.name,
          ok: false,
          reason: "simulated failure",
        }),
        personError,
      });
      expect(result.status).toBe("acquired");
    }

    const exhausted = await runCoordinatedBatch<TestPerson, TestResult>({
      coordinator: client,
      people: onePerson,
      maxAttempts: 3,
      beforeBatch: async () => {
        browserStarts += 1;
      },
      joinPerson: async (person) => ({
        id: person.id,
        name: person.name,
        ok: true,
      }),
      personError,
    });

    expect(exhausted.status).toBe("exhausted");
    expect(browserStarts).toBe(3);
    expect((await client.getState()).attemptsByPerson.anton).toBe(3);
  });

  it("releases the lease when the browser cannot start", async () => {
    const client = coordinator(`browser-error-${sequence}`);

    const failed = await runCoordinatedBatch<TestPerson, TestResult>({
      coordinator: client,
      people,
      maxAttempts: 10,
      beforeBatch: async () => {
        throw new Error("Unable to create new browser: 429");
      },
      joinPerson: async (person) => ({
        id: person.id,
        name: person.name,
        ok: true,
      }),
      personError,
    });

    expect(failed.error).toContain("429");
    expect((await client.getState()).running).toBeUndefined();

    const recovered = await runCoordinatedBatch<TestPerson, TestResult>({
      coordinator: client,
      people,
      maxAttempts: 10,
      joinPerson: async (person) => ({
        id: person.id,
        name: person.name,
        ok: true,
      }),
      personError,
    });

    expect(recovered.status).toBe("acquired");
    expect(recovered.completedNow).toBe(true);
  });

  it("simulates an event appearing suddenly under concurrent cron load", async () => {
    const client = coordinator(`release-${sequence}`);
    let eventVisible = false;
    let browserStarts = 0;

    const tick = async () => {
      if (!eventVisible) return "no-event";
      const result = await runCoordinatedBatch<TestPerson, TestResult>({
        coordinator: client,
        people,
        maxAttempts: 10,
        beforeBatch: async () => {
          browserStarts += 1;
        },
        joinPerson: async (person, heartbeat) => {
          await heartbeat();
          return { id: person.id, name: person.name, ok: true };
        },
        personError,
      });
      return result.status;
    };

    expect(await Promise.all(Array.from({ length: 20 }, tick))).toEqual(
      Array(20).fill("no-event"),
    );
    expect(browserStarts).toBe(0);

    eventVisible = true;
    const statuses = await Promise.all(Array.from({ length: 20 }, tick));
    expect(statuses.filter((status) => status === "acquired")).toHaveLength(1);
    expect(
      statuses.filter((status) => status === "busy" || status === "complete"),
    ).toHaveLength(19);
    expect(browserStarts).toBe(1);
    expect((await client.getState()).done).toBe(true);
  });

  it("lets a manual test clear stale completion for a reused event id", async () => {
    const client = coordinator(`manual-reset-${sequence}`);
    const onePerson = [people[0]];
    let joins = 0;
    const run = () =>
      runCoordinatedBatch<TestPerson, TestResult>({
        coordinator: client,
        people: onePerson,
        maxAttempts: 10,
        joinPerson: async (person) => {
          joins += 1;
          return { id: person.id, name: person.name, ok: true };
        },
        personError,
      });

    expect((await run()).completedNow).toBe(true);
    expect((await run()).status).toBe("complete");
    expect(joins).toBe(1);

    await client.reset();
    expect((await run()).completedNow).toBe(true);
    expect(joins).toBe(2);
  });

  it("does not let a second manual test reset an active run", async () => {
    const client = coordinator(`manual-busy-${sequence}`);
    const begin = await client.begin(["anton"], 10);
    expect(begin.status).toBe("acquired");

    await expect(client.reset()).rejects.toThrow(
      "Join is already running for this event",
    );
  });
});
