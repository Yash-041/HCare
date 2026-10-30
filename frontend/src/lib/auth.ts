/**
 * Sign-in and the device data key.
 *
 * - A random 256-bit data key (DEK) encrypts everything on the device.
 * - The DEK is stored only wrapped: (a) with the server's per-device secret, which any
 *   authorised user receives at an online sign-in (shared clinic tablets), and (b) with
 *   each user's password (PBKDF2), for offline sign-in.
 * - Offline, the password is checked by unwrapping (b); no password verifier is kept.
 * - Repeated wrong passwords slow down, then erase the device's local data.
 */
import { ApiClient, HttpError, NetworkError } from "./api";
import { fromB64, newDataKey, passwordKey, PBKDF2_ITERATIONS, rawKey, toB64, unwrapKey, wrapKey, type WrappedKey } from "./crypto/vault";
import { wipeDevice } from "./crypto/wipe";
import type { HCareDB } from "./db";
import { nowIso } from "./ids";
import type { CachedSession } from "./types";

const CURRENT_USER_KEY = "current_username";
const DEVICE_WRAP_KEY = "dek_device";
const FAILURES_KEY = "auth_failures";
export const SLOWDOWN_AFTER = 5;
export const WIPE_AFTER = 10;

export class AuthError extends Error {
  name = "AuthError";
}

export type LoginMode = "online" | "offline";

export interface SessionSecrets {
  token: string;
  transportKey: CryptoKey | null;
}

const userAad = (username: string) => `hcare/dek/user:${username}`;
const DEVICE_AAD = "hcare/dek/device";

async function wrapForUser(dek: Uint8Array, password: string, username: string): Promise<WrappedKey> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrapped = await wrapKey(dek, await passwordKey(password, salt, PBKDF2_ITERATIONS), userAad(username));
  return { ...wrapped, salt: toB64(salt), iterations: PBKDF2_ITERATIONS };
}

async function unwrapForUser(wrapped: WrappedKey, password: string, username: string): Promise<Uint8Array | null> {
  try {
    const kek = await passwordKey(password, fromB64(wrapped.salt!), wrapped.iterations!);
    return await unwrapKey(wrapped, kek, userAad(username));
  } catch {
    return null; // wrong password (or tampered key blob)
  }
}

/** The device's data key, via the server's device secret; created on a fresh device. */
async function deviceDataKey(db: HCareDB, deviceSecret: string): Promise<Uint8Array> {
  const deviceKey = await rawKey(deviceSecret);
  const stored = await db.getMeta<WrappedKey>(DEVICE_WRAP_KEY);
  if (stored) {
    try {
      return await unwrapKey(stored, deviceKey, DEVICE_AAD);
    } catch {
      throw new AuthError("This device's data can't be unlocked with the server's key. Wipe the device to continue.");
    }
  }
  const dek = newDataKey();
  await db.setMeta(DEVICE_WRAP_KEY, await wrapKey(dek, deviceKey, DEVICE_AAD));
  return dek;
}

async function failures(db: HCareDB): Promise<{ count: number; last: number }> {
  return (await db.getMeta<{ count: number; last: number }>(FAILURES_KEY)) ?? { count: 0, last: 0 };
}

/** Seconds to wait before another offline attempt (0 = allowed now). */
export async function lockoutSeconds(db: HCareDB, now = Date.now()): Promise<number> {
  const f = await failures(db);
  if (f.count < SLOWDOWN_AFTER) return 0;
  const wait = 30_000 * (f.count - SLOWDOWN_AFTER + 1);
  return Math.max(0, Math.ceil((f.last + wait - now) / 1000));
}

async function recordFailure(db: HCareDB): Promise<never> {
  const f = await failures(db);
  const count = f.count + 1;
  if (count >= WIPE_AFTER) {
    await wipeDevice(db);
    throw new AuthError("Too many wrong passwords. Patient data on this device has been erased.");
  }
  await db.setMeta(FAILURES_KEY, { count, last: Date.now() });
  const left = WIPE_AFTER - count;
  throw new AuthError(
    count >= SLOWDOWN_AFTER
      ? `Invalid username or password. ${left} attempt${left === 1 ? "" : "s"} left before this device's data is erased.`
      : "Invalid username or password",
  );
}

