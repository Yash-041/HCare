import { inject } from "vitest";
import { ApiClient } from "../src/lib/api";
import { loginOnline, type SessionSecrets } from "../src/lib/auth";
import { HCareDB } from "../src/lib/db";
import { newId } from "../src/lib/ids";
import type { Actor } from "../src/lib/repo";
import { SyncEngine } from "../src/lib/sync/engine";
import type { CachedSession, PatientData } from "../src/lib/types";

/**
 * Fault injection between the device and the server.
 *  up            normal
 *  down          request never leaves the device
 *  drop-response server processes the request, but the response is lost
 */
export class FlakyNetwork {
  mode: "up" | "down" | "drop-response" = "up";
  /** Runs after the request is "on the wire" but before the server sees it. */
  beforeServer: (() => Promise<void>) | null = null;
  requests: string[] = [];

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    this.requests.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (this.mode === "down") throw new TypeError("Failed to fetch");
    const hook = this.beforeServer;
    this.beforeServer = null;
    if (hook) await hook();
    const res = await fetch(input, init);
    if (this.mode === "drop-response") {
      await res.text();
      throw new TypeError("network connection was lost");
    }
    return res;
  };

  pushes() {
    return this.requests.filter((r) => r.startsWith("POST /sync/push")).length;
  }
}

export interface Device {
  db: HCareDB;
  api: ApiClient;
  net: FlakyNetwork;
  engine: SyncEngine;
  session: CachedSession;
  actor: Actor;
  deviceId: string;
}

/**
 * A simulated phone, configured like the app: encryption at rest required, the data key
 * unlocked by signing in, and sync payloads encrypted with the session key.
 */
export async function makeDevice(username = "asha", password = "asha1234", existingDb?: HCareDB): Promise<Device> {
  const db = existingDb ?? new HCareDB(`test-${newId()}`, { requireEncryption: true });
  const net = new FlakyNetwork();
  let secrets: SessionSecrets | null = null;
  const api = new ApiClient({
    baseUrl: inject("apiUrl"),
    fetch: net.fetch,
    getToken: () => secrets?.token ?? null,
    getTransportKey: () => secrets?.transportKey ?? null,
  });
  const { session, secrets: s } = await loginOnline(api, db, username, password);
  secrets = s;
  const deviceId = await db.deviceId();
  // Deterministic jitter; tests move time forward explicitly instead of sleeping.
  const engine = new SyncEngine(db, api, deviceId, { random: () => 0.5 });
  return { db, api, net, engine, session, deviceId, actor: { userId: session.user.id, deviceId } };
}

export function patient(overrides: Partial<PatientData> = {}): PatientData {
  return {
    name: "Sunita Devi",
    sex: "female",
    age_years: 32,
    village: "Rampur",
    known_allergies: [],
    chronic_conditions: [],
    ...overrides,
  };
}

/** Raw history from the server, bypassing the device under test. */
export async function serverHistory(entity: string, id: string): Promise<{ version: number; data: unknown }[]> {
  const base = inject("apiUrl");
  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "doctor", password: "doctor123" }),
  }).then((r) => r.json());
  return fetch(`${base}/records/${entity}/${id}/history`, {
    headers: { Authorization: `Bearer ${login.access_token}` },
  }).then((r) => r.json());
}
