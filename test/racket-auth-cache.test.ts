import { describe, expect, it, vi } from "vitest";
import {
  RacketAuthProvider,
  type CachedRacketSession,
  type RacketAuthStore,
} from "../src/racket-auth-cache";

function memoryStore(): RacketAuthStore & { data: Map<string, CachedRacketSession> } {
  const data = new Map<string, CachedRacketSession>();
  return {
    data,
    get: async (id) => data.get(id) ?? null,
    put: async (id, session) => { data.set(id, session); },
    delete: async (id) => { data.delete(id); },
  };
}

const person = { id: "anton", email: "Anton@Example.com", password: "secret" };

function setup() {
  let now = 1_000_000;
  let loginCount = 0;
  const store = memoryStore();
  const signIn = vi.fn(async () => {
    loginCount += 1;
    return {
      idToken: `login-${loginCount}`,
      refreshToken: `refresh-${loginCount}`,
      expiresIn: "3600",
      localId: "firebase-anton",
      racketUserId: "racket-anton",
    };
  });
  const refresh = vi.fn(async (refreshToken: string) => ({
    idToken: `refreshed-from-${refreshToken}`,
    refreshToken,
    expiresIn: "3600",
  }));
  const provider = new RacketAuthProvider(store, signIn, refresh, () => now);
  return {
    store,
    signIn,
    refresh,
    provider,
    advance: (ms: number) => { now += ms; },
  };
}

describe("Racket session cache", () => {
  it("logs in once and reuses the cached token", async () => {
    const { provider, signIn } = setup();
    const first = await provider.get(person);
    const second = await provider.get(person);
    expect(first.source).toBe("login");
    expect(second).toMatchObject({ source: "cache", auth: { idToken: "login-1", racketUserId: "racket-anton" } });
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("refreshes a token that is close to expiry with a single request", async () => {
    const { provider, signIn, refresh, advance } = setup();
    await provider.get(person);
    advance(56 * 60_000);
    const lease = await provider.get(person);
    expect(lease.source).toBe("refresh");
    expect(lease.auth).toMatchObject({ idToken: "refreshed-from-refresh-1", racketUserId: "racket-anton" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect((await provider.get(person)).source).toBe("cache");
  });

  it("logs in again when the roster credentials change", async () => {
    const { provider, signIn } = setup();
    await provider.get(person);
    const lease = await provider.get({ ...person, password: "new-secret" });
    expect(lease.source).toBe("login");
    expect(signIn).toHaveBeenCalledTimes(2);
    // Email case and surrounding spaces do not count as a change.
    expect((await provider.get({ ...person, email: " anton@example.com ", password: "new-secret" })).source)
      .toBe("cache");
  });

  it("falls back to a full login when the refresh token is rejected", async () => {
    const { provider, signIn, refresh, advance } = setup();
    await provider.get(person);
    refresh.mockRejectedValueOnce(new Error("INVALID_REFRESH_TOKEN"));
    advance(3600_000);
    const lease = await provider.get(person);
    expect(lease).toMatchObject({ source: "login", auth: { idToken: "login-2" } });
    expect(signIn).toHaveBeenCalledTimes(2);
  });

  it("shares one login between concurrent requests and logs in again after invalidation", async () => {
    const { provider, signIn } = setup();
    const leases = await Promise.all([provider.get(person), provider.get(person), provider.get(person)]);
    expect(new Set(leases.map((lease) => lease.auth.idToken))).toEqual(new Set(["login-1"]));
    expect(signIn).toHaveBeenCalledTimes(1);

    await provider.invalidate(person.id);
    expect((await provider.get(person)).auth.idToken).toBe("login-2");
  });

  it("reports freshness against the requested validity margin", async () => {
    const { provider, advance } = setup();
    expect(await provider.isFresh(person, 15 * 60_000)).toBe(false);
    await provider.get(person);
    expect(await provider.isFresh(person, 15 * 60_000)).toBe(true);
    advance(50 * 60_000);
    expect(await provider.isFresh(person, 15 * 60_000)).toBe(false);
  });

  it("keeps working when the store is unavailable", async () => {
    const store: RacketAuthStore = {
      get: async () => { throw new Error("KV down"); },
      put: async () => { throw new Error("KV down"); },
      delete: async () => { throw new Error("KV down"); },
    };
    const signIn = vi.fn(async () => ({
      idToken: "token",
      refreshToken: "refresh",
      expiresIn: "3600",
      localId: "local",
      racketUserId: "racket",
    }));
    const provider = new RacketAuthProvider(store, signIn, vi.fn());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await provider.get(person)).auth.idToken).toBe("token");
    await provider.invalidate(person.id);
  });
});
