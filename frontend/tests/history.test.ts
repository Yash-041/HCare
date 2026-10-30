import { describe, expect, it } from "vitest";
import { entryFor } from "../src/lib/search/indexer";
import { buildNarrativeMessages, factsOf, validateNarrative, writeNarrative } from "../src/lib/history/narrative";
import { summarizeHistory } from "../src/lib/history/summary";
import type { ConsultationData, LocalRecord, PatientData } from "../src/lib/types";

const base = { version: 1, deleted: false, updated_at: "", updated_by: "", device_id: "", sync_status: "synced" as const, base_data: null };

const patient: LocalRecord<PatientData> = {
  ...base,
  id: "p1",
  entity: "patient",
  data: { name: "Kamla Devi", sex: "female", known_allergies: [{ substance: "Penicillin", reaction: "rash" }], chronic_conditions: ["Hypertension"] },
};

let n = 0;
function visit(date: string, d: Partial<ConsultationData>, status: "draft" | "verified" | "rejected" = "verified"): LocalRecord<ConsultationData> {
  return {
    ...base,
    id: `c${++n}`,
    entity: "consultation",
    patient_id: "p1",
    data: {
      patient_id: "p1",
      visit_date: date,
      symptoms: [],
      vitals: {},
      diagnosis: [],
      medications: [],
      allergies: [],
      lab_results: [],
      sources: [],
      field_meta: {},
      review: status === "draft" ? { status } : { status, reviewed_by: "u", reviewed_at: `${date}T10:00:00Z` },
      ...d,
    },
  };
}

const history = [
  visit("2026-03-10", {
    chief_complaint: "Headache",
    symptoms: [{ name: "headache" }],
    vitals: { bp_systolic: 150, bp_diastolic: 95, weight_kg: 62 },
    diagnosis: ["Hypertension"],
    medications: [{ name: "Amlodipine", dose: "5 mg", frequency: "once daily" }],
    lab_results: [{ name: "Haemoglobin", value: "11.2", unit: "g/dL" }],
  }),
  visit("2026-06-02", {
    chief_complaint: "Fever and cough",
    symptoms: [{ name: "fever" }, { name: "cough" }],
    vitals: { bp_systolic: 146, bp_diastolic: 92, weight_kg: 60.5 },
    medications: [{ name: "Paracetamol", dose: "500 mg", frequency: "three times daily", duration: "3 days" }],
    allergies: [{ substance: "Penicillin" }],
  }),
  visit("2026-09-15", {
    chief_complaint: "Weakness",
    symptoms: [{ name: "weakness" }],
    vitals: { bp_systolic: 142, bp_diastolic: 88, weight_kg: 58 },
    medications: [{ name: "amlo", dose: "5 mg", frequency: "once daily" }],
    lab_results: [{ name: "Haemoglobin", value: "9.8", unit: "g/dL" }],
  }, "draft"),
  visit("2026-01-01", { diagnosis: ["Typhoid"] }, "rejected"),
];

const current = visit("2026-10-30", {
  symptoms: [{ name: "fever" }],
  medications: [{ name: "Amoxicillin" }, { name: "Penicillin" }],
});

const summarize = () =>
  summarizeHistory({
    patient,
    consultations: [...history, current],
    current,
    index: [...history, current].map((c) => entryFor(c)!),
  });

