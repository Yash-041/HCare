/**
 * Login works offline: after one successful online login the device keeps a PBKDF2
 * verifier of the password (never the password itself) plus the server token.
 * Offline, the typed password is checked against the verifier and the cached token is
 * reused; if that token has expired, local work continues and sync asks for an online login.
 */
import { ApiClient, HttpError, NetworkError } from "./api";
import type { HCareDB } from "./db";
import { nowIso } from "./ids";
import type { CachedSession } from "./types";

const PBKDF2_ITERATIONS = 210_000;
const CURRENT_USER_KEY = "current_username";

export class AuthError extends Error {
  name = "AuthError";
}

export type LoginMode = "online" | "offline";

const toB64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveVerifier(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return toB64(bits);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function loginOnline(api: ApiClient, db: HCareDB, username: string, password: string): Promise<CachedSession> {
  const res = await api.login(username, password);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const session: CachedSession = {
    username,
    user: res.user,
    token: res.access_token,
    token_expires_at: Date.now() + res.expires_in * 1000,
    salt: toB64(salt),
    verifier: await deriveVerifier(password, salt, PBKDF2_ITERATIONS),
    iterations: PBKDF2_ITERATIONS,
    cached_at: nowIso(),
  };
  await db.sessions.put(session);
  await db.setMeta(CURRENT_USER_KEY, username);
  return session;
}

export async function loginOffline(db: HCareDB, username: string, password: string): Promise<CachedSession> {
  const cached = await db.sessions.get(username);
  if (!cached) {
    throw new AuthError("No connection, and this user has never signed in on this device. Connect once to sign in.");
  }
  const verifier = await deriveVerifier(password, fromB64(cached.salt), cached.iterations);
  if (!constantTimeEqual(verifier, cached.verifier)) throw new AuthError("Invalid username or password");
  await db.setMeta(CURRENT_USER_KEY, username);
  return cached;
}

/** Online first; falls back to the offline verifier only when the server is unreachable. */
export async function login(
  api: ApiClient,
  db: HCareDB,
  username: string,
  password: string,
): Promise<{ session: CachedSession; mode: LoginMode }> {
  try {
    return { session: await loginOnline(api, db, username, password), mode: "online" };
  } catch (e) {
    if (e instanceof NetworkError || (e instanceof HttpError && e.status >= 500)) {
      return { session: await loginOffline(db, username, password), mode: "offline" };
    }
    if (e instanceof HttpError && e.status === 401) throw new AuthError("Invalid username or password");
    throw e;
  }
}

export async function restoreSession(db: HCareDB): Promise<CachedSession | null> {
  const username = await db.getMeta<string>(CURRENT_USER_KEY);
  return username ? ((await db.sessions.get(username)) ?? null) : null;
}

/** Ends the session but keeps the verifier so this user can sign in offline later. */
export async function logout(db: HCareDB): Promise<void> {
  await db.meta.delete(CURRENT_USER_KEY);
}
