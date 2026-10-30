import { beforeEach, describe, expect, it } from "vitest";
import { HCareDB } from "../src/lib/db";
import { newId } from "../src/lib/ids";
import { deleteRecord, saveRecord } from "../src/lib/repo";
import { SearchIndexer } from "../src/lib/search/indexer";
import { embedPending, parseQuery, search, type Embed } from "../src/lib/search/search";
import type { ConsultationData, PatientData } from "../src/lib/types";

const actor = { userId: "u1", deviceId: "d1" };

function patient(name: string, extra: Partial<PatientData> = {}): PatientData {
  return { name, sex: "unknown", known_allergies: [], chronic_conditions: [], ...extra };
}

function visit(patientId: string, date: string, extra: Partial<ConsultationData> = {}): ConsultationData {
  return {
    patient_id: patientId,
    visit_date: date,
    symptoms: [],
    vitals: {},
    diagnosis: [],
    medications: [],
    allergies: [],
    sources: [],
    field_meta: {},
    review: { status: "draft" },
    ...extra,
  };
}

let db: HCareDB;
let indexer: SearchIndexer;
let ramesh: string;
let sunita: string;

beforeEach(async () => {
  db = new HCareDB(`search-${newId()}`);
  indexer = new SearchIndexer(db);
  indexer.attach();
  ramesh = await saveRecord(db, actor, "patient", null, patient("Ramesh Kumar", { village: "Rampur", health_id: "91-2345-6789", phone: "98765 43210" }));
  sunita = await saveRecord(
    db,
    actor,
    "patient",
    null,
    patient("Sunita Devi", { village: "Kheri", chronic_conditions: ["Hypertension"], known_allergies: [{ substance: "Penicillin" }] }),
  );
  await saveRecord(db, actor, "consultation", null, visit(ramesh, "2026-10-02", {
    chief_complaint: "Fever for 3 days",
    symptoms: [{ name: "fever", duration: "3 days" }],
    medications: [{ name: "Paracetamol", dose: "500 mg" }],
  }));
  // Unstructured draft: only a Hinglish transcript. Must still be findable.
  await saveRecord(db, actor, "consultation", null, visit(sunita, "2026-10-20", {
    raw_transcript: "do din se pet dard aur ulti. Dolo di gayi.",
  }));
  await saveRecord(db, actor, "consultation", null, visit(sunita, "2026-09-11", {
    diagnosis: ["Acute gastroenteritis"],
    lab_results: [{ name: "Haemoglobin", value: "9.8", unit: "g/dL" }],
  }));
  await indexer.idle();
});

const ids = async (q: string, f = {}) => (await search(db, q, f)).map((h) => h.entry.entity);

describe("index maintenance", () => {
  it("indexes every saved record automatically", async () => {
    expect(await db.search_index.count()).toBe(5);
  });

  it("follows edits and deletions", async () => {
    await saveRecord(db, actor, "patient", ramesh, patient("Ramesh Yadav"));
    await indexer.idle();
    expect(await ids("yadav")).toEqual(["patient"]);
    expect(await ids("kumar")).toEqual([]);

    await deleteRecord(db, actor, "patient", ramesh);
    await indexer.idle();
    expect(await ids("ramesh")).toEqual([]);
  });

  it("indexes records arriving through sync (direct table writes)", async () => {
    await db.patients.put({
      id: newId(), entity: "patient", version: 3, data: patient("Pulled From Server"), base_data: null, deleted: false,
      updated_at: "", updated_by: "", device_id: "", sync_status: "synced",
    });
    await indexer.idle();
    expect(await ids("pulled")).toEqual(["patient"]);
  });

  it("rebuilds from scratch when needed", async () => {
    await db.search_index.clear();
    await db.setMeta("search_index_version", 0);
    await indexer.ensureFresh();
    expect(await db.search_index.count()).toBe(5);
  });
});

describe("queries", () => {
  it("by name prefix, village, health ID and phone", async () => {
    expect(await ids("rame")).toEqual(["patient"]);
    expect(await ids("kheri")).toEqual(["patient"]);
    expect(await ids("91-2345-6789")).toEqual(["patient"]);
    expect(await ids("9876543210")).toEqual(["patient"]);
  });

  it("tolerates a typo in a name", async () => {
    const [hit] = await search(db, "sunitta");
    expect(hit.entry.patient_id).toBe(sunita);
    expect(hit.reasons[0]).toMatch(/≈ sunita/);
  });

  it("symptom in any language finds visits recorded in another", async () => {
    // Structured English "fever" visit, queried in Hinglish and Devanagari.
    for (const q of ["fever", "bukhar", "बुखार"]) {
      const hits = await search(db, q);
      expect(hits.map((h) => h.entry.patient_id), q).toEqual([ramesh]);
      expect(hits[0].reasons).toEqual(["symptom: fever"]);
    }
    // Unstructured Hinglish transcript, queried in English.
    expect((await search(db, "abdominal pain")).map((h) => h.entry.patient_id)).toEqual([sunita]);
    expect((await search(db, "vomiting")).map((h) => h.entry.patient_id)).toEqual([sunita]);
  });

  it("brand names find the generic and vice versa", async () => {
    const hits = await search(db, "dolo");
    expect(hits.map((h) => h.entry.patient_id).sort()).toEqual([ramesh, sunita].sort());
  });

  it("diagnosis, lab, allergy and chronic condition words", async () => {
    expect(await ids("gastroenteritis")).toEqual(["consultation"]);
    expect(await ids("haemoglobin")).toEqual(["consultation"]);
    expect(await ids("penicillin")).toEqual(["patient"]);
    expect(await ids("hypertension")).toEqual(["patient"]);
  });

  it("all words must match (AND)", async () => {
    expect((await search(db, "fever paracetamol")).length).toBe(1);
    expect((await search(db, "fever gastroenteritis")).length).toBe(0);
  });

  it("dates in the query and as filters", async () => {
    expect(await ids("2026-10-02")).toEqual(["consultation"]);
    expect(await ids("20/10/2026")).toEqual(["consultation"]);
    expect((await search(db, "sunita", {}))[0].entry.entity).toBe("patient");
    const oct = await search(db, "pain", { dateFrom: "2026-10-01", dateTo: "2026-10-31" });
    expect(oct.map((h) => h.entry.date)).toEqual(["2026-10-20"]);
  });

  it("a date range alone lists the visits in it, newest first", async () => {
    const hits = await search(db, "", { dateFrom: "2026-10-01", dateTo: "2026-10-31" });
    expect(hits.map((h) => h.entry.date)).toEqual(["2026-10-20", "2026-10-02"]);
  });

  it("type filter", async () => {
    expect(await ids("ramesh", { types: ["consultation"] })).toEqual([]);
  });

  it("parses multi-word Hindi phrases as one clinical term", () => {
    expect(parseQuery("pet dard 2026-10").terms.map((t) => t.label)).toEqual(["date 2026-10", "symptom: abdominal pain"]);
  });
});

