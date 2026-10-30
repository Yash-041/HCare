/**
 * Field-level three-way merge for sync conflicts.
 *
 *   base   = the server version both edits started from
 *   mine   = this device's current local version
 *   theirs = the server's current version
 *
 * A field changed on only one side merges automatically; a field changed differently on
 * both sides is a clash that a person must decide. List fields can be combined.
 * Clinical safety rule: no merge (automatic or suggested) silently drops an allergy.
 */
import type { ConsultationData, EntityName, FieldMeta, Review } from "./types";

export type Choice = "mine" | "theirs" | "both";

export interface FieldPlan {
  path: string;
  label: string;
  base: unknown;
  mine: unknown;
  theirs: unknown;
  /** same: no difference left · mine/theirs: only that side changed · clash: both changed differently */
  status: "mine" | "theirs" | "clash";
  /** Automatic or recommended choice; null = the user must decide. */
  suggestion: Choice | null;
  /** List field whose items can be combined from both sides. */
  combinable: boolean;
  /** Why a change needs explicit attention even though only one side changed. */
  note?: string;
}

const LABELS: Record<string, string> = {
  name: "Name",
  sex: "Sex",
  date_of_birth: "Date of birth",
  age_years: "Age",
  phone: "Phone",
  village: "Village",
  health_id: "Health ID",
  preferred_language: "Preferred language",
  known_allergies: "Known allergies",
  chronic_conditions: "Chronic conditions",
  patient_id: "Patient",
  visit_date: "Visit date",
  language: "Language",
  chief_complaint: "Chief complaint",
  symptoms: "Symptoms",
  "vitals.bp_systolic": "BP systolic",
  "vitals.bp_diastolic": "BP diastolic",
  "vitals.pulse": "Pulse",
  "vitals.temperature_c": "Temperature (°C)",
  "vitals.spo2": "SpO₂",
  "vitals.resp_rate": "Respiratory rate",
  "vitals.weight_kg": "Weight (kg)",
  "vitals.height_cm": "Height (cm)",
  "vitals.blood_glucose_mg_dl": "Blood glucose",
  diagnosis: "Diagnosis",
  medications: "Medications",
  allergies: "Allergies",
  lab_results: "Lab results",
  "follow_up.due_date": "Follow-up date",
  "follow_up.instructions": "Follow-up instructions",
  notes: "Clinical notes",
  raw_transcript: "Voice transcript",
  raw_ocr_text: "Document text",
  // documents
  consultation_id: "Visit",
  kind: "Document type",
  ocr_text: "Document text",
};

/** Identity of a list item, so lists can be combined without duplicates. */
const ITEM_KEYS: Record<string, (item: unknown) => string> = {
  known_allergies: (a) => String((a as { substance: string }).substance).toLowerCase(),
  allergies: (a) => String((a as { substance: string }).substance).toLowerCase(),
  symptoms: (s) => String((s as { name: string }).name).toLowerCase(),
  medications: (m) => String((m as { name: string }).name).toLowerCase(),
  lab_results: (l) => String((l as { name: string }).name).toLowerCase(),
  diagnosis: (d) => String(d).toLowerCase(),
  chronic_conditions: (c) => String(c).toLowerCase(),
  sources: (s) => String((s as { id: string }).id),
};

const ALLERGY_FIELDS = new Set(["known_allergies", "allergies"]);
/** Nested objects merged per sub-field (BP from one device, weight from another). */
const NESTED = new Set(["vitals", "follow_up"]);
/** Bookkeeping, not clinical content: derived after the merge. */
const DERIVED = new Set(["field_meta", "review", "sources"]);

const norm = (v: unknown) => (v === undefined || v === "" ? null : v);
export const same = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function set(obj: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== "object") o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[keys[keys.length - 1]] = value;
}

function paths(...objs: unknown[]): string[] {
  const out = new Set<string>();
  for (const o of objs) {
    if (!o || typeof o !== "object") continue;
    for (const [k, v] of Object.entries(o)) {
      if (DERIVED.has(k)) continue;
      if (NESTED.has(k)) {
        for (const sub of Object.keys((v as object) ?? {})) out.add(`${k}.${sub}`);
      } else out.add(k);
    }
  }
  return [...out];
}

export function combine(path: string, a: unknown, b: unknown): unknown[] {
  const key = ITEM_KEYS[path] ?? ((x: unknown) => JSON.stringify(x));
  const out = [...((a as unknown[]) ?? [])];
  const seen = new Set(out.map(key));
  for (const item of (b as unknown[]) ?? []) if (!seen.has(key(item))) out.push(item);
  return out;
}

