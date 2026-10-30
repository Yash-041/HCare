/**
 * Local writes. Every change updates the record AND its outbox op in one IndexedDB
 * transaction, so a crash can never leave an edit that will not be synced.
 */
import type { HCareDB } from "./db";
import { newId, nowIso } from "./ids";
import type { ConflictOut, EntityDataMap, EntityName, LocalRecord, OutboxOp } from "./types";

export interface Actor {
  userId: string;
  deviceId: string;
}

function patientIdOf(entity: EntityName, data: unknown): string | undefined {
  if (entity === "patient") return undefined;
  return (data as { patient_id?: string } | null)?.patient_id ?? undefined;
}

async function opsFor(db: HCareDB, entityId: string): Promise<OutboxOp[]> {
  return db.outbox.where("entity_id").equals(entityId).sortBy("seq");
}

/** Queue an op, folding it into the last queued op when that op has never left the device. */
async function enqueue(
  db: HCareDB,
  rec: LocalRecord,
  opType: OutboxOp["op_type"],
  data: unknown | null,
): Promise<void> {
  const queued = await opsFor(db, rec.id);
  const last = queued.at(-1);
  const now = nowIso();

  if (last && last.status === "pending" && !last.sent_once && !last.resolves_conflict_id) {
    await db.outbox.update(last.seq!, { op_type: opType, data, updated_at: now });
    return;
  }
  if (last && last.status === "rejected") {
    // The server refused it permanently; replace it with a fresh op (new op_id, or the
    // idempotency ledger would just replay the rejection).
    await db.outbox.delete(last.seq!);
  }
  await db.outbox.add({
    op_id: newId(),
    entity: rec.entity,
    entity_id: rec.id,
    op_type: opType,
    base_version: rec.version,
    data,
    status: "pending",
    sent_once: false,
    retry_count: 0,
    next_attempt_at: 0,
    created_at: now,
    updated_at: now,
  });
}

export async function saveRecord<E extends EntityName>(
  db: HCareDB,
  actor: Actor,
  entity: E,
  id: string | null,
  data: EntityDataMap[E],
): Promise<string> {
  const recordId = id ?? newId();
  const table = db.records(entity);
  await db.transaction("rw", table, db.outbox, async () => {
    const existing = await table.get(recordId);
    const rec: LocalRecord = {
      id: recordId,
      entity,
      version: existing?.version ?? 0,
      base_data: existing?.base_data ?? null,
      data,
      deleted: false,
      updated_at: nowIso(),
      updated_by: actor.userId,
      device_id: actor.deviceId,
      sync_status: existing?.sync_status === "conflict" ? "conflict" : "pending",
      patient_id: patientIdOf(entity, data),
    };
    await table.put(rec);
    await enqueue(db, rec, "upsert", data);
  });
  return recordId;
}

export async function deleteRecord(db: HCareDB, actor: Actor, entity: EntityName, id: string): Promise<void> {
  const table = db.records(entity);
  await db.transaction("rw", table, db.outbox, async () => {
    const rec = await table.get(id);
    if (!rec) return;
    const queued = await opsFor(db, id);
    if (rec.version === 0 && queued.every((op) => !op.sent_once)) {
      // Never reached the server: forget it entirely.
      await table.delete(id);
      await db.outbox.bulkDelete(queued.map((op) => op.seq!));
      return;
    }
    const updated: LocalRecord = {
      ...rec,
      deleted: true,
      updated_at: nowIso(),
      updated_by: actor.userId,
      device_id: actor.deviceId,
      sync_status: rec.sync_status === "conflict" ? "conflict" : "pending",
    };
    await table.put(updated);
    await enqueue(db, updated, "delete", null);
  });
}

export type Resolution = { kind: "data"; data: unknown } | { kind: "delete" };

/**
 * Resolve a conflict: the chosen result (mine, server's, or a field-level merge) replaces
 * every queued op for the record and is sent as one new op based on the current server version.
 */
export async function resolveConflict(
  db: HCareDB,
  actor: Actor,
  conflict: ConflictOut,
  resolution: Resolution,
): Promise<void> {
  const table = db.records(conflict.entity);
  await db.transaction("rw", table, db.outbox, db.conflicts, async () => {
    const queued = await opsFor(db, conflict.entity_id);
    await db.outbox.bulkDelete(queued.map((op) => op.seq!));

    const existing = await table.get(conflict.entity_id);
    const isDelete = resolution.kind === "delete";
    const data = isDelete ? (existing?.data ?? conflict.current_data) : resolution.data;
    await table.put({
      id: conflict.entity_id,
      entity: conflict.entity,
      version: conflict.current_version,
      base_data: conflict.current_data,
      data,
      deleted: isDelete,
      updated_at: nowIso(),
      updated_by: actor.userId,
      device_id: actor.deviceId,
      sync_status: "pending",
      patient_id: patientIdOf(conflict.entity, data),
    });
    const now = nowIso();
    await db.outbox.add({
      op_id: newId(),
      entity: conflict.entity,
      entity_id: conflict.entity_id,
      op_type: isDelete ? "delete" : "upsert",
      base_version: conflict.current_version,
      data: isDelete ? null : data,
      resolves_conflict_id: conflict.id,
      status: "pending",
      sent_once: false,
      retry_count: 0,
      next_attempt_at: 0,
      created_at: now,
      updated_at: now,
    });
  });
}
