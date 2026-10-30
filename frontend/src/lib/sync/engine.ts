/**
 * Client side of the sync engine. One run = push outbox -> pull changes -> refresh conflicts.
 *
 * Guarantees:
 *  - an op leaves the outbox only after the server acknowledged it (applied);
 *  - interrupted sends are retried with the same op_id, so the server dedupes them;
 *  - at most one in-flight op per record, and later ops are re-based on the version
 *    the server just assigned (version chaining);
 *  - a record with a conflict or rejection holds back its later ops;
 *  - pulled changes never overwrite records that still have unsynced local edits.
 */
import { ApiClient, HttpError, NetworkError } from "../api";
import type { HCareDB } from "../db";
import type { Change, ConflictOut, OpResult, OutboxOp, WireOp } from "../types";

export type SyncPhase = "idle" | "syncing" | "backoff" | "auth-required";

export interface SyncState {
  phase: SyncPhase;
  lastSyncAt: string | null;
  lastError: string | null;
  nextAttemptAt: number | null;
  consecutiveFailures: number;
}

export interface SyncReport {
  sent: number;
  applied: number;
  conflicts: number;
  rejected: number;
  retryLater: number;
  pulled: number;
  error: string | null;
}

export interface SyncEngineOptions {
  batchSize?: number;
  now?: () => number;
  random?: () => number;
}

const PULL_CURSOR_KEY = "pull_cursor";