const keysOf = (path: string, list: unknown) => new Set(((list as unknown[]) ?? []).map(ITEM_KEYS[path] ?? ((x) => JSON.stringify(x))));

export function planMerge(base: unknown, mine: unknown, theirs: unknown): FieldPlan[] {
  const plans: FieldPlan[] = [];
  for (const path of paths(base, mine, theirs)) {
    const [b, m, t] = [get(base, path), get(mine, path), get(theirs, path)];
    if (same(m, t)) continue;
    const mineChanged = !same(b, m);
    const theirsChanged = !same(b, t);
    const combinable = Array.isArray(m ?? t) || path in ITEM_KEYS;
    let status: FieldPlan["status"] = mineChanged && theirsChanged ? "clash" : mineChanged ? "mine" : "theirs";
    let suggestion: Choice | null = status === "clash" ? null : status;
    let note: string | undefined;

    if (ALLERGY_FIELDS.has(path)) {
      // Never lose an allergy silently: if the result would drop one that either side has,
      // stop and suggest combining.
      const union = keysOf(path, combine(path, m, t));
      const chosen = suggestion ? keysOf(path, suggestion === "mine" ? m : t) : new Set<string>();
      if (suggestion === null || chosen.size < union.size) {
        status = "clash";
        suggestion = "both";
        note = "Allergies are combined by default so none is lost. Choose one side only if an allergy was recorded in error.";
      }
    }
    plans.push({ path, label: LABELS[path] ?? path, base: b, mine: m, theirs: t, status, suggestion, combinable, note });
  }
  // Clashes first, then auto-merged fields.
  return plans.sort((a, b) => Number(b.status === "clash") - Number(a.status === "clash"));
}

export type Decisions = Record<string, Choice>;

export function initialDecisions(plan: FieldPlan[]): Decisions {
  return Object.fromEntries(plan.filter((p) => p.suggestion).map((p) => [p.path, p.suggestion!]));
}

export function unresolved(plan: FieldPlan[], decisions: Decisions): FieldPlan[] {
  return plan.filter((p) => !decisions[p.path]);
}

/**
 * Build the merged record. Starts from the server version (so unchanged fields and
 * anything new on the server are kept), then applies each decision.
 */
export function applyMerge<T extends object>(entity: EntityName, mine: T, theirs: T, plan: FieldPlan[], decisions: Decisions): T {
  const merged = structuredClone(theirs) as Record<string, unknown>;
  for (const p of plan) {
    const choice = decisions[p.path];
    if (!choice) throw new Error(`No decision for ${p.label}`);
    if (choice === "mine") set(merged, p.path, structuredClone(p.mine));
    else if (choice === "both") set(merged, p.path, combine(p.path, p.mine, p.theirs));
  }
  if (entity !== "consultation") return merged as T;

  const m = mine as unknown as ConsultationData;
  const t = theirs as unknown as ConsultationData;
  const out = merged as unknown as ConsultationData;
  // Provenance: keep every source either side referenced.
  out.sources = combine("sources", t.sources, m.sources) as ConsultationData["sources"];
  // Field provenance follows the decision for each field.
  const meta: Record<string, FieldMeta> = { ...t.field_meta };
  for (const p of plan) {
    const top = p.path.startsWith("vitals.") ? p.path : p.path.split(".")[0];
    const choice = decisions[p.path];
    if (choice === "mine" && m.field_meta[top]) meta[top] = m.field_meta[top];
    if (choice === "both") meta[top] = { source: "manual", verified: false };
  }
  out.field_meta = meta;
  // A verification only stands for the exact content that was verified.
  out.review = reviewFor(out, m, t);
  return merged as T;
}

/** The clinical content only (no review state / provenance bookkeeping). */
function clinical(d: ConsultationData): Partial<ConsultationData> {
  const copy: Partial<ConsultationData> = { ...d };
  delete copy.field_meta;
  delete copy.review;
  delete copy.sources;
  return copy;
}

function reviewFor(merged: ConsultationData, mine: ConsultationData, theirs: ConsultationData): Review {
  if (same(clinical(merged), clinical(theirs))) return theirs.review;
  if (same(clinical(merged), clinical(mine))) return mine.review;
  return { status: "draft" };
}

/** Per-field decisions for the audit log, e.g. {"village": "mine", "allergies": "both"}. */
export function decisionSummary(plan: FieldPlan[], decisions: Decisions): Record<string, Choice> {
  return Object.fromEntries(plan.map((p) => [p.path, decisions[p.path]]));
}
