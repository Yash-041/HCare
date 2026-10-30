import { useEffect, useState } from "react";
import { useApp } from "../../app/AppContext";
import type { AuditEntry, StaffUser } from "../../lib/api";

const ACTIONS: Record<string, string> = {
  create: "Created record",
  update: "Updated record",
  delete: "Deleted record",
  conflict: "Conflict detected",
  resolve_conflict: "Conflict resolved",
  rejected: "Change rejected",
  duplicate_ignored: "Duplicate ignored (retry)",
  user_created: "Staff account added",
  user_updated: "Staff account changed",
  password_reset: "Password reset",
  device_wipe_requested: "Device reported lost",
  device_wipe_delivered: "Device wiped",
};

/** Admin/doctor: the tamper-evident audit log, with a one-click integrity check. */
export function AuditPage() {
  const { api, session } = useApp();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [users, setUsers] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<{ ok: boolean; checked: number; first_bad_id: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.auditLog(300).then(setEntries).catch((e) => setError(String(e)));
    if (session.user.role === "admin") {
      api
        .listUsers()
        .then((list: StaffUser[]) => setUsers(Object.fromEntries(list.map((u) => [u.id, u.full_name || u.username]))))
        .catch(() => undefined);
    }
  }, [api, session.user.role]);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Audit log</h2>
        {session.user.role === "admin" && (
          <button type="button" className="secondary" onClick={() => api.verifyAudit().then(setCheck).catch((e) => setError(String(e)))}>
            Check integrity
          </button>
        )}
      </div>
      <p className="muted small">Every change, conflict and admin action, in order. Each entry is chained to the previous one by a hash, so edits or deletions are detectable.</p>
      {check && (
        <p className={`banner ${check.ok ? "banner-ok" : "banner-error"}`} role="status">
          {check.ok ? `✓ Intact: all ${check.checked} entries verified.` : `⚠ Tampering detected at entry #${check.first_bad_id}.`}
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th>Record</th>
              <th>Device</th>
            </tr>
          </thead>
          <tbody>
            {(entries ?? []).map((e) => (
              <tr key={e.id}>
                <td>{e.id}</td>
                <td className="small">{new Date(e.ts).toLocaleString()}</td>
                <td className="small">{users[e.user_id] ?? e.user_id.slice(0, 8)}</td>
                <td>
                  {ACTIONS[e.action] ?? e.action}
                  {e.version ? <span className="muted small"> v{e.version}</span> : null}
                </td>
                <td className="small">
                  {e.entity ? `${e.entity} ` : ""}
                  {e.entity_id && <code>{e.entity_id.slice(0, 8)}</code>}
                </td>
                <td className="small">
                  <code>{e.device_id.slice(0, 12)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