/** 1s, 2s, 4s, ... capped at 5 min, with +/-20% jitter so devices don't retry in lockstep. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** Math.max(0, attempt - 1), 5 * 60_000);
  return Math.round(base * (0.8 + 0.4 * random()));
}

export class SyncEngine {
  state: SyncState = {
    phase: "idle",
    lastSyncAt: null,
    lastError: null,
    nextAttemptAt: null,
    consecutiveFailures: 0,
  };
  private listeners = new Set<(s: SyncState) => void>();
  private running: Promise<SyncReport> | null = null;
  private batchSize: number;
  private now: () => number;
  private random: () => number;

  constructor(
    private db: HCareDB,
    private api: ApiClient,
    private deviceId: string,
    opts: SyncEngineOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? 50;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  subscribe(fn: (s: SyncState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setState(patch: Partial<SyncState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  /** Called after a fresh online login so sync can resume. */
  clearAuthRequired() {
    if (this.state.phase === "auth-required") this.setState({ phase: "idle", lastError: null });
  }

  /** Single-flight: concurrent callers share the same run. */
  sync(): Promise<SyncReport> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<SyncReport> {
    const report: SyncReport = { sent: 0, applied: 0, conflicts: 0, rejected: 0, retryLater: 0, pulled: 0, error: null };
    this.setState({ phase: "syncing" });
    try {
      await this.recoverInterruptedSends();
      await this.pushAll(report);
      await this.pullAll(report);
      await this.refreshConflicts();
      this.setState({
        phase: "idle",
        lastSyncAt: new Date(this.now()).toISOString(),
        lastError: null,
        nextAttemptAt: null,
        consecutiveFailures: 0,
      });
    } catch (e) {
      report.error = e instanceof Error ? e.message : String(e);
      if (e instanceof HttpError && e.status === 401) {
        this.setState({ phase: "auth-required", lastError: "Session expired. Sign in online to resume sync." });
      } else {
        const failures = this.state.consecutiveFailures + 1;
        this.setState({
          phase: "backoff",
          lastError: e instanceof NetworkError ? "Server unreachable" : report.error,
          consecutiveFailures: failures,
          nextAttemptAt: this.now() + backoffMs(failures, this.random),
        });
      }
    }
    return report;
  }

  /** Ops left in "sending" by a crash or closed tab: their fate is unknown, so resend as-is. */
  private async recoverInterruptedSends() {
    await this.db.outbox.where("status").equals("sending").modify({ status: "pending" });
  }

  // ---------------------------------------------------------------- push

  private async pushAll(report: SyncReport) {
    for (;;) {
      const batch = await this.nextBatch();
      if (batch.length === 0) return;
      await this.pushBatch(batch, report);
    }
  }

  /** Oldest-first; one op per record per batch; a record's ops stop at its first non-sendable op. */
  private async nextBatch(): Promise<OutboxOp[]> {
    const now = this.now();
    const blocked = new Set<string>();
    const batch: OutboxOp[] = [];
    for (const op of await this.db.outbox.orderBy("seq").toArray()) {
      if (blocked.has(op.entity_id)) continue;
      blocked.add(op.entity_id);
      if (op.status === "pending" && op.next_attempt_at <= now) batch.push(op);
      if (batch.length >= this.batchSize) break;
    }
    return batch;
  }

  private async pushBatch(batch: OutboxOp[], report: SyncReport) {
    await this.db.outbox.bulkUpdate(
      batch.map((op) => ({ key: op.seq!, changes: { status: "sending" as const, sent_once: true } })),
    );
    const wire: WireOp[] = batch.map((op) => ({
      op_id: op.op_id,
      entity: op.entity,
      entity_id: op.entity_id,
      op_type: op.op_type,
      base_version: op.base_version,
      data: op.data,
      client_ts: op.updated_at,
      resolves_conflict_id: op.resolves_conflict_id ?? null,
    }));

    let results: OpResult[];
    try {
      results = (await this.api.push(this.deviceId, wire)).results;
    } catch (e) {
      // No acknowledgment: the server may or may not have applied these. Resend later with
      // the same op_ids; the server's idempotency ledger makes that safe.
      await this.db.outbox.bulkUpdate(batch.map((op) => ({ key: op.seq!, changes: { status: "pending" as const } })));
      throw e;
    }

    report.sent += batch.length;
    const byId = new Map(results.map((r) => [r.op_id, r]));
    for (const op of batch) {
      const result = byId.get(op.op_id);
      if (!result) {
        await this.db.outbox.update(op.seq!, { status: "pending" });
        continue;
      }
      await this.handleResult(op, result, report);
    }
  }

  private async handleResult(op: OutboxOp, r: OpResult, report: SyncReport) {
    const table = this.db.records(op.entity);
    switch (r.status) {
      case "applied":
        report.applied++;
        await this.db.transaction("rw", table, this.db.outbox, this.db.conflicts, async () => {
          await this.db.outbox.delete(op.seq!);
          const later = await this.db.outbox.where("entity_id").equals(op.entity_id).toArray();
          // Version chaining: edits queued while this op was in flight were based on the
          // same server version; they now build on the version just created.
          for (const next of later) {
            if (next.base_version === op.base_version) {
              await this.db.outbox.update(next.seq!, { base_version: r.version! });
            }
          }
          const rec = await table.get(op.entity_id);
          if (rec) {
            await table.put({
              ...rec,
              version: r.version!,
              base_data: op.op_type === "delete" ? rec.base_data : (op.data as never),
              sync_status: later.length === 0 ? "synced" : rec.sync_status,
            });
          }
          if (op.resolves_conflict_id) await this.db.conflicts.delete(op.resolves_conflict_id);
        });
        return;

      case "conflict": {
        report.conflicts++;
        await this.db.transaction("rw", table, this.db.outbox, this.db.conflicts, async () => {
          await this.db.outbox.update(op.seq!, { status: "conflict", conflict_id: r.conflict_id });
          await table.update(op.entity_id, { sync_status: "conflict" });
          if (op.resolves_conflict_id) await this.db.conflicts.delete(op.resolves_conflict_id);
        });
        await this.fetchConflict(r.conflict_id!);
        return;
      }

      case "rejected":
        report.rejected++;
        await this.db.transaction("rw", table, this.db.outbox, async () => {
          await this.db.outbox.update(op.seq!, { status: "rejected", last_error: r.error });
          await table.update(op.entity_id, { sync_status: "error" });
        });
        return;

      case "error": {
        report.retryLater++;
        const attempts = op.retry_count + 1;
        await this.db.outbox.update(op.seq!, {
          status: "pending",
          retry_count: attempts,
          last_error: r.error,
          next_attempt_at: this.now() + backoffMs(attempts, this.random),
        });
        return;
      }
    }
  }

  private async fetchConflict(id: string) {
    try {
      await this.db.conflicts.put(await this.api.getConflict(id));
    } catch (e) {
      // Not fatal: refreshConflicts() picks it up at the end of the run.
      if (!(e instanceof NetworkError)) throw e;
    }
  }

  // ---------------------------------------------------------------- pull

  private async pullAll(report: SyncReport) {
    let cursor = (await this.db.getMeta<number>(PULL_CURSOR_KEY)) ?? 0;
    for (;;) {
      const page = await this.api.pull(cursor);
      await this.db.transaction(
        "rw",
        [this.db.patients, this.db.consultations, this.db.documents, this.db.outbox, this.db.meta],
        async () => {
          for (const change of page.changes) {
            if (await this.applyChange(change)) report.pulled++;
          }
          await this.db.setMeta(PULL_CURSOR_KEY, page.next_cursor);
        },
      );
      cursor = page.next_cursor;
      if (!page.has_more) return;
    }
  }

  private async applyChange(c: Change): Promise<boolean> {
    const table = this.db.records(c.entity);
    const local = await table.get(c.id);
    if (local && local.version >= c.version) return false;
    // Unsynced local edits win locally; the push will surface any conflict with the server.
    if ((await this.db.outbox.where("entity_id").equals(c.id).count()) > 0) return false;
    await table.put({
      id: c.id,
      entity: c.entity,
      version: c.version,
      data: c.data,
      base_data: c.data,
      deleted: c.deleted,
      updated_at: c.updated_at,
      updated_by: c.updated_by,
      device_id: c.device_id,
      sync_status: "synced",
      patient_id: c.entity === "patient" ? undefined : (c.data as { patient_id?: string } | null)?.patient_id,
    });
    return true;
  }

  // ---------------------------------------------------------------- conflicts

  private async refreshConflicts() {
    const open = await this.api.listConflicts(this.deviceId);
    await this.db.transaction("rw", this.db.conflicts, this.db.outbox, async () => {
      const openIds = new Set(open.map((c) => c.id));
      const awaitingAck = new Set(
        (await this.db.outbox.toArray()).map((op) => op.resolves_conflict_id).filter(Boolean) as string[],
      );
      const stale = (await this.db.conflicts.toArray()).filter((c) => !openIds.has(c.id) && !awaitingAck.has(c.id));
      await this.db.conflicts.bulkDelete(stale.map((c) => c.id));
      // Only conflicts this device still has to act on (a resolution may already be queued).
      await this.db.conflicts.bulkPut(open.filter((c: ConflictOut) => !awaitingAck.has(c.id)));
    });
  }
}
