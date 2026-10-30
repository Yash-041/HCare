import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../app/AppContext";
import { useConnectivity, useSyncState } from "../app/hooks";
import { formatValue, threeWayDiff } from "../lib/diff";
import { planMerge } from "../lib/merge";
import type { ConflictOut, LocalRecord } from "../lib/types";

function recordLabel(rec: LocalRecord | undefined, fallback: string): string {
  const d = rec?.data as { name?: string; visit_date?: string; kind?: string } | null | undefined;
  return d?.name ?? d?.visit_date ?? d?.kind ?? fallback;
}

export function SyncPage() {
  const { db, scheduler, deviceId, session } = useApp();
  const state = useSyncState();
  const connectivity = useConnectivity();
  const outbox = useLiveQuery(() => db.outbox.orderBy("seq").toArray(), [db]);
  const conflicts = useLiveQuery(() => db.conflicts.toArray(), [db]);
  const cursor = useLiveQuery(() => db.getMeta<number>("pull_cursor"), [db]);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Sync</h2>
        <button onClick={() => void scheduler.syncNow()} disabled={state.phase === "syncing" || connectivity === "offline"}>
          {state.phase === "syncing" ? "Syncing…" : "Sync now"}
        </button>
      </div>

      <section className="card stats">
        <div>
          <span className="muted small">Connection</span>
          <strong>{connectivity}</strong>
        </div>
        <div>
          <span className="muted small">Status</span>
          <strong>{state.phase}</strong>
        </div>
        <div>
          <span className="muted small">Last sync</span>
          <strong>{state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleTimeString() : "—"}</strong>
        </div>
        <div>
          <span className="muted small">Next retry</span>
          <strong>{state.nextAttemptAt ? new Date(state.nextAttemptAt).toLocaleTimeString() : "—"}</strong>
        </div>
        {state.lastError && <p className="error span-all">{state.lastError}</p>}
        {state.phase === "auth-required" && (
          <p className="span-all">
            Your session expired. Sign out and sign in while online; your unsynced changes stay on this device.
          </p>
        )}
      </section>

      <section className="card">
        <h3>Conflicts {conflicts?.length ? `(${conflicts.length})` : ""}</h3>
        {conflicts?.length ? (
          conflicts.map((c) => <ConflictCard key={c.id} conflict={c} />)
        ) : (
          <p className="muted">No conflicts.</p>
        )}
      </section>

      <ResolvedHistory />

      <section className="card">
        <h3>Outbox {outbox?.length ? `(${outbox.length})` : ""}</h3>
        {outbox?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Record</th>
                  <th>Op</th>
                  <th>Base v</th>
                  <th>Status</th>
                  <th>Retries</th>
                  <th>Last error</th>
                </tr>
              </thead>
              <tbody>
                {outbox.map((op) => (
                  <tr key={op.seq}>
                    <td>{op.seq}</td>
                    <td>
                      {op.entity} <code>{op.entity_id.slice(0, 8)}</code>
                    </td>
                    <td>{op.resolves_conflict_id ? "resolve" : op.op_type}</td>
                    <td>{op.base_version}</td>
                    <td>
                      <span className={`chip chip-op-${op.status}`}>{op.status}</span>
                    </td>
                    <td>{op.retry_count}</td>
                    <td className="small">{op.last_error ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">Everything on this device has been synced.</p>
        )}
      </section>

      <section className="card muted small">
        Device <code>{deviceId}</code> · signed in as {session.username} ({session.user.role}) · pull cursor {cursor ?? 0}
      </section>
    </main>
  );
}

function ConflictCard({ conflict }: { conflict: ConflictOut }) {
  const { db } = useApp();
  const local = useLiveQuery(() => db.records(conflict.entity).get(conflict.entity_id), [db, conflict]);

  // "Mine" is the device's latest local state, which may include edits made after the conflict.
  const mineDeleted = local?.deleted ?? conflict.local_deleted;
  const mine = local?.data ?? conflict.local_data;
  const diffs = threeWayDiff(conflict.base_data, mine, conflict.current_data);
  const plan = planMerge(conflict.base_data, mine, conflict.current_data);
  const clashes = plan.filter((p) => p.status === "clash").length;
  const awaitingSync = useLiveQuery(
    async () => (await db.outbox.where("entity_id").equals(conflict.entity_id).toArray()).some((o) => o.resolves_conflict_id === conflict.id),
    [db, conflict],
  );
  if (awaitingSync) {
    return (
      <div className="conflict">
        <strong>{recordLabel(local, conflict.entity_id.slice(0, 8))}</strong>
        <span className="muted small">Resolved on this device; waiting to sync.</span>
      </div>
    );
  }

  return (
    <div className="conflict">
      <div className="page-head">
        <strong>
          {conflict.entity}:{" "}
          {conflict.entity === "patient" ? (
            <Link to={`/patients/${conflict.entity_id}`}>{recordLabel(local, conflict.entity_id.slice(0, 8))}</Link>
          ) : (
            recordLabel(local, conflict.entity_id.slice(0, 8))
          )}
        </strong>
        <span className="muted small">
          your edit was based on v{conflict.base_version}; server is at v{conflict.current_version}
        </span>
      </div>
      {mineDeleted !== conflict.current_deleted && (
        <p className="banner banner-conflict">
          {mineDeleted ? "You deleted this record; it was edited elsewhere." : "This record was deleted on another device."}
        </p>
      )}
      <div className="table-wrap">
        <table className="diff">
          <thead>
            <tr>
              <th>Field</th>
              <th>Before</th>
              <th>Mine</th>
              <th>Server</th>
            </tr>
          </thead>
          <tbody>
            {diffs.map((d) => (
              <tr key={d.field} className={d.clash ? "clash" : ""}>
                <td>{d.field}</td>
                <td className="muted">{formatValue(d.base)}</td>
                <td className={d.mineChanged ? "changed" : ""}>{formatValue(d.mine)}</td>
                <td className={d.serverChanged ? "changed" : ""}>{formatValue(d.server)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions">
        <Link to={`/sync/conflicts/${conflict.id}`} className="button">
          Review &amp; resolve
        </Link>
        <span className="muted small">
          {mineDeleted !== conflict.current_deleted
            ? "Deleted on one device, edited on the other"
            : `${clashes} field${clashes === 1 ? "" : "s"} need${clashes === 1 ? "s" : ""} a decision, ${plan.length - clashes} merge${plan.length - clashes === 1 ? "s" : ""} automatically`}
        </span>
      </div>
    </div>
  );
}

/** Conflicts this device resolved, with the per-field decisions from the server's audit log. */
function ResolvedHistory() {
  const { api, deviceId } = useApp();
  const connectivity = useConnectivity();
  const { lastSyncAt } = useSyncState();
  const [items, setItems] = useState<ConflictOut[] | null>(null);
  // Refetch after every successful sync: a resolution only appears once it reached the server.
  useEffect(() => {
    if (connectivity !== "online") return;
    let cancelled = false;
    api
      .listConflicts(deviceId, "resolved")
      .then((r) => !cancelled && setItems(r.slice(-10).reverse()))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, deviceId, connectivity, lastSyncAt]);

  if (!items?.length) return null;
  return (
    <section className="card">
      <h3>Recently resolved</h3>
      <p className="muted small">From the server's tamper-evident audit log.</p>
      <ul className="list">
        {items.map((c) => (
          <li key={c.id} className="list-item resolved-item">
            <div>
              <strong>{c.entity}</strong> <span className="muted small">resolved {c.resolved_at ? new Date(c.resolved_at).toLocaleString() : ""}</span>
              <div className="reasons">
                {Object.entries(c.resolution ?? {}).map(([field, side]) => (
                  <span key={field} className="chip chip-match">
                    {field}: {side === "theirs" ? "server" : side === "mine" ? "this device" : side === "both" ? "combined" : side}
                  </span>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
