import { describe, expect, it } from "vitest";
import { extractWithRules, normalize, parseDuration, type Segment } from "../src/ai/extract/rules";

const seg = (text: string, id = "s1", reliability?: number): Segment => ({ id, kind: "audio", text, reliability });
const run = (text: string) => extractWithRules([seg(text)]);
const names = <T extends { value: { name: string } }>(xs: T[]) => xs.map((x) => x.value.name);

describe("vitals", () => {
  it("reads English vitals with units", () => {
    const r = run("BP 130/80 mmHg, pulse 88/min, temp 38.5 C, SpO2 96%, RR 20, weight 52 kg, height 158 cm, RBS 142 mg/dl.");
    const v = Object.fromEntries(Object.entries(r.vitals).map(([k, x]) => [k, x!.value]));
    expect(v).toEqual({
      bp_systolic: 130,
      bp_diastolic: 80,
      pulse: 88,
      temperature_c: 38.5,
      spo2: 96,
      resp_rate: 20,
      weight_kg: 52,
      height_cm: 158,
      blood_glucose_mg_dl: 142,
    });
    expect(r.vitals.pulse?.evidence).toContain("pulse 88");
  });

  it("understands speech phrasing: 'blood pressure is 140 over 90'", () => {
    const r = run("Her blood pressure is 140 over 90 and heart rate 102.");
    expect(r.vitals.bp_systolic?.value).toBe(140);
    expect(r.vitals.bp_diastolic?.value).toBe(90);
    expect(r.vitals.pulse?.value).toBe(102);
  });

  it("converts Fahrenheit fever readings to Celsius", () => {
    const r = run("fever of 101 F since last night");
    expect(r.vitals.temperature_c?.value).toBe(38.3);
    expect(r.vitals.temperature_c?.evidence).toContain("converted from 101 °F");
  });

  it("reads Hindi / Devanagari digits", () => {
    const r = run("बीपी १३०/८५ है, नब्ज ९२");
    expect(r.vitals.bp_systolic?.value).toBe(130);
    expect(r.vitals.bp_diastolic?.value).toBe(85);
    expect(r.vitals.pulse?.value).toBe(92);
  });

  it("does not mistake durations, dates or doses for vitals", () => {
    const r = run("Fever for 3 days. Visit on 12/10. Paracetamol 500/325.");
    expect(r.vitals).toEqual({});
  });

  it("drops implausible values with a warning instead of storing them", () => {
    const r = run("pulse 400");
    expect(r.vitals.pulse).toBeUndefined();
    expect(r.warnings.join()).toMatch(/pulse 400/);
  });
});

describe("symptoms", () => {
  it("English with duration and severity", () => {
    const r = run("Patient has high fever for 3 days and a dry cough since yesterday.");
    expect(r.symptoms.map((s) => s.value)).toEqual([
      { name: "fever", duration: "3 days", severity: "severe" },
      { name: "cough", duration: "1 day", severity: null },
    ]);
  });

  it("Hinglish: duration before the symptom", () => {
    const r = run("teen din se bukhar hai, sir dard bhi hai aur do hafte se khansi");
    expect(r.symptoms.map((s) => [s.value.name, s.value.duration])).toEqual([
      ["fever", "3 days"],
      ["headache", null],
      ["cough", "2 weeks"],
    ]);
  });

  it("Devanagari with spelling variants (nukta / chandrabindu)", () => {
    const r = run("मरीज़ को ३ दिन से बुखार और खाँसी है, कमज़ोरी भी है");
    expect(names(r.symptoms)).toEqual(["fever", "cough", "weakness"]);
    expect(r.symptoms[0].value.duration).toBe("3 days");
  });

  it("respects negation in English and Hindi, scoped to the clause", () => {
    expect(names(run("No fever, but cough for 2 days.").symptoms)).toEqual(["cough"]);
    expect(names(run("Denies chest pain. Has vomiting.").symptoms)).toEqual(["vomiting"]);
    expect(names(run("bukhar nahi hai, dast hai").symptoms)).toEqual(["diarrhoea"]);
    expect(names(run("सिर दर्द नहीं है").symptoms)).toEqual([]);
  });

  it("builds a chief complaint from the leading symptoms", () => {
    expect(run("fever for 3 days and cough").chief_complaint?.value).toBe("Fever for 3 days, cough");
  });
});