describe("semantic layer", () => {
  // Deterministic stand-in for the embedding model: bag of concept words -> unit vector.
  const CONCEPTS = ["breath", "cough", "fever", "pain", "stomach", "vomit", "paracetamol"];
  const SYNONYMS: Record<string, string> = { breathing: "breath", breathlessness: "breath", abdominal: "stomach", vomiting: "vomit", ulti: "vomit" };
  const fakeEmbed: Embed = async (texts) =>
    texts.map((t) => {
      const v = CONCEPTS.map(() => 0);
      for (const w of t.toLowerCase().split(/\W+/)) {
        const c = SYNONYMS[w] ?? w;
        const i = CONCEPTS.findIndex((k) => c.startsWith(k));
        if (i >= 0) v[i] += 1;
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });

  it("embeds index entries and keeps embeddings while the text is unchanged", async () => {
    expect(await embedPending(db, fakeEmbed)).toBeGreaterThan(0);
    expect(await embedPending(db, fakeEmbed)).toBe(0);
  });

  it("adds related records the keywords miss", async () => {
    await saveRecord(db, actor, "consultation", null, visit(ramesh, "2026-10-25", { symptoms: [{ name: "breathlessness" }] }));
    await indexer.idle();
    await embedPending(db, fakeEmbed);
    const hits = await search(db, "breathing", {}, { embed: fakeEmbed });
    expect(hits.map((h) => h.entry.date)).toEqual(["2026-10-25"]);
    expect(hits[0].reasons[0]).toMatch(/^related/);
  });
});

describe("performance", () => {
  it("indexes and searches thousands of records quickly", async () => {
    const big = new HCareDB(`search-perf-${newId()}`);
    const idx = new SearchIndexer(big);
    const names = ["Ramesh", "Sunita", "Geeta", "Mohan", "Kamla", "Ravi", "Anita", "Suresh", "Pooja", "Arjun"];
    const villages = ["Rampur", "Kheri", "Sitapur", "Bhavnagar", "Nandgaon"];
    const symptoms = ["fever", "cough", "headache", "vomiting", "diarrhoea", "body ache", "weakness"];
    const patients = Array.from({ length: 2000 }, (_, i) => ({
      id: newId(), entity: "patient" as const, version: 1, deleted: false, updated_at: "", updated_by: "", device_id: "",
      sync_status: "synced" as const, base_data: null,
      data: patient(`${names[i % 10]} ${["Kumar", "Devi", "Singh", "Yadav"][i % 4]} ${i}`, { village: villages[i % 5] }),
    }));
    const visits = patients.flatMap((p, i) =>
      [0, 1].map((k) => ({
        id: newId(), entity: "consultation" as const, version: 1, deleted: false, updated_at: "", updated_by: "", device_id: "",
        sync_status: "synced" as const, base_data: null, patient_id: p.id,
        data: visit(p.id, `2026-${String((i % 9) + 1).padStart(2, "0")}-1${k}`, {
          symptoms: [{ name: symptoms[(i + k) % 7] }],
          raw_transcript: `${symptoms[(i + k) % 7]} since ${k + 2} days, paracetamol given`,
        }),
      })),
    );
    await big.patients.bulkPut(patients);
    await big.consultations.bulkPut(visits);

    let t = performance.now();
    await idx.rebuild();
    const indexMs = performance.now() - t;

    t = performance.now();
    const hits = await search(big, "bukhar", { dateFrom: "2026-03-01", dateTo: "2026-03-31" });
    const queryMs = performance.now() - t;
    t = performance.now();
    await search(big, "geeta rampur");
    const nameMs = performance.now() - t;

    console.log(`6000 records: index ${indexMs.toFixed(0)} ms, symptom+date query ${queryMs.toFixed(0)} ms, name query ${nameMs.toFixed(0)} ms`);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.entry.date!.startsWith("2026-03"))).toBe(true);
    // Measured ~6 ms / ~2 ms. Generous ceilings that still catch a regression like the
    // anyOf() one (8 s per query).
    expect(queryMs).toBeLessThan(200);
    expect(nameMs).toBeLessThan(200);
  }, 120_000);
});
