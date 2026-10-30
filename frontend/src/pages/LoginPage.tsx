import { useState, type FormEvent } from "react";
import type { SignIn } from "../app/AppContext";
import { AuthError } from "../lib/auth";
import { consumeWipedFlag } from "../lib/crypto/wipe";

export function LoginPage({ signIn }: { signIn: SignIn }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wiped] = useState(consumeWipedFlag);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), password);
    } catch (err) {
      setError(err instanceof AuthError ? err.message : "Sign-in failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit}>
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>HCare</h1>
        <p className="muted">Patient records that work without internet</p>
        {wiped && (
          <p className="banner banner-error" role="alert">
            All patient data on this device was erased (device reported lost, or too many wrong passwords).
          </p>
        )}
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="hint">Works offline after your first online sign-in on this device.</p>
      </form>
    </main>
  );
}
