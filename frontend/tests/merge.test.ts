import { describe, expect, it } from "vitest";
import { applyMerge, decisionSummary, initialDecisions, planMerge, unresolved } from "../src/lib/merge";
import type { ConsultationData, PatientData } from "../src/lib/types";

const patient = (o: Partial<PatientData> = {}): PatientData => ({
  name: "Ravi Shankar",
  sex: "male",
  village: "Kheri",
  phone: null,
  age_years: 40,
  known_allergies: [],
  chronic_conditions: [],
  ...o,
});

describe("planMerge (patients)", () => {
  const base = patient();

  it("fields changed on one side merge automatically; only real clashes need a person", () => {
    const mine = patient({ village: "Kheri Khurd", age_years: 41 });
    const theirs = patient({ village: "Kheri Kalan", phone: "9000000001" });
    const plan = planMerge(base, mine, theirs);
    expect(plan.map((p) => [p.path, p.status, p.suggestion])).toEqual([
      ["village", "clash", null],
      ["phone", "theirs", "theirs"],
      ["age_years", "mine", "mine"],
    ]);
    expect(unresolved(plan, initialDecisions(plan)).map((p) => p.path)).toEqual(["village"]);

    const merged = applyMerge("patient", mine, theirs, plan, { ...initialDecisions(plan), village: "theirs" });
    expect(merged).toMatchObject({ village: "Kheri Kalan", phone: "9000000001", age_years: 41 });
  });

  it("both sides making the same change is not a conflict", () => {
    expect(planMerge(base, patient({ phone: "1" }), patient({ phone: "1" }))).toEqual([]);
  });

  it("allergies: a clash is combined by default", () => {
    const mine = patient({ known_allergies: [{ substance: "Penicillin" }] });
    const theirs = patient({ known_allergies: [{ substance: "Sulfa drugs" }] });
    const [p] = planMerge(base, mine, theirs);
    expect(p).toMatchObject({ path: "known_allergies", status: "clash", suggestion: "both" });
    const merged = applyMerge("patient", mine, theirs, [p], initialDecisions([p]));
    expect(merged.known_allergies.map((a) => a.substance)).toEqual(["Penicillin", "Sulfa drugs"]);
  });

  it("allergies: a one-sided removal is NOT applied silently", () => {
    const withAllergy = patient({ known_allergies: [{ substance: "Penicillin" }] });
    const removedOnTheirs = patient({ known_allergies: [] });
    const [p] = planMerge(withAllergy, withAllergy, removedOnTheirs);
    // Only the server changed it, but taking that change would drop Penicillin.
    expect(p).toMatchObject({ status: "clash", suggestion: "both" });
    expect(p.note).toMatch(/none is lost/);
  });

  it("decision summary for the audit log", () => {
    const mine = patient({ village: "A" });
    const theirs = patient({ phone: "1" });
    const plan = planMerge(base, mine, theirs);
    expect(decisionSummary(plan, initialDecisions(plan))).toEqual({ village: "mine", phone: "theirs" });
  });
});

describe("planMerge (case files)", () => {
  const visit = (o: Partial<ConsultationData> = {}): ConsultationData => ({
    patient_id: "p",
    visit_date: "2026-10-30",
    chief_complaint: "Fever",
    symptoms: [{ name: "fever" }],
    vitals: { bp_systolic: 130, bp_diastolic: 85 },
    diagnosis: [],
    medications: [],
    allergies: [],
    sources: [{ id: "a1", kind: "audio" }],
    field_meta: {},
    review: { status: "draft" },
    ...o,
  });

  it("vitals merge per value: BP from one device, weight from the other", () => {
    const base = visit();
    const mine = visit({ vitals: { bp_systolic: 130, bp_diastolic: 85, weight_kg: 54 } });
    const theirs = visit({ vitals: { bp_systolic: 138, bp_diastolic: 85 } });
    const plan = planMerge(base, mine, theirs);
    expect(plan.map((p) => [p.path, p.status])).toEqual([
      ["vitals.bp_systolic", "theirs"],
      ["vitals.weight_kg", "mine"],
    ]);
    const merged = applyMerge("consultation", mine, theirs, plan, initialDecisions(plan));
    expect(merged.vitals).toEqual({ bp_systolic: 138, bp_diastolic: 85, weight_kg: 54 });
  });

  it("lists can be combined on request", () => {
    const base = visit();
    const mine = visit({ medications: [{ name: "Paracetamol" }] });
    const theirs = visit({ medications: [{ name: "ORS" }] });
    const plan = planMerge(base, mine, theirs);
    expect(plan[0]).toMatchObject({ path: "medications", status: "clash", suggestion: null, combinable: true });
    const merged = applyMerge("consultation", mine, theirs, plan, { medications: "both" });
    expect(merged.medications.map((m) => m.name)).toEqual(["Paracetamol", "ORS"]);
  });

  it("keeps every source either side referenced", () => {
    const mine = visit({ sources: [{ id: "a1", kind: "audio" }, { id: "img2", kind: "image" }], notes: "x" });
    const theirs = visit({ sources: [{ id: "a1", kind: "audio" }, { id: "a3", kind: "audio" }] });
    const plan = planMerge(visit(), mine, theirs);
    const merged = applyMerge("consultation", mine, theirs, plan, initialDecisions(plan));
    expect(merged.sources.map((s) => s.id)).toEqual(["a1", "a3", "img2"]);
  });

  it("a verification stands only for the exact content that was verified", () => {
    const verified = { status: "verified" as const, reviewed_by: "doc", reviewed_at: "2026-10-30T10:00:00Z" };
    const base = visit();
    const theirs = visit({ chief_complaint: "Fever, 3 days", review: verified });
    const mine = visit({ notes: "Advised fluids" });
    const plan = planMerge(base, mine, theirs);

    // Taking everything from the verified server version keeps its verification...
    const allTheirs = applyMerge("consultation", mine, theirs, plan, Object.fromEntries(plan.map((p) => [p.path, "theirs"])));
    expect(allTheirs.review).toEqual(verified);
    // ...but merging in my notes changes the content, so it must be verified again.
    const merged = applyMerge("consultation", mine, theirs, plan, initialDecisions(plan));
    expect(merged.review).toEqual({ status: "draft" });
  });

  it("field provenance follows each decision", () => {
    const mine = visit({ chief_complaint: "High fever", field_meta: { chief_complaint: { source: "manual", verified: true } } });
    const theirs = visit({ chief_complaint: "Fever", field_meta: { chief_complaint: { source: "rule", confidence: 0.6 } } });
    const plan = planMerge(visit({ chief_complaint: null }), mine, theirs);
    expect(applyMerge("consultation", mine, theirs, plan, { chief_complaint: "mine" }).field_meta.chief_complaint.source).toBe("manual");
    expect(applyMerge("consultation", mine, theirs, plan, { chief_complaint: "theirs" }).field_meta.chief_complaint.source).toBe("rule");
  });

  it("refuses to build a merge with an undecided clash", () => {
    const plan = planMerge(visit(), visit({ chief_complaint: "A" }), visit({ chief_complaint: "B" }));
    expect(() => applyMerge("consultation", visit(), visit(), plan, {})).toThrow(/No decision for Chief complaint/);
  });
});