describe("history summary", () => {
  it("counts visits, excluding the current one and rejected case files", () => {
    const s = summarize();
    expect(s.visitCount).toBe(3);
    expect([s.firstVisit, s.lastVisit]).toEqual(["2026-03-10", "2026-09-15"]);
  });

  it("merges allergies from the profile and visits, with every source", () => {
    const [penicillin] = summarize().allergies;
    expect(penicillin.text).toBe("Penicillin (rash)");
    expect(penicillin.sources.map((s) => s.entity)).toEqual(["patient", "consultation"]);
  });

  it("conditions show chronic status and when they were recorded", () => {
    const [htn] = summarize().conditions;
    expect(htn.text).toMatch(/^Hypertension, known chronic condition \(recorded 10 Mar 2026\)/);
    expect(htn.sources.map((s) => s.id)).toEqual(["p1", history[0].id]);
  });

  it("medications: brand and generic merge, newest first, with last details", () => {
    const meds = summarize().medications;
    expect(meds[0].text).toBe("Amlodipine 5 mg, once daily: last prescribed 15 Sept 2026, 2 visits in total");
    expect(meds[0].sources.map((s) => s.date)).toEqual(["2026-03-10", "2026-09-15"]);
    expect(meds[1].text).toMatch(/^Paracetamol 500 mg, three times daily, for 3 days: last prescribed 2 Jun 2026$/);
  });

  it("trends describe the direction with exact values and sources", () => {
    const t = Object.fromEntries(summarize().trends.map((x) => [x.key, x]));
    expect(t.bp.series.map((s) => s.points.map((p) => p.value))).toEqual([
      [150, 146, 142],
      [95, 92, 88],
    ]);
    expect(t.bp.statement.text).toBe(
      // 142/88 counts: systolic >= 140.
      "Systolic BP fell from 150 to 142 mmHg (10 Mar 2026 → 15 Sept 2026). BP was 140/90 or higher on 3 visits of 3.",
    );
    expect(t.weight.statement.text).toMatch(/^Weight fell from 62.0 to 58.0 kg/);
    expect(t["lab:Haemoglobin"].statement.text).toMatch(/^Haemoglobin fell from 11.2 to 9.8 g\/dL/);
  });

  it("marks facts from unverified drafts", () => {
    const hb = summarize().trends.find((t) => t.key === "lab:Haemoglobin")!;
    expect(hb.statement.sources.map((s) => s.unverified)).toEqual([false, true]);
  });

  it("retrieves the most relevant past visit for the current complaint first", () => {
    const [top] = summarize().relevant;
    expect(top.source.date).toBe("2026-06-02");
    expect(top.shared).toContain("symptom: fever");
  });

  it("alerts: prescribed drug the patient is allergic to; persistently high BP", () => {
    const alerts = summarize().alerts.map((a) => a.text);
    expect(alerts).toContain("Penicillin is prescribed in this visit, but the patient has a recorded allergy to it.");
    expect(alerts).toContain("Systolic BP was 140 or higher at the last two visits.");
  });

  it("works for a brand-new patient", () => {
    const s = summarizeHistory({ patient, consultations: [] });
    expect(s.visitCount).toBe(0);
    expect(s.allergies).toHaveLength(1); // from the profile
  });
});

describe("narrative guard rails", () => {
  const facts = factsOf(summarize());
  const cite = (needle: string) => facts.findIndex((f) => f.text.includes(needle)) + 1;

  it("prompt lists numbered facts only", () => {
    const [, user] = buildNarrativeMessages(facts);
    expect(user.content).toContain(`[${cite("Haemoglobin fell")}] Haemoglobin fell from 11.2 to 9.8`);
  });

  it("keeps cited, supported sentences and maps them to source records", () => {
    const r = validateNarrative(
      `Kamla has hypertension and a penicillin allergy [${cite("Condition: Hypertension")}][${cite("Allergy: Penicillin")}]. Haemoglobin fell from 11.2 to 9.8 g/dL [${cite("Haemoglobin fell")}].`,
      facts,
    );
    expect(r.dropped).toBe(0);
    expect(r.sentences).toHaveLength(2);
    expect(r.sentences[1].sources.map((s) => s.date)).toEqual(["2026-03-10", "2026-09-15"]);
  });

  it("drops uncited, mis-cited, invented-number and invented-content sentences", () => {
    const r = validateNarrative(
      [
        "She is doing well overall.", // no citation
        "Her weight is stable [99].", // unknown fact
        `Haemoglobin fell to 7.5 g/dL [${cite("Haemoglobin fell")}].`, // number not in fact
        `She likely has iron deficiency anaemia needing transfusion [${cite("Haemoglobin fell")}].`, // invented diagnosis
        `Systolic BP fell from 150 to 142 mmHg [${cite("Systolic BP fell")}].`, // fine
      ].join(" "),
      facts,
    );
    expect(r.sentences.map((s) => s.text)).toEqual(["Systolic BP fell from 150 to 142 mmHg."]);
    expect(r.dropped).toBe(4);
  });

  it("end to end with a model stand-in", async () => {
    const r = await writeNarrative(summarize(), async () => `Penicillin allergy is recorded [${cite("Allergy: Penicillin")}].`);
    expect(r.sentences[0].sources[0].entity).toBe("patient");
  });
});
