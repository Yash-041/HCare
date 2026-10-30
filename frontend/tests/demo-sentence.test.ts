// The sentence the demo script asks the presenter to say: it must extract cleanly.
import { expect, it } from "vitest";
import { extractWithRules } from "../src/ai/extract/rules";

it("demo script's Hinglish note extracts correctly", () => {
  const r = extractWithRules([
    { id: "v", kind: "audio", text: "Teen din se bukhar hai, sukhi khansi, BP 150 over 95, paracetamol 500 mg din mein teen baar, penicillin se allergy." },
  ]);
  expect(r.symptoms.map((s) => [s.value.name, s.value.duration])).toEqual([
    ["fever", "3 days"],
    ["cough", null],
  ]);
  expect(r.vitals.bp_systolic?.value).toBe(150);
  expect(r.vitals.bp_diastolic?.value).toBe(95);
  expect(r.medications.map((m) => [m.value.name, m.value.dose, m.value.frequency])).toEqual([["Paracetamol", "500 mg", "three times daily"]]);
  expect(r.allergies.map((a) => a.value.substance)).toEqual(["Penicillin"]);
});
