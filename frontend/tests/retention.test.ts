import { describe, expect, it } from "vitest";
import { putBlobs } from "../src/lib/crypto/blobs";
import { HCareDB } from "../src/lib/db";
import { newId } from "../src/lib/ids";
import { purgeOldRecordings } from "../src/lib/retention";
import type { ConsultationData, LocalRecord } from "../src/lib/types";

function visit(o: Partial<ConsultationData>, sync: LocalRecord["sync_status"] = "synced"): LocalRecord<ConsultationData> {
  return {
    id: newId(), entity: "consultation", version: 1, deleted: false, updated_at: "", updated_by: "", device_id: "", sync_status: sync, base_data: null,
    patient_id: "p",
    data: {
      patient_id: "p", visit_date: "2026-01-01", symptoms: [], vitals: {}, diagnosis: [], medications: [], allergies: [], field_meta: {},
      sources: [{ id: `audio-${newId()}`, kind: "audio" }, { id: `img-${newId()}`, kind: "image", document_id: "d" }],
      review: { status: "verified", reviewed_by: "u", reviewed_at: "2026-01-02T10:00:00Z" },
      ...o,
    },
  };
}

describe("recording retention", () => {
  it("deletes recordings of verified, synced visits after 30 days; keeps everything else", async () => {
    const db = new HCareDB(`ret-${newId()}`);
    const old = visit({});
    const recent = visit({ review: { status: "verified", reviewed_by: "u", reviewed_at: "2026-10-25T10:00:00Z" } });
    const draft = visit({ review: { status: "draft" } });
    const unsynced = visit({}, "pending");
    const all = [old, recent, draft, unsynced];
    await db.consultations.bulkPut(all);
    await putBlobs(db, all.flatMap((v) => v.data!.sources.map((s) => ({ id: s.id, blob: new Blob(["x"]), mime_type: "audio/webm" }))));

    const removed = await purgeOldRecordings(db, Date.parse("2026-10-30T00:00:00Z"));
    expect(removed).toBe(1);
    expect(await db.blobs.get(old.data!.sources[0].id)).toBeUndefined(); // old recording gone
    expect(await db.blobs.get(old.data!.sources[1].id)).toBeDefined(); // document photo kept
    for (const v of [recent, draft, unsynced]) expect(await db.blobs.get(v.data!.sources[0].id)).toBeDefined();
    expect((await db.consultations.get(old.id))!.data!.sources).toHaveLength(2); // transcript/source refs stay
  });
});