describe("medications and allergies", () => {
  it("dose, frequency, course and route per medicine", () => {
    const r = run("Tab Paracetamol 500 mg TDS for 3 days. Syrup amoxicillin 250 mg twice daily x 5 days. ORS after every loose stool.");
    expect(r.medications.map((m) => m.value)).toEqual([
      { name: "Paracetamol", dose: "500 mg", frequency: "three times daily", duration: "3 days", route: "oral" },
      { name: "Amoxicillin", dose: "250 mg", frequency: "twice daily", duration: "5 days", route: "oral" },
      { name: "ORS", dose: null, frequency: null, duration: null, route: null },
    ]);
  });

  it("brand names map to generics; '1-0-1' schedules are kept", () => {
    const r = run("Dolo 650 mg 1-0-1, Azithral 500 mg OD");
    expect(r.medications.map((m) => [m.value.name, m.value.dose, m.value.frequency])).toEqual([
      ["Paracetamol", "650 mg", "1-0-1"],
      ["Azithromycin", "500 mg", "once daily"],
    ]);
  });

  it("misheard drug names from speech recognition (real Whisper outputs) are found, at low confidence", () => {
    for (const heard of ["give paracetamal 500mg 3 times a day for 3 days.", "Give para-setimal 500 mg 3 times a day for 3 days."]) {
      const [m] = run(heard).medications;
      expect(m.value).toMatchObject({ name: "Paracetamol", dose: "500 mg", frequency: "three times daily", duration: "3 days" });
      expect(m.confidence).toBeLessThan(0.6); // below the bar: the clinician must confirm it
      expect(m.evidence).toMatch(/heard as "para-?(cetamal|setimal)"/);
    }
    expect(run("allergic to penicilin").allergies[0].value.substance).toBe("Penicillin");
    // Correct spellings keep normal confidence; ordinary words are not "corrected" into drugs.
    expect(run("paracetamol 500 mg TDS").medications[0].confidence).toBeGreaterThan(0.6);
    expect(run("patient complains of weakness and headache since morning").medications).toEqual([]);
  });

  it("'twice a day' is a frequency, not a one-day course", () => {
    const [m] = run("cetirizine 10 mg twice a day").medications;
    expect(m.value).toMatchObject({ frequency: "twice daily", duration: null });
  });

  it("an allergy mention is not read as a prescription", () => {
    const r = run("She is allergic to penicillin and sulfa. Started amoxicillin? No - azithromycin 500 mg OD.");
    expect(r.allergies.map((a) => a.value.substance)).toEqual(["Penicillin", "Sulfa drugs"]);
    expect(names(r.medications)).not.toContain("Penicillin");
  });

  it("Hindi allergy phrasing and 'no known allergies'", () => {
    expect(run("penicillin se allergy hai").allergies.map((a) => a.value.substance)).toEqual(["Penicillin"]);
    expect(run("धूल से एलर्जी").allergies.map((a) => a.value.substance)).toEqual(["Dust"]);
    const none = run("No known drug allergies.");
    expect(none.allergies).toEqual([]);
    expect(none.warnings).toContain("Notes say: no known allergies.");
  });

  it("'drug allergy' does not invent a substance called 'Drug'", () => {
    expect(run("history of drug allergy, details not known").allergies).toEqual([]);
  });
});

describe("labs, diagnosis, follow-up", () => {
  it("reads values and units from a scanned lab report", () => {
    const r = extractWithRules([
      seg("CITY LAB\nHaemoglobin (Hb) : 9.8 g/dL\nS. Creatinine 1.4 mg/dl\nPlatelet count 1.8 lakh/cumm\nMalaria antigen: Negative", "doc1", 0.8),
    ]);
    expect(r.lab_results.map((l) => [l.value.name, l.value.value, l.value.unit])).toEqual([
      ["Haemoglobin", "9.8", "g/dL"],
      ["Serum creatinine", "1.4", "mg/dL"],
      ["Platelets", "1.8", "lakh/cumm"],
      ["Malaria antigen", "negative", null],
    ]);
    // OCR reliability lowers confidence.
    expect(r.lab_results[0].confidence).toBeCloseTo(0.85 * 0.8);
    expect(r.lab_results[0].source_ref).toBe("doc1");
  });

  it("only takes diagnoses that are explicitly stated", () => {
    expect(run("Fever, chills, Hb 9.8").diagnosis).toEqual([]);
    expect(run("Diagnosis: acute gastroenteritis with mild dehydration.").diagnosis.map((d) => d.value)).toEqual([
      "Acute gastroenteritis",
      "Mild dehydration",
    ]);
    expect(run("suspected malaria, test advised").diagnosis.map((d) => d.value)).toEqual(["Malaria (suspected)"]);
  });

  it("follow-up in English and Hindi", () => {
    expect(run("Review after 1 week if not better.").follow_up?.value.in_days).toBe(7);
    expect(run("paanch din baad dobara dikhana").follow_up?.value.in_days).toBe(5);
  });
});

describe("helpers", () => {
  it("normalize folds Devanagari variants and digits", () => {
    expect(normalize("खाँसी ज़ुकाम ३")).toBe("खांसी जुकाम 3");
  });
  it("parseDuration", () => {
    expect(parseDuration("for two weeks")).toBe("2 weeks");
    expect(parseDuration("kal se")).toBe("1 day");
    expect(parseDuration("nothing here")).toBeNull();
  });
});
