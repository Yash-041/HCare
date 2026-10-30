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

export interface ApiOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  getToken?: () => string | null;
  timeoutMs?: number;
}

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
      payload = await res.json();
    } catch (e) {
      // Connection dropped while reading the body: treat like no response.
      if (res.ok) throw new NetworkError(e instanceof Error ? e.message : String(e));
      payload = null;
    }
    if (!res.ok) {
      const detail = (payload as { detail?: unknown } | null)?.detail;
      throw new HttpError(res.status, typeof detail === "string" ? detail : res.statusText);
    }
    return payload as T;
  }

  health() {
    return this.request<{ status: string; server_time: string }>("GET", "/health", undefined, false);
  }

  login(username: string, password: string) {
    return this.request<LoginResponse>("POST", "/auth/login", { username, password }, false);
  }

  me() {
    return this.request<UserOut>("GET", "/auth/me");
  }

  push(device_id: string, ops: WireOp[]) {
    return this.request<PushResponse>("POST", "/sync/push", { device_id, ops });
  }

  pull(since: number, limit = 500) {
    return this.request<PullResponse>("GET", `/sync/pull?since=${since}&limit=${limit}`);
  }

  listConflicts(deviceId: string, status: "open" | "resolved" = "open") {
    return this.request<ConflictOut[]>("GET", `/sync/conflicts?status=${status}&device_id=${encodeURIComponent(deviceId)}`);
  }

  getConflict(id: string) {
    return this.request<ConflictOut>("GET", `/sync/conflicts/${encodeURIComponent(id)}`);
  }
}
