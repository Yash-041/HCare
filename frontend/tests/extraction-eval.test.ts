/**
 * Field-level precision / recall / F1 of the rule-based extractor on labeled samples.
 * Prints a table (shown with `npx vitest run tests/extraction-eval.test.ts`) and guards
 * against regressions with minimum scores.
 */
import { describe, expect, it } from "vitest";
import { extractWithRules } from "../src/ai/extract/rules";
import { SAMPLES } from "./eval/extraction-samples";

type Field = "symptoms" | "vitals" | "medications" | "allergies" | "diagnosis" | "labs";
const FIELDS: Field[] = ["symptoms", "vitals", "medications", "allergies", "diagnosis", "labs"];

function predicted(text: string): Record<Field, string[]> {
  const r = extractWithRules([{ id: "s", kind: "audio", text }]);
  return {
    symptoms: r.symptoms.map((s) => s.value.name),
    vitals: Object.entries(r.vitals).map(([k, v]) => `${k}=${v!.value}`),
    medications: r.medications.map((m) => m.value.name),
    allergies: r.allergies.map((a) => a.value.substance),
    diagnosis: r.diagnosis.map((d) => d.value.toLowerCase()),
    labs: r.lab_results.map((l) => l.value.name),
  };
}

function gold(s: (typeof SAMPLES)[number]): Record<Field, string[]> {
  return {
    symptoms: s.expect.symptoms ?? [],
    vitals: Object.entries(s.expect.vitals ?? {}).map(([k, v]) => `${k}=${v}`),
    medications: s.expect.medications ?? [],
    allergies: s.expect.allergies ?? [],
    diagnosis: (s.expect.diagnosis ?? []).map((d) => d.toLowerCase()),
    labs: s.expect.labs ?? [],
  };
}

const scores = Object.fromEntries(FIELDS.map((f) => [f, { tp: 0, fp: 0, fn: 0 }])) as Record<Field, { tp: number; fp: number; fn: number }>;
const misses: string[] = [];
for (const s of SAMPLES) {
  const p = predicted(s.text);
  const g = gold(s);
  for (const f of FIELDS) {
    for (const x of p[f]) {
      if (g[f].includes(x)) scores[f].tp++;
      else {
        scores[f].fp++;
        misses.push(`${s.id} ${f}: extra "${x}"`);
      }
    }
    for (const x of g[f]) {
      if (!p[f].includes(x)) {
        scores[f].fn++;
        misses.push(`${s.id} ${f}: missed "${x}"`);
      }
    }
  }
}

const prf = ({ tp, fp, fn }: { tp: number; fp: number; fn: number }) => {
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
};
const total = Object.values(scores).reduce((a, b) => ({ tp: a.tp + b.tp, fp: a.fp + b.fp, fn: a.fn + b.fn }));

describe(`rule-based extraction on ${SAMPLES.length} labeled notes`, () => {
  it("report", () => {
    const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);
    const lines = [...FIELDS.map((f) => [f, scores[f]] as const), ["OVERALL", total] as const].map(([f, s]) => {
      const { precision, recall, f1 } = prf(s);
      return `${f.padEnd(12)} P ${pct(precision)}  R ${pct(recall)}  F1 ${pct(f1)}   (tp ${s.tp}, fp ${s.fp}, fn ${s.fn})`;
    });
    console.log(["", ...lines, "", ...misses.map((m) => `  - ${m}`)].join("\n"));
  });

  it("is precise: wrong values are worse than missing ones in a medical record", () => {
    expect(prf(total).precision).toBeGreaterThanOrEqual(0.95);
  });

  it("has useful recall", () => {
    expect(prf(total).recall).toBeGreaterThanOrEqual(0.85);
  });
});
