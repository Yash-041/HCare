import Dexie from "dexie";
import { beforeEach, describe, expect, it } from "vitest";
import { getBlob, putBlobs } from "../src/lib/crypto/blobs";
import { isEnvelope, LockedError, newDataKey } from "../src/lib/crypto/vault";
import { HCareDB } from "../src/lib/db";
import { newId } from "../src/lib/ids";
import { saveRecord } from "../src/lib/repo";
import { SearchIndexer } from "../src/lib/search/indexer";
import { search } from "../src/lib/search/search";
import type { ConsultationData, PatientData } from "../src/lib/types";

const actor = { userId: "u1", deviceId: "d1" };
const patient = (name: string, o: Partial<PatientData> = {}): PatientData => ({
  name,
  sex: "female",
  village: "Rampur",
  known_allergies: [{ substance: "Penicillin" }],
  chronic_conditions: [],
  ...o,
});

let db: HCareDB;
let name: string;
const dek = newDataKey();

beforeEach(async () => {
  name = `crypto-${newId()}`;
  db = new HCareDB(name, { requireEncryption: true });
  await db.vault.unlock(dek);
});

/** Read IndexedDB the way an attacker with the device would: no app, no key. */
async function raw(table: string) {
  const plain = new Dexie(name);
  await plain.open();
  const rows = await plain.table(table).toArray();
  plain.close();
  return rows;
}

describe("encryption at rest", () => {
  it("stores patient data only as ciphertext, and reads it back transparently", async () => {
    const id = await saveRecord(db, actor, "patient", null, patient("Sunita Devi"));
    expect((await db.patients.get(id))!.data!.name).toBe("Sunita Devi");

    const [row] = await raw("patients");
    expect(isEnvelope(row.data)).toBe(true);
    const dump = JSON.stringify(await raw("patients")) + JSON.stringify(await raw("outbox"));
    for (const secret of ["Sunita", "Rampur", "Penicillin"]) expect(dump).not.toContain(secret);
    // Indexed bookkeeping stays queryable.
    expect(row).toMatchObject({ id, sync_status: "pending" });
  });

  it("detects tampering and ciphertext moved to another record", async () => {
    const a = await saveRecord(db, actor, "patient", null, patient("A"));
    const b = await saveRecord(db, actor, "patient", null, patient("B"));
    const plain = new Dexie(name);
    await plain.open();
    const rowA = await plain.table("patients").get(a);
    // Copy A's encrypted data into B: AAD binds it to A's id, so decryption must fail.
    await plain.table("patients").update(b, { data: rowA.data });
    plain.close();
    await expect(db.patients.get(b)).rejects.toThrow();

    const plain2 = new Dexie(name);
    await plain2.open();
    rowA.data.ct[0] ^= 1; // flip a bit
    await plain2.table("patients").put(rowA);
    plain2.close();
    await expect(db.patients.get(a)).rejects.toThrow();
  });

  it("refuses to read or write patient data while locked", async () => {
    const id = await saveRecord(db, actor, "patient", null, patient("Locked Test"));
    db.vault.lock();
    await expect(db.patients.get(id)).rejects.toBeInstanceOf(LockedError);
    await expect(saveRecord(db, actor, "patient", null, patient("x"))).rejects.toBeInstanceOf(LockedError);
  });

  it("a different key cannot read the data", async () => {
    const id = await saveRecord(db, actor, "patient", null, patient("Other Key"));
    db.vault.lock();
    await db.vault.unlock(newDataKey());
    await expect(db.patients.get(id)).rejects.toThrow();
  });

  it("encrypts photos and recordings", async () => {
    await putBlobs(db, [{ id: "rec1", blob: new Blob(["teen din se bukhar"], { type: "audio/webm" }), mime_type: "audio/webm" }]);
    const [row] = await raw("blobs");
    expect(row.blob).toBeUndefined();
    expect(new TextDecoder().decode(row.ct)).not.toContain("bukhar");
    expect(await (await getBlob(db, "rec1"))!.text()).toBe("teen din se bukhar");
  });

  it("encrypts capture transcripts and conflict copies", async () => {
    await db.capture_items.put({
      id: "c1", draft_id: "p", blob_id: "c1", kind: "audio", mime_type: "audio/webm", created_at: "", status: "done",
      duration_s: 1, language: "hi", model: "m", transcript: "penicillin se allergy", edited_text: "penicillin se allergy",
      translate: false, translation: null,
    });
    expect(JSON.stringify(await raw("capture_items"))).not.toContain("allergy");
  });
});

