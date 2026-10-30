/**
 * Client-side mirror of the server's case file schema (backend/app/schemas.py): types,
 * ranges and required fields. Used to validate AI output before it is shown, and to
 * block "Verify" while anything is invalid. The server re-validates on sync.
 */
import type { ConsultationData, Vitals } from "./types";

export const VITAL_RANGES: Record<keyof Vitals, { min: number; max: number; label: string; unit: string; integer: boolean }> = {
  bp_systolic: { min: 50, max: 260, label: "BP systolic", unit: "mmHg", integer: true },
  bp_diastolic: { min: 30, max: 160, label: "BP diastolic", unit: "mmHg", integer: true },
  pulse: { min: 20, max: 250, label: "Pulse", unit: "/min", integer: true },
  temperature_c: { min: 30, max: 45, label: "Temperature", unit: "°C", integer: false },
  spo2: { min: 50, max: 100, label: "SpO₂", unit: "%", integer: true },
  resp_rate: { min: 5, max: 80, label: "Resp. rate", unit: "/min", integer: true },
  weight_kg: { min: 0.5, max: 300, label: "Weight", unit: "kg", integer: false },
  height_cm: { min: 30, max: 250, label: "Height", unit: "cm", integer: false },
  blood_glucose_mg_dl: { min: 20, max: 800, label: "Blood glucose", unit: "mg/dL", integer: false },
};

export type ValidationErrors = Record<string, string>;

const tooLong = (s: string | null | undefined, max: number) => (s?.length ?? 0) > max;

export function checkVital(key: keyof Vitals, value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const r = VITAL_RANGES[key];
  if (!Number.isFinite(value)) return `${r.label} must be a number`;
  if (r.integer && !Number.isInteger(value)) return `${r.label} must be a whole number`;
  if (value < r.min || value > r.max) return `${r.label} must be ${r.min}–${r.max} ${r.unit}`;
  return null;
}

export function validateConsultation(d: ConsultationData): ValidationErrors {
  const errors: ValidationErrors = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.visit_date)) errors.visit_date = "Visit date is required";
  if (tooLong(d.chief_complaint, 1000)) errors.chief_complaint = "Chief complaint is too long (max 1000)";
  for (const key of Object.keys(VITAL_RANGES) as (keyof Vitals)[]) {
    const err = checkVital(key, d.vitals[key]);
    if (err) errors[`vitals.${key}`] = err;
  }
  d.symptoms.forEach((s, i) => {
    if (!s.name.trim()) errors[`symptoms.${i}`] = "Symptom name is required";
  });
  d.medications.forEach((m, i) => {
    if (!m.name.trim()) errors[`medications.${i}`] = "Medicine name is required";
  });
  d.allergies.forEach((a, i) => {
    if (!a.substance.trim()) errors[`allergies.${i}`] = "Allergy substance is required";
  });
  (d.lab_results ?? []).forEach((l, i) => {
    if (!l.name.trim() || !l.value.trim()) errors[`lab_results.${i}`] = "Test name and value are required";
  });
  d.diagnosis.forEach((x, i) => {
    if (!x.trim()) errors[`diagnosis.${i}`] = "Empty diagnosis";
  });
  if (d.follow_up?.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(d.follow_up.due_date)) errors.follow_up = "Invalid follow-up date";
  if (tooLong(d.notes, 10_000)) errors.notes = "Notes are too long";
  return errors;
}
