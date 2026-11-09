// Caches Racket/Firebase sessions so joins and authenticated discovery do not
// repeat the three-request Racket login on every attempt. A cached ID token is
// reused until it is close to expiry, then renewed with one refresh request.

export interface RacketCredentials {
  id: string;
  email: string;
  password: string;
}

export interface RacketSession {
  idToken: string;
  localId: string;
  racketUserId: string;
  refreshToken?: string;
  expiresIn?: string;
}

export interface CachedRacketSession {
  idToken: string;
  refreshToken: string;
  localId: string;
  racketUserId: string;
  expiresAt: number;
  credentialHash: string;
}

export interface RefreshedToken {
  idToken: string;
  refreshToken: string;
  expiresIn: string;
  localId?: string;
}

export interface RacketAuthStore {
  get(personId: string): Promise<CachedRacketSession | null>;
  put(personId: string, session: CachedRacketSession): Promise<void>;
  delete(personId: string): Promise<void>;
}

export type RacketAuthSource = "cache" | "refresh" | "login";

export interface RacketAuthLease {
  auth: RacketSession;
  source: RacketAuthSource;
}

export const RACKET_AUTH_KEY_PREFIX = "racket_auth:";
// Tokens are reissued with a margin so that a long join batch never starts
// with a token that expires halfway through.
export const RACKET_AUTH_MIN_VALIDITY_MS = 5 * 60_000;
const DEFAULT_TOKEN_LIFETIME_S = 3600;
const STORE_TTL_S = 30 * 24 * 3600;

export function kvRacketAuthStore(kv: KVNamespace): RacketAuthStore {
  return {
    async get(personId) {
      return kv.get<CachedRacketSession>(`${RACKET_AUTH_KEY_PREFIX}${personId}`, "json");
    },
    async put(personId, session) {
      await kv.put(`${RACKET_AUTH_KEY_PREFIX}${personId}`, JSON.stringify(session), {
        expirationTtl: STORE_TTL_S,
      });
    },
    async delete(personId) {
      await kv.delete(`${RACKET_AUTH_KEY_PREFIX}${personId}`);
    },
  };
}

export async function racketCredentialHash(person: Pick<RacketCredentials, "email" | "password">) {
  const data = new TextEncoder().encode(
    `${person.email.trim().toLowerCase()}\n${person.password.trim()}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function expiresAt(now: number, expiresIn: string | undefined): number {
  const seconds = Number(expiresIn);
  return now + (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TOKEN_LIFETIME_S) * 1000;
}

// One provider per Worker invocation: concurrent requests for the same person
// share a single in-flight login. Promises are never shared across requests.
export class RacketAuthProvider {
  private readonly inflight = new Map<string, Promise<RacketAuthLease>>();

  constructor(
    private readonly store: RacketAuthStore,
    private readonly signIn: (email: string, password: string) => Promise<RacketSession>,
    private readonly refresh: (refreshToken: string) => Promise<RefreshedToken>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(
    person: RacketCredentials,
    minValidityMs = RACKET_AUTH_MIN_VALIDITY_MS,
  ): Promise<RacketAuthLease> {
    const running = this.inflight.get(person.id);
    if (running) return running;
    const lease = this.resolve(person, minValidityMs)
      .finally(() => this.inflight.delete(person.id));
    this.inflight.set(person.id, lease);
    return lease;
  }

  async isFresh(person: RacketCredentials, minValidityMs: number): Promise<boolean> {
    const [cached, hash] = await Promise.all([
      this.read(person.id),
      racketCredentialHash(person),
    ]);
    return Boolean(
      cached && cached.credentialHash === hash && cached.expiresAt - this.now() > minValidityMs,
    );
  }

  async invalidate(personId: string): Promise<void> {
    try {
      await this.store.delete(personId);
    } catch (error) {
      console.warn(`Racket auth cache delete failed for ${personId}:`, error);
    }
  }

  private async read(personId: string): Promise<CachedRacketSession | null> {
    try {
      return await this.store.get(personId);
    } catch (error) {
      console.warn(`Racket auth cache read failed for ${personId}:`, error);
      return null;
    }
  }

  private async write(personId: string, session: CachedRacketSession): Promise<void> {
    try {
      await this.store.put(personId, session);
    } catch (error) {
      console.warn(`Racket auth cache write failed for ${personId}:`, error);
    }
  }

  private async resolve(
    person: RacketCredentials,
    minValidityMs: number,
  ): Promise<RacketAuthLease> {
    const [cached, credentialHash] = await Promise.all([
      this.read(person.id),
      racketCredentialHash(person),
    ]);
    const usable = cached && cached.credentialHash === credentialHash ? cached : null;

    if (usable && usable.expiresAt - this.now() > minValidityMs) {
      return { auth: usable, source: "cache" };
    }

    if (usable?.refreshToken) {
      try {
        const refreshed = await this.refresh(usable.refreshToken);
        const session: CachedRacketSession = {
          ...usable,
          idToken: refreshed.idToken,
          refreshToken: refreshed.refreshToken || usable.refreshToken,
          localId: refreshed.localId || usable.localId,
          expiresAt: expiresAt(this.now(), refreshed.expiresIn),
        };
        await this.write(person.id, session);
        return { auth: session, source: "refresh" };
      } catch (error) {
        console.warn(`Racket token refresh failed for ${person.id}; signing in again:`, error);
      }
    }

    const login = await this.signIn(person.email, person.password);
    if (login.refreshToken) {
      await this.write(person.id, {
        idToken: login.idToken,
        refreshToken: login.refreshToken,
        localId: login.localId,
        racketUserId: login.racketUserId,
        expiresAt: expiresAt(this.now(), login.expiresIn),
        credentialHash,
      });
    }
    return { auth: login, source: "login" };
  }
}
