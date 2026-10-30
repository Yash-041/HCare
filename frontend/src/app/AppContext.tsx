import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiClient } from "../lib/api";
import { login as doLogin, logout as doLogout, restoreSession, unlock as doUnlock, type LoginMode, type SessionSecrets } from "../lib/auth";
import { encryptExistingData } from "../lib/crypto/migrate";
import { wipeDevice } from "../lib/crypto/wipe";
import { HCareDB } from "../lib/db";
import type { Actor } from "../lib/repo";
import { purgeOldRecordings } from "../lib/retention";
import { SearchService } from "../lib/search/service";
import { SyncEngine } from "../lib/sync/engine";
import { SyncScheduler } from "../lib/sync/scheduler";
import type { CachedSession } from "../lib/types";

/** Lock automatically after this long without interaction. */
const AUTO_LOCK_MS = 15 * 60_000;

// One database, search index and API client per app instance. requireEncryption: nothing
// is ever written to IndexedDB unencrypted; writes while locked fail instead.
const db = new HCareDB("hcare", { requireEncryption: true });
const searchService = new SearchService(db);
let secrets: SessionSecrets | null = null;

async function wipeAndRestart() {
  await wipeDevice(db);
  location.replace("/");
}

const api = new ApiClient({
  baseUrl: import.meta.env.VITE_API_URL ?? "/api",
  getToken: () => secrets?.token ?? null,
  getTransportKey: () => secrets?.transportKey ?? null,
  // The server says this device was reported lost.
  onDeviceWipe: () => void wipeAndRestart(),
});

interface AppCtx {
  db: HCareDB;
  api: ApiClient;
  deviceId: string;
  session: CachedSession;
  actor: Actor;
  engine: SyncEngine;
  scheduler: SyncScheduler;
  search: SearchService;
  signOut: () => Promise<void>;
  lockNow: () => void;
  wipe: () => Promise<void>;
}

interface Boot {
  deviceId: string;
  engine: SyncEngine;
  scheduler: SyncScheduler;
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp outside a signed-in AppProvider");
  return ctx;
}

export type SignIn = (username: string, password: string) => Promise<LoginMode>;
export type Unlock = (password: string) => Promise<void>;

export function AppProvider({
  signedOut,
  locked,
  children,
}: {
  signedOut: (signIn: SignIn) => ReactNode;
  locked: (session: CachedSession, unlock: Unlock, switchUser: () => void) => ReactNode;
  children: ReactNode;
}) {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [session, setSession] = useState<CachedSession | null>(null);
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Ask the browser not to evict our data under storage pressure.
      await navigator.storage?.persist?.().catch(() => false);
      const deviceId = await db.deviceId();
      const restored = await restoreSession(db);
      const engine = new SyncEngine(db, api, deviceId);
      if (cancelled) return;
      setSession(restored);
      setBoot({ deviceId, engine, scheduler: new SyncScheduler(engine, api) });
    })();
    const off = db.vault.onChange((isUnlocked) => {
      setUnlocked(isUnlocked);
      if (!isUnlocked) secrets = null;
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // Everything that touches patient data starts only once the data key is available.
  useEffect(() => {
    if (!boot || !session || !unlocked) return;
    let stopped = false;
    void (async () => {
      await encryptExistingData(db);
      await searchService.start();
      if (!stopped) boot.scheduler.start();
    })();
    // Data minimisation: drop recordings of verified, synced visits after the retention period.
    const off = boot.engine.subscribe((s) => {
      if (s.phase === "idle" && s.lastSyncAt) void purgeOldRecordings(db);
    });
    return () => {
      stopped = true;
      off();
      boot.scheduler.stop();
    };
  }, [boot, session, unlocked]);

  // Auto-lock after inactivity: a phone left on a desk does not stay open.
  useEffect(() => {
    if (!unlocked) return;
    let timer = setTimeout(() => db.vault.lock(), AUTO_LOCK_MS);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => db.vault.lock(), AUTO_LOCK_MS);
    };
    const events = ["pointerdown", "keydown", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [unlocked]);

  const signIn = useCallback<SignIn>(
    async (username, password) => {
      const r = await doLogin(api, db, username, password);
      secrets = r.secrets;
      if (r.mode === "online") boot?.engine.clearAuthRequired();
      setSession(r.session);
      setUnlocked(true);
      return r.mode;
    },
    [boot],
  );

  const unlock = useCallback<Unlock>(
    async (password) => {
      if (!session) return;
      const r = await doUnlock(db, session, password);
      secrets = r.secrets;
      setUnlocked(true);
    },
    [session],
  );

  const signOut = useCallback(async () => {
    await doLogout(db, secrets ? api : undefined);
    secrets = null;
    setSession(null);
  }, []);

  const value = useMemo<AppCtx | null>(
    () =>
      boot && session && unlocked
        ? {
            db,
            api,
            session,
            deviceId: boot.deviceId,
            actor: { userId: session.user.id, deviceId: boot.deviceId },
            engine: boot.engine,
            scheduler: boot.scheduler,
            search: searchService,
            signOut,
            lockNow: () => db.vault.lock(),
            wipe: wipeAndRestart,
          }
        : null,
    [boot, session, unlocked, signOut],
  );

  if (!boot) return <div className="splash">Loading…</div>;
  if (!session) return <>{signedOut(signIn)}</>;
  if (!value) return <>{locked(session, unlock, () => void signOut())}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
