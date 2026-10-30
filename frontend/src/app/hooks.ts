import { useLiveQuery } from "dexie-react-hooks";
import { useSyncExternalStore } from "react";
import type { SyncState } from "../lib/sync/engine";
import type { Connectivity } from "../lib/sync/scheduler";
import { useApp } from "./AppContext";

export function useSyncState(): SyncState {
  const { engine } = useApp();
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.state,
  );
}

export function useConnectivity(): Connectivity {
  const { scheduler } = useApp();
  return useSyncExternalStore(
    (cb) => scheduler.subscribe(cb),
    () => scheduler.connectivity,
  );
}

export interface OutboxSummary {
  pending: number;
  conflicts: number;
  rejected: number;
}

export function useOutboxSummary(): OutboxSummary {
  const { db } = useApp();
  return useLiveQuery(
    async () => ({
      pending: await db.outbox.where("status").anyOf("pending", "sending").count(),
      conflicts: await db.conflicts.count(),
      rejected: await db.outbox.where("status").equals("rejected").count(),
    }),
    [db],
    { pending: 0, conflicts: 0, rejected: 0 },
  );
}

export type BadgeKind = "offline" | "pending" | "syncing" | "synced" | "conflict" | "error";

export function useSyncBadge(): { kind: BadgeKind; label: string } {
  const connectivity = useConnectivity();
  const state = useSyncState();
  const { pending, conflicts, rejected } = useOutboxSummary();

  if (conflicts > 0) return { kind: "conflict", label: `Conflict · ${conflicts}` };
  if (rejected > 0) return { kind: "error", label: `Needs fix · ${rejected}` };
  if (state.phase === "auth-required") return { kind: "error", label: "Sign in to sync" };
  if (connectivity !== "online") return { kind: "offline", label: pending ? `Offline · ${pending} pending` : "Offline" };
  // "Synced" only after a sync has actually completed this session; right after sign-in
  // nothing may have been downloaded yet.
  if (state.phase === "syncing" || !state.lastSyncAt) return { kind: "syncing", label: "Syncing…" };
  if (pending > 0) return { kind: "pending", label: `Pending · ${pending}` };
  return { kind: "synced", label: "Synced" };
}
