import { describe, expect, it } from "vitest";
import { buildMessages, extractWithLlm, JSON_PREFILL, parseJsonObject } from "../src/ai/extract/llm";
import { structureConsultation } from "../src/ai/extract/structure";
import type { ConsultationData, DocumentData, LocalRecord } from "../src/lib/types";

function consultation(overrides: Partial<ConsultationData> = {}): ConsultationData {
  return {
    patient_id: "p1",
    visit_date: "2026-10-30",
    language: "hi",
    chief_complaint: null,
    symptoms: [],
    vitals: {},
    diagnosis: [],
    medications: [],
    allergies: [],
    lab_results: [],
    follow_up: null,
    notes: null,
    raw_transcript: null,
    raw_ocr_text: null,
    sources: [
      {
        id: "audio-1",
        kind: "audio",
        language: "hi",
        excerpt:
          "teen din se tez bukhar hai aur khansi. BP 130/80, pulse 96. Penicillin se allergy hai. Tab paracetamol 500 mg TDS for 3 days. 5 din baad dobara dikhana.\n[English translation] High fever for three days and cough.",
      },
      { id: "doc-1", kind: "image", document_id: "doc-1", excerpt: "Hb 9.8 g/dL" },
    ],
    field_meta: {},
    review: { status: "draft" },
    ...overrides,
  };
}

const documents: LocalRecord<DocumentData>[] = [
  {
    id: "doc-1",
    entity: "document",
    version: 0,
    deleted: false,
    updated_at: "",
    updated_by: "",
    device_id: "",
    sync_status: "pending",
    base_data: null,
    data: {
      patient_id: "p1",
      kind: "lab_report",
      ocr_text: "CITY LAB\nHaemoglobin 9.8 g/dL\nFasting Glucose 142 mg/dL",
      ocr_confidence: 0.9,
      low_confidence_spans: [],
    },
  },
];

describe("structuring (rules only)", () => {
  it("fills a draft case file with provenance for every field", async () => {
    const r = await structureConsultation(consultation(), documents);
    const d = r.data;
    expect(d.symptoms.map((s) => [s.name, s.duration, s.severity])).toEqual([
      ["fever", "3 days", "severe"],
      ["cough", null, null],
    ]);
    expect(d.vitals).toMatchObject({ bp_systolic: 130, bp_diastolic: 80, pulse: 96, blood_glucose_mg_dl: 142 });
    expect(d.allergies.map((a) => a.substance)).toEqual(["Penicillin"]);
    expect(d.medications[0]).toMatchObject({ name: "Paracetamol", dose: "500 mg", frequency: "three times daily", duration: "3 days" });
    expect(d.lab_results).toEqual([{ name: "Haemoglobin", value: "9.8", unit: "g/dL" }]);
    expect(d.follow_up).toEqual({ due_date: "2026-11-04", instructions: expect.stringContaining("5 din baad") });
    expect(d.chief_complaint).toBe("Fever for 3 days, cough");

    expect(d.field_meta["vitals.pulse"]).toEqual({ source: "rule", confidence: 0.9, source_ref: "audio-1", verified: false });
    expect(d.field_meta["vitals.blood_glucose_mg_dl"].source_ref).toBe("doc-1");
    expect(d.field_meta["lab_results"].confidence).toBeLessThan(0.85); // scaled by OCR reliability
    expect(d.review.status).toBe("draft");
  });

  it("never overwrites fields the clinician edited", async () => {
    const edited = consultation({
      chief_complaint: "Fever and cough, worse at night",
      field_meta: { chief_complaint: { source: "manual", verified: true } },
    });
    const r = await structureConsultation(edited, documents);
    expect(r.data.chief_complaint).toBe("Fever and cough, worse at night");
    expect(r.filled).not.toContain("chief_complaint");
  });

  it("re-running on a verified file sends it back to draft", async () => {
    const verified = consultation({ review: { status: "verified", reviewed_by: "u", reviewed_at: "2026-10-30T10:00:00Z" } });
    expect((await structureConsultation(verified, documents)).data.review).toEqual({ status: "draft" });
  });
});

