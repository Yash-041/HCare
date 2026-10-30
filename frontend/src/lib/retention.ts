/**
 * Data minimisation: voice recordings are needed while a case file is being checked, not
 * forever. Once a visit is verified and synced, its recordings are deleted from the device
 * after the retention period. The transcript stays in the record; photos of documents
 * stay because they are part of the medical record.
 */
import type { HCareDB } from "./db";

export const RECORDING_RETENTION_DAYS = 30;

export async function purgeOldRecordings(db: HCareDB, now = Date.now(), days = RECORDING_RETENTION_DAYS): Promise<number> {
  const cutoff = now - days * 86_400_000;
  const visits = await db.consultations.where("sync_status").equals("synced").toArray();
  const expired = visits.flatMap((v) => {
    const r = v.data?.review;
    if (!r || r.status !== "verified" || !r.reviewed_at || Date.parse(r.reviewed_at) > cutoff) return [];
    return v.data!.sources.filter((s) => s.kind === "audio").map((s) => s.id);
  });
  if (!expired.length) return 0;
  const present = (await db.blobs.bulkGet(expired)).filter(Boolean).map((b) => b!.id);
  await db.blobs.bulkDelete(present);
  return present.length;
}
