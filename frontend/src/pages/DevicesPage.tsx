import { useCallback, useEffect, useState } from "react";
import { useApp } from "../app/AppContext";
import { useConnectivity } from "../app/hooks";
import type { DeviceOut } from "../lib/api";

const STATUS: Record<DeviceOut["status"], [string, string]> = {
  active: ["Active", "chip-synced"],
  wipe_requested: ["Wipe pending: erases on next connection", "chip-pending"],
  wiped: ["Wiped", "chip-error"],
};

/** Admin: devices that have signed in, with remote wipe for a lost or stolen one. */
export function DevicesPage() {
  const { api, session, deviceId } = useApp();
  const connectivity = useConnectivity();
  const [devices, setDevices] = useState<DeviceOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listDevices()
      .then(setDevices)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [api]);
  useEffect(load, [load]);

  if (session.user.role !== "admin") return <main className="page">Only administrators can manage devices.</main>;

  async function wipe(d: DeviceOut) {
    const typed = prompt(`Report device ${d.id.slice(0, 12)}… as lost?\n\nIts patient data will be erased the next time it connects. Type WIPE to confirm.`);
    if (typed !== "WIPE") return;
    await api.requestWipe(d.id);
    load();
  }

  return (
    <main className="page">
      <h2>Devices</h2>
      <p className="muted small">
        Every phone or tablet that has signed in. If one is lost or stolen, report it here: the next time it connects to the server it erases
        all patient data. Until then, its data stays encrypted and needs a user's password.
      </p>
      {connectivity !== "online" && <p className="banner banner-conflict">Device management needs a connection.</p>}
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {(devices ?? []).map((d) => (
          <li key={d.id} className="list-item">
            <div>
              <strong>
                <code>{d.id.slice(0, 16)}…</code>
                {d.id === deviceId && " (this device)"}
              </strong>
              <div className="muted small">
                Last used by {d.last_user ?? "—"} · {new Date(d.last_seen).toLocaleString()}
              </div>
            </div>
            <span className="row-gap">
              <span className={`chip ${STATUS[d.status][1]}`}>{STATUS[d.status][0]}</span>
              {d.status === "active" && d.id !== deviceId && (
                <button type="button" className="danger" onClick={() => void wipe(d)}>
                  Report lost &amp; wipe
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}