export async function sessionSecrets(db: HCareDB, session: CachedSession): Promise<SessionSecrets> {
  const token = db.vault.decrypt<string>(session.token_enc, `session.token:${session.username}`);
  const raw = session.transport_key_enc ? db.vault.decrypt<string>(session.transport_key_enc, `session.transport:${session.username}`) : null;
  return { token, transportKey: raw ? await rawKey(raw) : null };
}

async function establish(db: HCareDB, session: CachedSession, dek: Uint8Array): Promise<SessionSecrets> {
  if (!db.vault.unlocked) await db.vault.unlock(dek);
  dek.fill(0);
  await db.meta.delete(FAILURES_KEY);
  await db.setMeta(CURRENT_USER_KEY, session.username);
  return sessionSecrets(db, session);
}

export async function loginOnline(
  api: ApiClient,
  db: HCareDB,
  username: string,
  password: string,
): Promise<{ session: CachedSession; secrets: SessionSecrets }> {
  const deviceId = await db.deviceId();
  const res = await api.login(username, password, deviceId);
  if (!res.device_key) throw new AuthError("Server did not provide a device key");
  const dek = await deviceDataKey(db, res.device_key);
  // Unlock first: the session's own secrets are stored encrypted with the data key.
  db.vault.lock();
  await db.vault.unlock(dek);
  const session: CachedSession = {
    username,
    user: res.user,
    token_expires_at: Date.now() + res.expires_in * 1000,
    token_enc: db.vault.encrypt(res.access_token, `session.token:${username}`),
    transport_key_enc: db.vault.encrypt(res.transport_key, `session.transport:${username}`),
    wrapped_dek: await wrapForUser(dek, password, username),
    cached_at: nowIso(),
  };
  await db.sessions.put(session);
  return { session, secrets: await establish(db, session, dek) };
}

export async function loginOffline(db: HCareDB, username: string, password: string): Promise<{ session: CachedSession; secrets: SessionSecrets }> {
  const cached = await db.sessions.get(username);
  if (!cached) {
    throw new AuthError("No connection, and this user has never signed in on this device. Connect once to sign in.");
  }
  const wait = await lockoutSeconds(db);
  if (wait > 0) throw new AuthError(`Too many wrong attempts. Try again in ${wait} seconds.`);
  const dek = await unwrapForUser(cached.wrapped_dek, password, username);
  if (!dek) return recordFailure(db);
  db.vault.lock();
  return { session: cached, secrets: await establish(db, cached, dek) };
}

/** Online first; falls back to the offline (on-device) check only when the server is unreachable. */
export async function login(
  api: ApiClient,
  db: HCareDB,
  username: string,
  password: string,
): Promise<{ session: CachedSession; secrets: SessionSecrets; mode: LoginMode }> {
  try {
    return { ...(await loginOnline(api, db, username, password)), mode: "online" };
  } catch (e) {
    if (e instanceof NetworkError || (e instanceof HttpError && e.status >= 500)) {
      return { ...(await loginOffline(db, username, password)), mode: "offline" };
    }
    if (e instanceof HttpError && e.status === 401) throw new AuthError("Invalid username or password");
    throw e;
  }
}

/** The signed-in user (data still locked until `unlock`). */
export async function restoreSession(db: HCareDB): Promise<CachedSession | null> {
  const username = await db.getMeta<string>(CURRENT_USER_KEY);
  return username ? ((await db.sessions.get(username)) ?? null) : null;
}

/** Re-enter the password to unlock after an app restart or auto-lock. Works offline. */
export function unlock(db: HCareDB, session: CachedSession, password: string) {
  return loginOffline(db, session.username, password);
}

/** Ends the session (revoked on the server when reachable); local data stays, encrypted. */
export async function logout(db: HCareDB, api?: ApiClient): Promise<void> {
  await api?.logout().catch(() => undefined);
  db.vault.lock();
  await db.meta.delete(CURRENT_USER_KEY);
}