describe("on-device LLM guard rails", () => {
  const llmJson = (obj: unknown) => async () => "Sure! Here is the JSON:\n```json\n" + JSON.stringify(obj) + "\n```";

  it("adds grounded items, drops hallucinated ones and says so", async () => {
    const r = await structureConsultation(consultation(), documents, {
      generate: llmJson({
        chief_complaint: "High fever for three days with cough",
        symptoms: [{ name: "fever", duration: "3 days" }, { name: "chest pain" }],
        diagnosis: ["Typhoid fever"], // not in the notes
        medications: [{ name: "Paracetamol" }, { name: "Ceftriaxone", dose: "1 g" }], // ceftriaxone invented
        allergies: ["Penicillin"],
        vitals: { pulse: 96, spo2: 97 }, // spo2 invented
      }),
    });
    expect(r.data.chief_complaint).toBe("High fever for three days with cough");
    expect(r.data.field_meta.chief_complaint.source).toBe("llm");
    expect(r.data.symptoms.map((s) => s.name)).toEqual(["fever", "cough"]);
    expect(r.data.diagnosis).toEqual([]);
    expect(r.data.medications.map((m) => m.name)).toEqual(["Paracetamol"]);
    expect(r.data.vitals.spo2).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/NOT added: .*chest pain.*Typhoid fever.*Ceftriaxone/);
  });

  it("accepts cross-language grounding (English value, Hindi notes)", async () => {
    const r = await structureConsultation(
      consultation({ sources: [{ id: "a", kind: "audio", excerpt: "मरीज़ को उल्टी और दस्त है" }] }),
      [],
      { generate: llmJson({ symptoms: [{ name: "vomiting" }, { name: "diarrhea" }] }) },
    );
    expect(r.data.symptoms.map((s) => s.name)).toEqual(["vomiting", "diarrhoea"]);
  });

  it("falls back to rules when the model output is unusable or the model fails", async () => {
    const garbage = await structureConsultation(consultation(), documents, { generate: async () => "I cannot help with that." });
    expect(garbage.data.vitals.pulse).toBe(96);
    expect(garbage.warnings.join()).toMatch(/could not be read/);

    const crash = await structureConsultation(consultation(), documents, {
      generate: async () => Promise.reject(new Error("out of memory")),
    });
    expect(crash.data.vitals.pulse).toBe(96);
    expect(crash.warnings.join()).toMatch(/out of memory/);
  });

  it("parses truncated or sloppy JSON from a small model", () => {
    expect(parseJsonObject('{"symptoms": [{"name": "fever"},], "allergies": ["dust"]')).toEqual({
      symptoms: [{ name: "fever" }],
      allergies: ["dust"],
    });
  });

  it("prompt contains the notes, the strict-extraction instruction and no copyable example values", () => {
    const [system, user] = buildMessages([{ id: "a", kind: "audio", text: "bukhar hai" }]);
    expect(system.content).toMatch(/ONLY information written in the notes/);
    expect(user.content).toContain("bukhar hai");
    expect(user.content).not.toMatch(/paracetamol|penicillin|\d{2,}/i);
  });

  it("out-of-range model values are rejected by schema validation", async () => {
    const ext = await extractWithLlm(
      [{ id: "a", kind: "audio", text: "temperature 98.6" }],
      llmJson({ vitals: { temperature_c: 98.6 } }),
    );
    expect(ext.vitals.temperature_c).toBeUndefined();
    expect(ext.warnings.join()).toMatch(/temperature c 98.6 \(out of range\)/);
  });
});

/**
 * Regression tests built from REAL outputs of Qwen2.5 0.5B / 1.5B captured while choosing
 * the model (prompt -> raw output). Each one is a failure mode the guard rails must stop.
 */
describe("guard rails against observed small-model failures", () => {
  const notes = (text: string) =>
    consultation({ sources: [{ id: "a", kind: "audio", excerpt: text }] });
  const replay = (raw: string) => async (_m: unknown, prefill: string) => prefill + raw;

  it("0.5B listed the patient's penicillin ALLERGY as a medication", async () => {
    const r = await structureConsultation(
      notes("The patient has had a fever for three days and a dry cough. She is allergic to penicillin."),
      [],
      { generate: replay(' "chief_complaint": "BP 120/80", "diagnosis": null, "medications": ["penicillin"], "allergies": [] }') },
    );
    expect(r.data.allergies.map((a) => a.substance)).toEqual(["Penicillin"]);
    expect(r.data.medications).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/allergic to it\. Not added/);
  });

  it("0.5B (4-bit) invented vitals and a hypertension diagnosis", async () => {
    const r = await structureConsultation(
      notes("The patient has had a fever for three days and a dry cough. She is allergic to penicillin."),
      [],
      {
        generate: replay(
          ' "chief_complaint": "has had a fever for three days and a dry cough.", "symptoms": [{"name": "fever", "duration": null}], "vitals": {"bp_systolic": 95, "bp_diastolic": 70, "pulse": 130, "temperature_c": 38.5, "spo2": null}, "diagnosis": ["Allergic Reaction", "Hypertension"], "medications": [{"name": "penicillin"}], "allergies": ["Penicillin"]}',
        ),
      },
    );
    expect(r.data.vitals).toEqual({});
    expect(r.data.diagnosis).toEqual([]);
    expect(r.data.medications).toEqual([]);
    expect(r.data.chief_complaint).toBe("has had a fever for three days and a dry cough.");
    expect(r.warnings.join(" ")).toMatch(/bp systolic 95.*pulse 130.*Allergic Reaction.*Hypertension/);
  });

  it("a non-symptom chief complaint ('BP 120/80') does not replace the rule-built one", async () => {
    const r = await structureConsultation(notes("teen din se bukhar hai. BP 120/80, pulse 92."), [], {
      generate: replay(' "chief_complaint": "BP 120/80" }'),
    });
    expect(r.data.chief_complaint).toBe("Fever for 3 days");
  });

  it("1.5B on Hinglish: invented 'cold' and used frequencies as durations", async () => {
    const r = await structureConsultation(
      notes("Mareez ko teen din se bukhar hai aur badan dard bhi hai. BP 120/80, pulse 92. Dolo 650 din mein do baar. Penicillin se allergy hai."),
      [],
      {
        generate: replay(
          '\n  "chief_complaint": "fever and cold",\n  "symptoms": [{"name": "cold", "duration": "daily"}, {"name": "fever", "duration": "twice daily"}],\n  "vitals": {"bp_systolic": 120, "bp_diastolic": 80, "pulse": 92, "temperature_c": null, "spo2": null},\n  "diagnosis": [], "medications": [], "allergies": ["penicillin"]\n}',
        ),
      },
    );
    expect(r.data.symptoms.map((s) => [s.name, s.duration])).toEqual([
      ["fever", "3 days"],
      ["body ache", null],
    ]);
    expect(r.data.medications.map((m) => m.name)).toEqual(["Paracetamol"]); // the rules still catch "Dolo"
    expect(r.warnings.join(" ")).toMatch(/symptom "cold"/);
  });

  it("the worker prefill is part of the parsed JSON", () => {
    expect(parseJsonObject(JSON_PREFILL + ' "allergies": ["dust"] }')).toEqual({ allergies: ["dust"] });
  });
});
