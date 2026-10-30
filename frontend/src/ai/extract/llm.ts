/**
 * LLM-based extraction with guard rails for a small on-device model:
 *  1. strict JSON-only prompt, "explicitly stated facts only";
 *  2. tolerant JSON parsing + type/range sanitizing (schema validation);
 *  3. grounding: every item must be traceable to the source text, otherwise it is
 *     dropped and reported. A hallucinated medicine or diagnosis never reaches the form.
 */
import type { Vitals } from "../../lib/types";
import { checkVital, VITAL_RANGES } from "../../lib/validation";
import {
  canonicalAllergen,
  canonicalMedicine,
  canonicalSymptom,
  emptyExtraction,
  mentionsTerm,
  normalize,
  parseDuration,
  type Extraction,
  type Segment,
} from "./rules";

export type Generate = (messages: { role: "system" | "user"; content: string }[], prefill: string) => Promise<string>;

const MAX_INPUT_CHARS = 3500;

const SYSTEM_PROMPT = `You extract facts from clinical notes into JSON.
Use ONLY information written in the notes. Never invent values. Leave out anything not mentioned.
Never add a diagnosis that is not written in the notes. Write values in English. Output only JSON.`;

// Type placeholders only. Concrete example values ("Paracetamol 500 mg") were copied into
// the output by small models in testing, so the schema must not contain any.
const SCHEMA = `{"chief_complaint": string, "symptoms": [{"name": string, "duration": string|null}], "vitals": {"bp_systolic": number, "bp_diastolic": number, "pulse": number, "temperature_c": number, "spo2": number}, "diagnosis": [string], "medications": [{"name": string, "dose": string|null, "frequency": string|null}], "allergies": [string]}`;

/** The reply is prefilled with this so the model continues a JSON object. */
export const JSON_PREFILL = "{";

export function buildMessages(segments: Segment[]) {
  let notes = segments.map((s, i) => `[Source ${i + 1}: ${s.kind === "audio" ? "voice note" : "document"}]\n${s.text.trim()}`).join("\n\n");
  if (notes.length > MAX_INPUT_CHARS) notes = notes.slice(0, MAX_INPUT_CHARS) + "\n[...truncated]";
  return [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: `Notes:\n${notes}\n\nJSON schema:\n${SCHEMA}` },
  ];
}

/** Pull the first JSON object out of model output, forgiving common small-model mistakes. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.replace(/```(?:json)?/gi, "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && text[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  // Truncated output (token limit): close what was opened.
  let candidate = end > 0 ? text.slice(start, end + 1) : text.slice(start) + "}".repeat(Math.max(1, depth));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const v = JSON.parse(candidate);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      candidate = candidate.replace(/,\s*([}\]])/g, "$1").replace(/'/g, '"');
    }
  }
  return null;
}

const str = (v: unknown, max = 200): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  return s && !/^(n\/?a|none|null|unknown|not mentioned|-)$/i.test(s) ? s.slice(0, max) : null;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Find the segment that supports a value; numbers must appear verbatim, words mostly. */
function ground(value: string, segments: Segment[], minScore = 0.5): { segment: Segment; score: number } | null {
  const tokens = normalize(value)
    .split(/[^\p{L}\p{M}\p{N}.]+/u)
    .filter((t) => t.length >= 3 || /^\d/.test(t));
  if (!tokens.length) return null;
  let best: { segment: Segment; score: number } | null = null;
  for (const segment of segments) {
    const text = normalize(segment.text);
    const numbers = tokens.filter((t) => /^\d/.test(t));
    if (numbers.some((n) => !text.includes(n))) continue;
    const score = tokens.filter((t) => text.includes(t)).length / tokens.length;
    if (!best || score > best.score) best = { segment, score };
  }
  return best && best.score >= minScore ? best : null;
}

function groundTerm(kind: "symptom" | "medicine" | "allergen", name: string, segments: Segment[]) {
  const canonical = kind === "symptom" ? canonicalSymptom(name) : kind === "medicine" ? canonicalMedicine(name) : canonicalAllergen(name);
  if (canonical) {
    // Cross-language: "fever" is supported by "bukhar" / "बुखार" in the notes.
    const segment = segments.find((s) => mentionsTerm(kind, canonical, s.text));
    if (segment) return { canonical, segment, score: 1 };
  }
  const g = ground(name, segments);
  return g ? { canonical: canonical ?? name, ...g } : null;
}

const conf = (score: number, rel = 1) => Math.round((0.55 + 0.2 * score) * Math.max(0.5, rel) * 100) / 100;

