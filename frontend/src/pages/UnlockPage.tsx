import { useState, type FormEvent } from "react";
import type { Unlock } from "../app/AppContext";
import { AuthError } from "../lib/auth";
import type { CachedSession } from "../lib/types";

/** Shown at app start and after auto-lock: patient data stays encrypted until the password is entered. */
export function UnlockPage({ session, unlock, switchUser }: { session: CachedSession; unlock: Unlock; switchUser: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlock(password);
    } catch (err) {
      setError(err instanceof AuthError ? err.message : "Could not unlock. Please try again.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit}>
        <div className="lock-icon" aria-hidden>
          🔒
        </div>
        <h1>Locked</h1>
        <p className="muted">
          {session.user.full_name || session.username}, enter your password to open patient records on this device.
        </p>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus required />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
        <button type="button" className="link" onClick={switchUser}>
          Sign in as someone else
        </button>
        <p className="hint">Works offline. Data on this device is encrypted.</p>
      </form>
    </main>
  );
}
