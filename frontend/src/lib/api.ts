import type {
  ConflictOut,
  LoginResponse,
  PullResponse,
  PushResponse,
  UserOut,
  WireOp,
} from "./types";

/** The request never got a response (offline, DNS, timeout, connection reset). Safe to retry. */
export class NetworkError extends Error {
  name = "NetworkError";
}

export class HttpError extends Error {
  name = "HttpError";
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(`HTTP ${status}: ${detail}`);
  }
}

/** The server says this device was reported lost: erase local data now. */
export class DeviceWipeError extends HttpError {
  name = "DeviceWipeError";
  constructor() {
    super(410, "device_wipe");
  }
}

export interface ApiOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  getToken?: () => string | null;
  /** This session's payload key; when set, sync payloads are encrypted both ways. */
  getTransportKey?: () => CryptoKey | null;
  onDeviceWipe?: () => void;
  timeoutMs?: number;
}

export interface DeviceOut {
  id: string;
  status: "active" | "wipe_requested" | "wiped";
  first_seen: string;
  last_seen: string;
  last_user: string | null;
  wipe_requested_at: string | null;
}

interface Sealed {
  iv: string;
  ct: string;
}

const te = new TextEncoder();
const td = new TextDecoder();
const b64 = (b: ArrayBuffer | Uint8Array) => {
  const bytes = new Uint8Array(b);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** AES-GCM with an AAD naming where the payload belongs (op_id, record version, conflict field). */
export async function seal(key: CryptoKey, value: unknown, aad: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, key, te.encode(JSON.stringify(value)));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function open<T>(key: CryptoKey, sealed: Sealed, aad: string): Promise<T> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv) as BufferSource, additionalData: te.encode(aad) }, key, unb64(sealed.ct) as BufferSource);
  return JSON.parse(td.decode(pt)) as T;
}

const CONFLICT_FIELDS = ["base_data", "local_data", "server_data", "current_data"] as const;

export class ApiClient {
  private fetchImpl: typeof fetch;

  constructor(private opts: ApiOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = auth ? this.opts.getToken?.() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (auth && this.opts.getTransportKey?.()) headers["X-Payload-Encryption"] = "v1";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 20_000);
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      throw new NetworkError(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }

    let payload: unknown;
    try {
      payload = res.status === 204 ? null : await res.json();
    } catch (e) {
      // Connection dropped while reading the body: treat like no response.
      if (res.ok) throw new NetworkError(e instanceof Error ? e.message : String(e));
      payload = null;
    }
    if (!res.ok) {
      const detail = (payload as { detail?: unknown } | null)?.detail;
      if (res.status === 410 && detail === "device_wipe") {
        this.opts.onDeviceWipe?.();
        throw new DeviceWipeError();
      }
      throw new HttpError(res.status, typeof detail === "string" ? detail : res.statusText);
    }
    return payload as T;
  }

  health() {
    return this.request<{ status: string; server_time: string }>("GET", "/health", undefined, false);
  }

  login(username: string, password: string, deviceId?: string) {
    return this.request<LoginResponse>("POST", "/auth/login", { username, password, device_id: deviceId }, false);
  }

  logout() {
    return this.request<null>("POST", "/auth/logout");
  }

  me() {
    return this.request<UserOut>("GET", "/auth/me");
  }

  async push(device_id: string, ops: WireOp[]) {
    const key = this.opts.getTransportKey?.();
    const wire = key
      ? await Promise.all(
          ops.map(async (op) =>
            op.data === null || op.data === undefined
              ? op
              : { ...op, data: null, data_enc: await seal(key, op.data, op.op_id) }, // AAD = op_id
          ),
        )
      : ops;
    return this.request<PushResponse>("POST", "/sync/push", { device_id, ops: wire });
  }

  async pull(since: number, limit = 500) {
    const page = await this.request<PullResponse & { changes: (PullResponse["changes"][number] & { data_enc?: Sealed | null })[] }>(
      "GET",
      `/sync/pull?since=${since}&limit=${limit}`,
    );
    const key = this.opts.getTransportKey?.();
    if (key) {
      for (const c of page.changes) {
        if (c.data_enc) c.data = await open(key, c.data_enc, `${c.entity}:${c.id}:${c.version}`);
        delete c.data_enc;
      }
    }
    return page as PullResponse;
  }

  private async openConflict(c: ConflictOut & { enc?: Record<string, Sealed> | null }): Promise<ConflictOut> {
    const key = this.opts.getTransportKey?.();
    if (key && c.enc) {
      for (const f of CONFLICT_FIELDS) {
        if (c.enc[f]) (c as unknown as Record<string, unknown>)[f] = await open(key, c.enc[f], `conflict:${c.id}:${f}`);
      }
    }
    delete c.enc;
    return c;
  }

  async listConflicts(deviceId: string, status: "open" | "resolved" = "open") {
    const list = await this.request<ConflictOut[]>("GET", `/sync/conflicts?status=${status}&device_id=${encodeURIComponent(deviceId)}`);
    return Promise.all(list.map((c) => this.openConflict(c)));
  }

  async getConflict(id: string) {
    return this.openConflict(await this.request<ConflictOut>("GET", `/sync/conflicts/${encodeURIComponent(id)}`));
  }

  listDevices() {
    return this.request<DeviceOut[]>("GET", "/admin/devices");
  }

  requestWipe(deviceId: string) {
    return this.request<{ status: string }>("POST", `/admin/devices/${encodeURIComponent(deviceId)}/wipe`);
  }
}
