/**
 * Structuring pipeline: sources -> segments -> rules (+ optional on-device LLM) -> merge
 * -> validated draft case file with per-field provenance (source, confidence, source_ref).
 * The result is always a DRAFT; nothing here marks a case file as verified.
 */
import type { ConsultationData, DocumentData, FieldMeta, LocalRecord, Vitals } from "../../lib/types";
import { validateConsultation } from "../../lib/validation";
import { canonicalMedicine, canonicalSymptom, emptyExtraction, extractWithRules, type Extracted, type Extraction, type Segment } from "./rules";
import { extractWithLlm, type Generate } from "./llm";

export function segmentsFor(c: ConsultationData, documents: LocalRecord<DocumentData>[]): Segment[] {
  const docs = new Map(documents.map((d) => [d.id, d.data]));
  const segments: Segment[] = c.sources
    .filter((s) => s.excerpt?.trim())
    .map((s) => {
      const doc = s.document_id ? docs.get(s.document_id) : undefined;
      return {
        id: s.id,
        kind: s.kind,
        // Prefer the document's full corrected OCR text over the (truncated) excerpt.
        text: doc?.ocr_text ?? s.excerpt ?? "",
        reliability: s.kind === "image" ? (doc?.ocr_confidence ?? 0.8) : 1,
      };
    });
  if (segments.length === 0) {
    if (c.raw_transcript) segments.push({ id: "raw_transcript", kind: "audio", text: c.raw_transcript });
    if (c.raw_ocr_text) segments.push({ id: "raw_ocr_text", kind: "image", text: c.raw_ocr_text, reliability: 0.8 });
  }
  return segments;
}

function mergeLists<T>(primary: Extracted<T>[], extra: Extracted<T>[], key: (v: T) => string): Extracted<T>[] {
  const seen = new Set(primary.map((x) => key(x.value).toLowerCase()));
  return [...primary, ...extra.filter((x) => !seen.has(key(x.value).toLowerCase()))];
}

