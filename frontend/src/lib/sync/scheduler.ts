/**
 * Decides *when* to sync: on reconnect, app start, tab focus, shortly after a local
 * save, and periodically. Also owns connectivity status, because navigator.onLine only
 * says "has a network", not "can reach the server" (e.g. Wi-Fi with no uplink).
 */
import type { ApiClient } from "../api";
import type { SyncEngine } from "./engine";

export type Connectivity = "online" | "offline" | "unreachable";

export interface SchedulerOptions {
  intervalMs?: number;
  debounceMs?: number;
}

export class SyncScheduler {
  connectivity: Connectivity = navigator.onLine ? "online" : "offline";
  private listeners = new Set<(c: Connectivity) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private cleanup: (() => void)[] = [];

  constructor(
    private engine: SyncEngine,
    private api: ApiClient,
    private opts: SchedulerOptions = {},
  ) {}

  subscribe(fn: (c: Connectivity) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setConnectivity(c: Connectivity) {
    if (c === this.connectivity) return;
    this.connectivity = c;
    for (const fn of this.listeners) fn(c);
  }

  start() {
    const onOnline = () => {
      this.setConnectivity("online");
      void this.syncNow();
    };
    const onOffline = () => this.setConnectivity("offline");
    const onVisible = () => {
      if (document.visibilityState === "visible") this.request(0);
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    this.cleanup.push(
      () => window.removeEventListener("online", onOnline),
      () => window.removeEventListener("offline", onOffline),
      () => document.removeEventListener("visibilitychange", onVisible),
    );
    this.interval = setInterval(() => this.request(0), this.opts.intervalMs ?? 30_000);
    this.request(0);
  }

  stop() {
    this.cleanup.forEach((fn) => fn());
    this.cleanup = [];
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
  }

  /** Ask for a sync soon. Respects the engine's backoff unless `force` is set. */
  request(delayMs = this.opts.debounceMs ?? 1500) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.syncNow(false), delayMs);
  }

  async syncNow(force = true) {
    if (!navigator.onLine) {
      this.setConnectivity("offline");
      return;
    }
    const { phase, nextAttemptAt } = this.engine.state;
    if (phase === "auth-required") return;
    if (!force && phase === "backoff" && nextAttemptAt && Date.now() < nextAttemptAt) {
      this.request(nextAttemptAt - Date.now());
      return;
    }
    const run = () => this.engine.sync();
    // Web Locks keep two open tabs from syncing the same outbox at once.
    const report = navigator.locks ? await navigator.locks.request("hcare-sync", run) : await run();
    this.setConnectivity(report.error && this.engine.state.lastError === "Server unreachable" ? "unreachable" : "online");
    if (this.engine.state.phase === "backoff" && this.engine.state.nextAttemptAt) {
      this.request(this.engine.state.nextAttemptAt - Date.now());
    }
  }

  /** Lightweight reachability probe used when nothing needs syncing. */
  async probe(): Promise<Connectivity> {
    if (!navigator.onLine) {
      this.setConnectivity("offline");
      return "offline";
    }
    try {
      await this.api.health();
      this.setConnectivity("online");
    } catch {
      this.setConnectivity("unreachable");
    }
    return this.connectivity;
  }
}