export function llmOutputToExtraction(obj: Record<string, unknown>, segments: Segment[]): Extraction {
  const out = emptyExtraction();
  const dropped: string[] = [];
  const evidenceOf = (s: Segment) => s.text.slice(0, 160);
  const meta = (s: Segment, score: number) => ({
    confidence: conf(score, s.reliability),
    source: "llm" as const,
    source_ref: s.id,
    evidence: evidenceOf(s),
  });

  const cc = str(obj.chief_complaint, 1000);
  if (cc) {
    const g = ground(cc, segments);
    // A complaint is a paraphrase, so partial support is acceptable but lowers confidence.
    const segment = g?.segment ?? segments[0];
    if (segment) out.chief_complaint = { value: cc, ...meta(segment, g ? g.score : 0), confidence: g ? conf(g.score) : 0.35 };
  }

  for (const s of arr(obj.symptoms)) {
    const o = (typeof s === "string" ? { name: s } : s) as Record<string, unknown>;
    const name = str(o?.name);
    if (!name) continue;
    const g = groundTerm("symptom", name, segments);
    if (!g) {
      dropped.push(`symptom "${name}"`);
      continue;
    }
    const severity = str(o.severity);
    const duration = str(o.duration);
    out.symptoms.push({
      value: {
        name: g.canonical,
        // Small models put frequencies ("twice daily") into durations; keep only supported ones.
        duration: duration && parseDuration(duration) && ground(duration, segments, 1) ? parseDuration(duration) : null,
        severity: severity && ["mild", "moderate", "severe"].includes(severity.toLowerCase()) ? (severity.toLowerCase() as "mild") : null,
      },
      ...meta(g.segment, g.score),
    });
  }

  const vitals = (obj.vitals ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(VITAL_RANGES) as (keyof Vitals)[]) {
    const v = num(vitals[key]);
    if (v === null) continue;
    const value = VITAL_RANGES[key].integer ? Math.round(v) : Math.round(v * 10) / 10;
    if (checkVital(key, value)) {
      dropped.push(`${key.replace(/_/g, " ")} ${v} (out of range)`);
      continue;
    }
    const g = ground(String(value), segments);
    if (!g) {
      dropped.push(`${key.replace(/_/g, " ")} ${value}`);
      continue;
    }
    out.vitals[key] = { value, ...meta(g.segment, g.score) };
  }

  for (const d of arr(obj.diagnosis)) {
    const name = str(d);
    if (!name) continue;
    // A diagnosis must be fully written in the notes: "fever" does not support "Typhoid fever".
    const g = ground(name, segments, 1);
    if (!g) {
      dropped.push(`diagnosis "${name}"`);
      continue;
    }
    out.diagnosis.push({ value: name[0].toUpperCase() + name.slice(1), ...meta(g.segment, g.score) });
  }

  for (const m of arr(obj.medications)) {
    const o = (typeof m === "string" ? { name: m } : m) as Record<string, unknown>;
    const name = str(o?.name);
    if (!name) continue;
    const g = groundTerm("medicine", name, segments);
    if (!g) {
      dropped.push(`medicine "${name}"`);
      continue;
    }
    out.medications.push({
      value: { name: g.canonical, dose: str(o.dose), frequency: str(o.frequency), duration: str(o.duration), route: str(o.route, 50) },
      ...meta(g.segment, g.score),
    });
  }

  for (const a of arr(obj.allergies)) {
    const name = str(typeof a === "object" && a ? (a as Record<string, unknown>).substance : a);
    if (!name || /^(none|no|nil|nkda)$/i.test(name)) continue;
    const g = groundTerm("allergen", name, segments);
    if (!g) {
      dropped.push(`allergy "${name}"`);
      continue;
    }
    out.allergies.push({ value: { substance: g.canonical, reaction: null, severity: null }, ...meta(g.segment, g.score) });
  }

  const days = num(obj.follow_up_days);
  if (days !== null && days > 0 && days <= 365) {
    const g = ground(String(Math.round(days)), segments) ?? ground(String(Math.round(days / 7)), segments);
    if (g) out.follow_up = { value: { in_days: Math.round(days), instructions: "" }, ...meta(g.segment, g.score) };
  }

  if (dropped.length) {
    out.warnings.push(`On-device AI suggested items not found in the notes, so they were NOT added: ${dropped.join(", ")}.`);
  }
  return out;
}

export async function extractWithLlm(segments: Segment[], generate: Generate): Promise<Extraction> {
  const raw = await generate(buildMessages(segments), JSON_PREFILL);
  const obj = parseJsonObject(raw);
  if (!obj) {
    const out = emptyExtraction();
    out.warnings.push("On-device AI output could not be read; showing rule-based results only.");
    return out;
  }
  return llmOutputToExtraction(obj, segments);
}
