/**
 * Holds the device data key while the app is unlocked, and nowhere else: never persisted
 * in clear, wiped from memory on lock.
 *
 * Sub-keys are derived with HKDF so the same key is never used for two purposes:
 *   records  - AES-256-GCM (noble, synchronous) for fields inside IndexedDB transactions
 *   index    - HMAC-SHA256 for blind search tokens
 *   blobs    - AES-256-GCM (WebCrypto) for photos and recordings
 * IndexedDB transactions auto-commit while awaiting non-IndexedDB promises, so anything
 * encrypted *inside* a transaction must be synchronous; WebCrypto is used everywhere else.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

export class LockedError extends Error {
  name = "LockedError";
  constructor(message = "The app is locked. Sign in to unlock patient data.") {
    super(message);
  }
}

/** Stored form of an encrypted field. */
export interface Envelope {
  __enc: 1;
  iv: Uint8Array;
  ct: Uint8Array;
}

export function isEnvelope(v: unknown): v is Envelope {
  return !!v && typeof v === "object" && (v as Envelope).__enc === 1 && (v as Envelope).ct instanceof Uint8Array;
}

const te = new TextEncoder();
const td = new TextDecoder();

export const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
export const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (b: Uint8Array) => toB64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export class Vault {
  private recordKey: Uint8Array | null = null;
  private indexKey: Uint8Array | null = null;
  private blobKey: CryptoKey | null = null;
  private listeners = new Set<(unlocked: boolean) => void>();

  /** required: refuse to store unencrypted data while locked (the app); tests leave it off. */
  constructor(public required = false) {}

  get unlocked(): boolean {
    return this.recordKey !== null;
  }

  onChange(fn: (unlocked: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async unlock(dek: Uint8Array): Promise<void> {
    const derive = (info: string) => hkdf(sha256, dek, undefined, te.encode(info), 32);
    const blobRaw = derive("hcare/blobs/v1");
    this.blobKey = await crypto.subtle.importKey("raw", blobRaw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
    blobRaw.fill(0);
    this.recordKey = derive("hcare/records/v1");
    this.indexKey = derive("hcare/search-index/v1");
    for (const fn of this.listeners) fn(true);
  }

  lock(): void {
    this.recordKey?.fill(0);
    this.indexKey?.fill(0);
    this.recordKey = this.indexKey = null;
    this.blobKey = null;
    for (const fn of this.listeners) fn(false);
  }

  private requireKey(): Uint8Array {
    if (!this.recordKey) throw new LockedError();
    return this.recordKey;
  }

  /** Encrypt any JSON value. `aad` binds the ciphertext to where it is stored (table, field, id). */
  encrypt(value: unknown, aad: string): Envelope {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = gcm(this.requireKey(), iv, te.encode(aad)).encrypt(te.encode(JSON.stringify(value)));
    return { __enc: 1, iv, ct };
  }

  /** Throws if the key is wrong, the data was altered, or it was moved to another record. */
  decrypt<T = unknown>(env: Envelope, aad: string): T {
    const pt = gcm(this.requireKey(), env.iv, te.encode(aad)).decrypt(env.ct);
    return JSON.parse(td.decode(pt)) as T;
  }

  /**
   * Blind index token: keyed hash, so the search index holds no readable names or
   * symptoms but equal words still match. Identity while no key is set (tests only).
   */
  blind(token: string): string {
    if (!this.indexKey) {
      if (this.required) throw new LockedError();
      return token;
    }
    return b64url(hmac(sha256, this.indexKey, te.encode(token)).slice(0, 16));
  }

  async encryptBytes(bytes: ArrayBuffer, aad: string): Promise<{ iv: Uint8Array; ct: ArrayBuffer }> {
    if (!this.blobKey) throw new LockedError();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: te.encode(aad) }, this.blobKey, bytes);
    return { iv, ct };
  }

  async decryptBytes(iv: Uint8Array, ct: ArrayBuffer, aad: string): Promise<ArrayBuffer> {
    if (!this.blobKey) throw new LockedError();
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: te.encode(aad) }, this.blobKey, ct);
  }
}

// ------------------------------------------------------------------ key wrapping (WebCrypto)

export const PBKDF2_ITERATIONS = 210_000;

export interface WrappedKey {
  iv: string;
  ct: string;
  salt?: string;
  iterations?: number;
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Key-encryption key from a password (PBKDF2-SHA256). */
export async function passwordKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function wrapKey(dek: Uint8Array, kek: CryptoKey, aad: string): Promise<WrappedKey> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: te.encode(aad) }, kek, dek as BufferSource);
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

/** Throws (OperationError) on a wrong key or tampered blob. */
export async function unwrapKey(wrapped: WrappedKey, kek: CryptoKey, aad: string): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(wrapped.iv) as BufferSource, additionalData: te.encode(aad) },
    kek,
    fromB64(wrapped.ct) as BufferSource,
  );
  return new Uint8Array(pt);
}

export async function rawKey(b64: string): Promise<CryptoKey> {
  return aesKey(fromB64(b64));
}

export function newDataKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}