/** Rules are precise for numbers/doses; the LLM adds grounded items the rules missed. */
export function mergeExtractions(rules: Extraction, llm: Extraction | null): Extraction {
  if (!llm) return rules;
  const vitals = { ...rules.vitals };
  for (const [k, v] of Object.entries(llm.vitals) as [keyof Vitals, Extracted<number>][]) vitals[k] ??= v;
  // Fill gaps in rule-found items (e.g. a duration the LLM understood from phrasing).
  const symptoms = rules.symptoms.map((s) => {
    const l = llm.symptoms.find((x) => x.value.name === s.value.name);
    return l && !s.value.duration && l.value.duration ? { ...s, value: { ...s.value, duration: l.value.duration } } : s;
  });
  const warnings = [...rules.warnings, ...llm.warnings];
  const allergies = mergeLists(rules.allergies, llm.allergies, (a) => a.substance);

  // Safety: something the patient is allergic to is never added as a medicine. (A small
  // model read "allergic to penicillin" as a penicillin prescription in testing; the word
  // is in the notes, so grounding alone would not catch it.)
  const allergens = new Set(allergies.flatMap((a) => [a.value.substance.toLowerCase(), (canonicalMedicine(a.value.substance) ?? "").toLowerCase()]));
  const isAllergen = (name: string) => allergens.has(name.toLowerCase()) || allergens.has((canonicalMedicine(name) ?? "").toLowerCase());
  const llmMeds = llm.medications.filter((m) => {
    if (!isAllergen(m.value.name)) return true;
    warnings.push(`On-device AI listed "${m.value.name}" as a medicine, but the patient is allergic to it. Not added.`);
    return false;
  });

  // A model-written complaint reads better than the rule-built list, but only if it is
  // grounded and actually about a symptom (not e.g. "BP 120/80").
  const cc = llm.chief_complaint;
  const ccAboutSymptoms = cc && (extractWithRules([{ id: "cc", kind: "text", text: cc.value }]).symptoms.length > 0 || rules.symptoms.length === 0);

  return {
    vitals,
    symptoms: mergeLists(symptoms, llm.symptoms, (s) => canonicalSymptom(s.name) ?? s.name),
    medications: mergeLists(rules.medications, llmMeds, (m) => canonicalMedicine(m.name) ?? m.name),
    allergies,
    diagnosis: mergeLists(rules.diagnosis, llm.diagnosis, (d) => d.replace(/\s*\(suspected\)$/, "")),
    lab_results: rules.lab_results,
    follow_up: rules.follow_up ?? llm.follow_up,
    chief_complaint: cc && cc.confidence >= 0.5 && ccAboutSymptoms ? cc : (rules.chief_complaint ?? (ccAboutSymptoms ? cc : null)),
    warnings,
  };
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface StructureResult {
  data: ConsultationData;
  /** Field paths filled by this run. */
  filled: string[];
  warnings: string[];
}

/**
 * Apply an extraction onto the current draft. Fields the clinician already edited
 * (field_meta source "manual") are never overwritten.
 */
export function applyExtraction(current: ConsultationData, ext: Extraction): StructureResult {
  const data: ConsultationData = structuredClone(current);
  const meta: Record<string, FieldMeta> = { ...current.field_meta };
  const filled: string[] = [];
  const locked = (path: string) => meta[path]?.source === "manual";

  function set<T>(path: string, items: Extracted<T>[], write: () => void) {
    if (!items.length || locked(path)) return;
    write();
    const weakest = items.reduce((a, b) => (b.confidence < a.confidence ? b : a));
    meta[path] = {
      source: weakest.source === "rule" ? "rule" : "llm",
      confidence: Math.round(weakest.confidence * 100) / 100,
      source_ref: items[0].source_ref,
      verified: false,
    };
    filled.push(path);
  }

  const cc = ext.chief_complaint;
  if (cc) set("chief_complaint", [cc], () => (data.chief_complaint = cc.value));
  set("symptoms", ext.symptoms, () => (data.symptoms = ext.symptoms.map((s) => s.value)));
  for (const [key, v] of Object.entries(ext.vitals) as [keyof Vitals, Extracted<number>][]) {
    set(`vitals.${key}`, [v], () => (data.vitals = { ...data.vitals, [key]: v.value }));
  }
  set("diagnosis", ext.diagnosis, () => (data.diagnosis = ext.diagnosis.map((d) => d.value)));
  set("medications", ext.medications, () => (data.medications = ext.medications.map((m) => m.value)));
  set("allergies", ext.allergies, () => (data.allergies = ext.allergies.map((a) => a.value)));
  set("lab_results", ext.lab_results, () => (data.lab_results = ext.lab_results.map((l) => l.value)));
  const fu = ext.follow_up;
  if (fu) {
    set("follow_up", [fu], () => (data.follow_up = { due_date: addDays(data.visit_date, fu.value.in_days), instructions: fu.value.instructions || null }));
  }

  data.field_meta = meta;
  // Structuring never changes review state: the clinician must verify.
  data.review = current.review.status === "verified" ? { status: "draft" } : current.review;

  // Validate before showing: anything invalid is removed and reported, never stored.
  const warnings = [...ext.warnings];
  const errors = validateConsultation(data);
  for (const [path, message] of Object.entries(errors)) {
    if (path.startsWith("vitals.")) {
      const key = path.slice(7) as keyof Vitals;
      data.vitals = { ...data.vitals, [key]: null };
      delete data.field_meta[path];
      warnings.push(`Removed invalid value: ${message}.`);
    }
  }
  return { data, filled, warnings };
}

export interface StructureOptions {
  /** On-device LLM; omit to use rules only. */
  generate?: Generate;
}

export async function structureConsultation(
  current: ConsultationData,
  documents: LocalRecord<DocumentData>[],
  opts: StructureOptions = {},
): Promise<StructureResult & { usedLlm: boolean }> {
  const segments = segmentsFor(current, documents);
  if (segments.length === 0) {
    return { data: current, filled: [], warnings: ["No transcript or document text to structure."], usedLlm: false };
  }
  const rules = extractWithRules(segments);
  let llm: Extraction | null = null;
  if (opts.generate) {
    try {
      llm = await extractWithLlm(segments, opts.generate);
    } catch (e) {
      llm = emptyExtraction();
      llm.warnings.push(`On-device AI failed (${e instanceof Error ? e.message : e}); showing rule-based results.`);
    }
  }
  return { ...applyExtraction(current, mergeExtractions(rules, llm)), usedLlm: !!opts.generate };
}
