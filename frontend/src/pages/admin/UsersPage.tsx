import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useApp } from "../../app/AppContext";
import { useConnectivity } from "../../app/hooks";
import { HttpError, type StaffUser } from "../../lib/api";
import type { Role } from "../../lib/types";

const ROLE_LABEL: Record<Role, string> = { health_worker: "Health worker", doctor: "Doctor", admin: "Admin" };

/** Admin: add doctors and health workers, change roles, deactivate accounts, reset passwords. */
export function UsersPage() {
  const { api, session } = useApp();
  const connectivity = useConnectivity();
  const [users, setUsers] = useState<StaffUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listUsers()
      .then(setUsers)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [api]);
  useEffect(load, [load]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      load();
    } catch (e) {
      setError(e instanceof HttpError ? e.detail : e instanceof Error ? e.message : String(e));
    }
  }

  const staff = (users ?? []).filter((u) => u.role !== "admin");
  const admins = (users ?? []).filter((u) => u.role === "admin");

  return (
    <main className="page">
      <h2>Staff</h2>
      {connectivity !== "online" && <p className="banner banner-conflict">Managing staff needs a connection.</p>}
      <AddUserForm onAdd={(u) => run(() => api.createUser(u), `Added ${u.full_name || u.username}. Share the username and temporary password with them.`)} />
      {notice && <p className="banner banner-ok">{notice}</p>}
      {error && <p className="banner banner-error">{error}</p>}

      {[
        ["Doctors and health workers", staff],
        ["Administrators", admins],
      ].map(([title, list]) => (
        <section className="card" key={title as string}>
          <h3>{title as string}</h3>
          <ul className="list">
            {(list as StaffUser[]).map((u) => (
              <li key={u.id} className={`list-item user-row ${u.active ? "" : "inactive"}`}>
                <div>
                  <strong>{u.full_name || u.username}</strong>
                  <div className="muted small">
                    {u.username} · added {new Date(u.created_at).toLocaleDateString()}
                    {!u.active && " · deactivated"}
                  </div>
                </div>
                <span className="row-gap">
                  <select
                    aria-label={`Role of ${u.username}`}
                    value={u.role}
                    disabled={u.id === session.user.id}
                    onChange={(e) => void run(() => api.updateUser(u.id, { role: e.target.value as Role }), `${u.username} is now ${ROLE_LABEL[e.target.value as Role]}.`)}
                  >
                    {Object.entries(ROLE_LABEL).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      const pw = prompt(`New temporary password for ${u.username} (at least 8 characters):`);
                      if (pw) void run(() => api.resetPassword(u.id, pw), `Password reset for ${u.username}. They are signed out everywhere.`);
                    }}
                  >
                    Reset password
                  </button>
                  {u.id !== session.user.id && (
                    <button
                      type="button"
                      className={u.active ? "danger" : "secondary"}
                      onClick={() => {
                        if (u.active && !confirm(`Deactivate ${u.username}? They are signed out immediately and cannot sync.`)) return;
                        void run(() => api.updateUser(u.id, { active: !u.active }), `${u.username} ${u.active ? "deactivated" : "reactivated"}.`);
                      }}
                    >
                      {u.active ? "Deactivate" : "Reactivate"}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}

function AddUserForm({ onAdd }: { onAdd: (u: { username: string; password: string; role: Role; full_name: string }) => Promise<void> }) {
  const [form, setForm] = useState({ full_name: "", username: "", role: "health_worker" as Role, password: "" });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(form.username)) return setError("Username: 3-64 letters, digits, dots, dashes or underscores.");
    if (form.password.length < 8) return setError("Temporary password must be at least 8 characters.");
    setError(null);
    await onAdd(form);
    setForm({ full_name: "", username: "", role: form.role, password: "" });
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h3>Add a doctor or health worker</h3>
      <fieldset>
        <label>
          Full name
          <input value={form.full_name} onChange={(e) => set("full_name", e.target.value)} required maxLength={200} />
        </label>
        <label>
          Role
          <select aria-label="New user's role" value={form.role} onChange={(e) => set("role", e.target.value)}>
            <option value="health_worker">Health worker</option>
            <option value="doctor">Doctor</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <label>
          Username
          <input value={form.username} onChange={(e) => set("username", e.target.value.trim())} required autoComplete="off" />
        </label>
        <label>
          Temporary password
          <input type="text" value={form.password} onChange={(e) => set("password", e.target.value)} required minLength={8} autoComplete="new-password" />
        </label>
      </fieldset>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="submit">Add</button>
        <span className="muted small">They sign in once online on their device; after that they can also work offline.</span>
      </div>
    </form>
  );
}
