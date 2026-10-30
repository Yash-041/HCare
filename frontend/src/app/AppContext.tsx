import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiClient } from "../lib/api";
import { login as doLogin, logout as doLogout, restoreSession, type LoginMode } from "../lib/auth";
import { HCareDB } from "../lib/db";
import { SearchService } from "../lib/search/service";
import type { Actor } from "../lib/repo";
import { SyncEngine } from "../lib/sync/engine";
import { SyncScheduler } from "../lib/sync/scheduler";
import type { CachedSession } from "../lib/types";

// One database, search index and API client per app instance.
const db = new HCareDB();
const searchService = new SearchService(db);
let token: string | null = null;
const api = new ApiClient({ baseUrl: import.meta.env.VITE_API_URL ?? "/api", getToken: () => token });

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

export function AppProvider({
  signedOut,
  children,
}: {
  signedOut: (signIn: SignIn) => ReactNode;
  children: ReactNode;
}) {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [session, setSession] = useState<CachedSession | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Ask the browser not to evict our data under storage pressure.
      await navigator.storage?.persist?.().catch(() => false);
      const deviceId = await db.deviceId();
      // Hooks must be attached before any record is written this session.
      await searchService.start();
      const restored = await restoreSession(db);
      const engine = new SyncEngine(db, api, deviceId);
      if (cancelled) return;
      token = restored?.token ?? null;
      setSession(restored);
      setBoot({ deviceId, engine, scheduler: new SyncScheduler(engine, api) });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!boot || !session) return;
    boot.scheduler.start();
    return () => boot.scheduler.stop();
  }, [boot, session]);

  const signIn = useCallback<SignIn>(
    async (username, password) => {
      const { session: s, mode } = await doLogin(api, db, username, password);
      token = s.token;
      if (mode === "online") boot?.engine.clearAuthRequired();
      setSession(s);
      return mode;
    },
    [boot],
  );

  const signOut = useCallback(async () => {
    await doLogout(db);
    token = null;
    setSession(null);
  }, []);

  const value = useMemo<AppCtx | null>(
    () =>
      boot && session
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
          }
        : null,
    [boot, session, signOut],
  );

  if (!boot) return <div className="splash">Loading…</div>;
  if (!value) return <>{signedOut(signIn)}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