describe("search over a blind (hashed) index", () => {
  let indexer: SearchIndexer;
  let pid: string;
  beforeEach(async () => {
    indexer = new SearchIndexer(db);
    indexer.attach();
    pid = await saveRecord(db, actor, "patient", null, patient("Ramesh Kumar", { health_id: "91-2345-6789" }));
    const visit: ConsultationData = {
      patient_id: pid, visit_date: "2026-10-02", raw_transcript: "teen din se bukhar, dolo di", symptoms: [], vitals: {}, diagnosis: [],
      medications: [], allergies: [], sources: [], field_meta: {}, review: { status: "draft" },
    };
    await saveRecord(db, actor, "consultation", null, visit);
    await indexer.idle();
  });

  it("stores no readable words in the index", async () => {
    const dump = JSON.stringify(await raw("search_index")).toLowerCase();
    for (const secret of ["ramesh", "kumar", "fever", "bukhar", "paracetamol", "date:2026"]) {
      expect(dump).not.toContain(secret);
    }
    // Documented trade-off: the plain `date` column stays so date-range filters can use the
    // index; on its own a visit date reveals little.
    expect(dump).toContain('"date":"2026-10-02"');
  });

  it("still finds by prefix, typo, multilingual symptom, brand name and date", async () => {
    const ids = async (q: string) => (await search(db, q)).map((h) => h.entry.entity);
    expect(await ids("rame")).toEqual(["patient"]);
    expect(await ids("rammesh")).toEqual(["patient"]); // typo, via the encrypted word list
    expect(await ids("fever")).toEqual(["consultation"]);
    expect(await ids("बुखार")).toEqual(["consultation"]);
    expect(await ids("paracetamol")).toEqual(["consultation"]);
    expect(await ids("2026-10-02")).toEqual(["consultation"]);
    expect(await ids("91-2345-6789")).toEqual(["patient"]);
  });

  it("stays fast with thousands of encrypted records", async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      id: newId(), entity: "patient" as const, version: 1, deleted: false, updated_at: "", updated_by: "", device_id: "",
      sync_status: "synced" as const, base_data: null, data: patient(`Geeta ${["Devi", "Kumari"][i % 2]} ${i}`, { village: ["Kheri", "Sitapur"][i % 2] }),
    }));
    await db.patients.bulkPut(rows);
    let t = performance.now();
    await indexer.rebuild();
    // The bulkPut above also queued 2,000 hook re-indexes; let them finish (the app's search
    // service awaits this too) so they don't run concurrently with the timed query.
    await indexer.idle();
    const indexMs = performance.now() - t;
    t = performance.now();
    const hits = await search(db, "geeta kheri"); // matches 1,000 records
    const queryMs = performance.now() - t;
    t = performance.now();
    const one = await search(db, "geeta 1337");
    const narrowMs = performance.now() - t;
    console.log(
      `2000 encrypted patients: index ${indexMs.toFixed(0)} ms, broad query ${queryMs.toFixed(0)} ms (${hits.length} shown), narrow ${narrowMs.toFixed(0)} ms`,
    );
    expect(hits).toHaveLength(100); // default page size
    expect(one).toHaveLength(1);
    expect(queryMs).toBeLessThan(400);
    expect(narrowMs).toBeLessThan(200);
  }, 60_000);
});
