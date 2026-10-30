/**
 * Deterministic clinical extraction. Instant, works on any device, and every value
 * carries the exact evidence it was read from. High precision by design: explicit
 * patterns only, negation-aware, and no inference (it never "diagnoses").
 */
import type { Allergy, LabResult, Medication, Symptom, Vitals } from "../../lib/types";
import { checkVital } from "../../lib/validation";
import { ALLERGENS, DURATION_UNITS, LAB_TESTS, MEDICINES, NUMBER_WORDS, SYMPTOMS } from "./lexicon";

export interface Segment {
  /** SourceRef id (voice note / document) the text came from. */
  id: string;
  kind: "audio" | "image" | "text";
  text: string;
  /** Scales confidence, e.g. OCR page confidence for scanned documents (0..1). */
  reliability?: number;
}

export interface Extracted<T> {
  value: T;
  confidence: number;
  source: "rule" | "llm";
  source_ref: string;
  evidence: string;
}

export interface Extraction {
  vitals: Partial<Record<keyof Vitals, Extracted<number>>>;
  symptoms: Extracted<Symptom>[];
  medications: Extracted<Medication>[];
  allergies: Extracted<Allergy>[];
  diagnosis: Extracted<string>[];
  lab_results: Extracted<LabResult>[];
  follow_up: Extracted<{ in_days: number; instructions: string }> | null;
  chief_complaint: Extracted<string> | null;
  warnings: string[];
}

export function emptyExtraction(): Extraction {
  return {
    vitals: {},
    symptoms: [],
    medications: [],
    allergies: [],
    diagnosis: [],
    lab_results: [],
    follow_up: null,
    chief_complaint: null,
    warnings: [],
  };
}

// ------------------------------------------------------------------ text helpers

const DEVANAGARI_DIGITS = "०१२३४५६७८९";

/** Lowercase, ASCII digits, and fold Devanagari spelling variants (nukta, chandrabindu). */
export function normalize(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)))
    .replace(/़/g, "") // nukta: ज़ -> ज
    .replace(/ँ/g, "ं") // chandrabindu -> anusvara: खाँसी -> खांसी
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .toLowerCase();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
// \b does not work for Devanagari; use Unicode letter/mark boundaries instead.
const B = "(?<![\\p{L}\\p{M}\\p{N}])";
const E = "(?![\\p{L}\\p{M}])";

function alternation(forms: string[]): string {
  return [...new Set(forms)]
    .sort((a, b) => b.length - a.length) // longest first: "loose motions" before "loose motion"
    .map(escape)
    .join("|");
}

function lexiconRegex(lex: Record<string, string[]>): { re: RegExp; lookup: Map<string, string> } {
  const lookup = new Map<string, string>();
  for (const [canonical, forms] of Object.entries(lex)) for (const f of forms) lookup.set(f.replace(/\s+/g, " "), canonical);
  return { re: new RegExp(`${B}(${alternation([...lookup.keys()])})${E}`, "gu"), lookup };
}

const symptomLex = lexiconRegex(SYMPTOMS);
const medicineLex = lexiconRegex(MEDICINES);
const allergenLex = lexiconRegex({ ...ALLERGENS, ...MEDICINES });
const labLex = lexiconRegex(LAB_TESTS);

function canonicalize(lex: { re: RegExp; lookup: Map<string, string> }, name: string): string | null {
  const n = normalize(name).trim().replace(/\s+/g, " ");
  const direct = lex.lookup.get(n);
  if (direct) return direct;
  for (const [canonical, c] of lex.lookup) if (c.toLowerCase() === n) return canonical;
  return null;
}

/** Map free-text names (e.g. from the LLM) to canonical lexicon entries, if known. */
export const canonicalSymptom = (name: string) =>
  canonicalize(symptomLex, name) ?? (Object.keys(SYMPTOMS).find((k) => k === normalize(name).trim()) || null);
export const canonicalMedicine = (name: string) =>
  canonicalize(medicineLex, name) ?? (Object.keys(MEDICINES).find((k) => k.toLowerCase() === normalize(name).trim()) || null);
export const canonicalAllergen = (name: string) =>
  canonicalize(allergenLex, name) ??
  (Object.keys({ ...ALLERGENS, ...MEDICINES }).find((k) => k.toLowerCase() === normalize(name).trim()) || null);

/** Does `text` mention any surface form of this canonical term (any language)? */
export function mentionsTerm(kind: "symptom" | "medicine" | "allergen", canonical: string, text: string): boolean {
  const lex = kind === "symptom" ? SYMPTOMS : kind === "medicine" ? MEDICINES : { ...ALLERGENS, ...MEDICINES };
  const forms = lex[canonical] ?? [];
  if (!forms.length) return false;
  return new RegExp(`${B}(${alternation(forms)})${E}`, "u").test(normalize(text));
}

/**
 * Canonical symptoms / medicines mentioned (not negated) anywhere in free text, in any
 * supported language. Used for search tags, so "bukhar" in a transcript is findable as "fever".
 */
export function lexiconTags(raw: string): { symptoms: string[]; medicines: string[]; spans: [number, number][] } {
  const text = normalize(raw);
  const symptoms = new Set<string>();
  const medicines = new Set<string>();
  const spans: [number, number][] = [];
  for (const m of matches(symptomLex.re, text)) {
    if (isNegated(text, m.index, m.index + m[0].length)) continue;
    symptoms.add(symptomLex.lookup.get(m[1].replace(/\s+/g, " "))!);
    spans.push([m.index, m.index + m[0].length]);
  }
  for (const m of matches(medicineLex.re, text)) {
    medicines.add(medicineLex.lookup.get(m[1].replace(/\s+/g, " "))!);
    spans.push([m.index, m.index + m[0].length]);
  }
  return { symptoms: [...symptoms], medicines: [...medicines], spans };
}

function* matches(re: RegExp, text: string): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) yield m;
}

/** The sentence-ish clause around an index, for evidence display. */
function clause(text: string, start: number, end: number): string {
  const from = Math.max(text.lastIndexOf("\n", start - 1), text.lastIndexOf(".", start - 1), text.lastIndexOf("।", start - 1)) + 1;
  const stops = ["\n", ". ", "।"].map((s) => text.indexOf(s, end)).filter((i) => i >= 0);
  const to = stops.length ? Math.min(...stops) : text.length;
  return text.slice(from, Math.min(to, from + 200)).trim();
}

const NEGATION_BEFORE = new RegExp(`${B}(no|not|denies|denied|without|negative for|absence of|never had)${E}`, "u");
const NEGATION_AFTER = new RegExp(`^\\s*(?:\\S+\\s+){0,2}?(nahi|nahin|nahi hai|nai|नहीं|नही)${E}`, "u");
const CLAUSE_BREAK = /[,.;:\n।]|\sbut\s|\slekin\s|\spar\s|\sलेकिन\s|\sपर\s/g;

function isNegated(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 40), start);
  let scopeStart = 0;
  for (const m of before.matchAll(CLAUSE_BREAK)) scopeStart = m.index! + m[0].length;
  if (NEGATION_BEFORE.test(before.slice(scopeStart))) return true;
  return NEGATION_AFTER.test(text.slice(end, end + 25));
}

// ------------------------------------------------------------------ durations

const NUM_ALT = `\\d+(?:\\.\\d+)?|${alternation(Object.keys(NUMBER_WORDS))}`;
const UNIT_ALT = alternation(Object.keys(DURATION_UNITS));
const DURATION_RE = new RegExp(`${B}(${NUM_ALT})\\s*(?:-|to)?\\s*(${UNIT_ALT})${E}`, "u");
const SINCE_RE = /(since yesterday|kal se|कल से|since last night|since morning|subah se|सुबह से|since today|aaj se|आज से)/u;

function toNumber(s: string): number | null {
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  return NUMBER_WORDS[s] ?? null;
}

export function parseDuration(text: string): string | null {
  const m = DURATION_RE.exec(text);
  if (m) {
    const n = toNumber(m[1]);
    const unit = DURATION_UNITS[m[2]];
    if (n !== null && unit) return `${n} ${unit}${n === 1 ? "" : "s"}`;
  }
  const s = SINCE_RE.exec(text);
  if (s) return /yesterday|kal|night/.test(s[1]) || s[1] === "कल से" ? "1 day" : "since today";
  return null;
}

// ------------------------------------------------------------------ vitals

interface VitalRule {
  key: keyof Vitals;
  re: RegExp;
  confidence: number;
  value: (m: RegExpExecArray) => number | null;
}

const N = "(\\d{1,3}(?:\\.\\d)?)";
const GAP = "[^\\d\\n]{0,15}?";
const NOT_DURATION = `(?!\\s*(?:${UNIT_ALT})${E})`;

const VITAL_RULES: VitalRule[] = [
  {
    key: "pulse",
    re: new RegExp(`${B}(?:pulse(?: rate)?|heart rate|hr|pr|नाडी|नब्ज|पल्स|nabz)${E}${GAP}(\\d{2,3})${NOT_DURATION}`, "gu"),
    confidence: 0.9,
    value: (m) => Number(m[1]),
  },
  {
    key: "spo2",
    re: new RegExp(`${B}(?:spo2|sp o2|spo 2|o2 sat|oxygen saturation|oxygen|saturation|sat|ऑक्सीजन)${E}${GAP}(\\d{2,3})\\s*%?`, "gu"),
    confidence: 0.9,
    value: (m) => Number(m[1]),
  },
  {
    key: "resp_rate",
    re: new RegExp(`${B}(?:resp(?:iratory)? rate|rr|breathing rate|respirations?)${E}${GAP}(\\d{1,2})${NOT_DURATION}`, "gu"),
    confidence: 0.85,
    value: (m) => Number(m[1]),
  },
  {
    key: "weight_kg",
    re: new RegExp(`${B}(?:weight|wt|वजन|vajan|wajan)${E}${GAP}${N}\\s*(?:kg|kgs|kilo|kilogram|किलो)?`, "gu"),
    confidence: 0.85,
    value: (m) => Number(m[1]),
  },
  {
    key: "weight_kg",
    re: new RegExp(`${B}${N}\\s*(?:kg|kgs|kilograms?|किलो)${E}`, "gu"),
    confidence: 0.7,
    value: (m) => Number(m[1]),
  },
  {
    key: "height_cm",
    re: new RegExp(`${B}(?:height|ht|lambai|लंबाई|कद)${E}${GAP}${N}\\s*(?:cm|cms|centimet(?:er|re)s?)?`, "gu"),
    confidence: 0.85,
    value: (m) => Number(m[1]),
  },
  {
    key: "blood_glucose_mg_dl",
    re: new RegExp(
      `${B}(?:(?:fasting |random |post ?prandial )?(?:blood )?(?:glucose|sugar)|rbs|fbs|ppbs|grbs|शुगर)${E}${GAP}(\\d{2,3})\\s*(?:mg\\s*/?\\s*dl)?`,
      "gu",
    ),
    confidence: 0.85,
    value: (m) => Number(m[1]),
  },
];

const BP_RE = new RegExp(
  `(?:${B}(?:bp|b\\.p\\.|blood pressure|बीपी|रक्तचाप)${E}${GAP})?${B}(\\d{2,3})\\s*(?:/|over|by|upon|बटा)\\s*(\\d{2,3})(\\s*mm\\s*hg)?`,
  "gu",
);
const TEMP_RE = new RegExp(
  `${B}(?:temp(?:erature)?|t|fever of|fever|bukhar|बुखार|तापमान)${E}${GAP}(\\d{2,3}(?:\\.\\d{1,2})?)${NOT_DURATION}\\s*(°\\s*[cf]|degrees?\\s*(?:celsius|fahrenheit|c|f)?|deg\\s*[cf]?|[cf](?![\\p{L}]))?`,
  "gu",
);

function extractVitals(seg: Segment, text: string, out: Extraction, rel: number) {
  const put = (key: keyof Vitals, value: number, confidence: number, start: number, end: number) => {
    const existing = out.vitals[key];
    if (checkVital(key, value)) {
      out.warnings.push(`Ignored ${key.replace(/_/g, " ")} ${value}: outside the plausible range.`);
      return;
    }
    if (existing && existing.confidence >= confidence * rel) return;
    out.vitals[key] = { value, confidence: confidence * rel, source: "rule", source_ref: seg.id, evidence: clause(text, start, end) };
  };

  for (const m of matches(BP_RE, text)) {
    const sys = Number(m[1]);
    const dia = Number(m[2]);
    const explicit = m[0].length > m[1].length + m[2].length + 3 || !!m[3];
    // A bare "a/b" without BP keyword or mmHg could be a date or a dose; skip it.
    if (!explicit || sys <= dia) continue;
    put("bp_systolic", sys, 0.9, m.index, m.index + m[0].length);
    put("bp_diastolic", dia, 0.9, m.index, m.index + m[0].length);
  }

  for (const m of matches(TEMP_RE, text)) {
    let v = Number(m[1]);
    const unit = (m[2] ?? "").replace(/[^cf]/g, "");
    let note = "";
    if (unit === "f" || (!unit && v >= 90 && v <= 110)) {
      note = ` (converted from ${v} °F)`;
      v = Math.round((((v - 32) * 5) / 9) * 10) / 10;
    }
    if (v < 30 || v > 45) continue;
    put("temperature_c", v, unit ? 0.9 : 0.8, m.index, m.index + m[0].length);
    if (note && out.vitals.temperature_c?.value === v) out.vitals.temperature_c.evidence += note;
  }

  for (const rule of VITAL_RULES) {
    for (const m of matches(rule.re, text)) {
      const v = rule.value(m);
      if (v !== null) put(rule.key, v, rule.confidence, m.index, m.index + m[0].length);
    }
  }
}

// ------------------------------------------------------------------ symptoms

const SINCE_ALT = "since yesterday|since last night|since morning|since today|kal se|subah se|aaj se|कल से|सुबह से|आज से";
const AFTER_DURATION_RE = new RegExp(
  `^\\s*(?:(?:for|since|from|x|×|of)\\s+)?(?:the\\s+)?(?:(?:past|last)\\s+)?((?:${NUM_ALT})\\s*(?:${UNIT_ALT})${E}|${SINCE_ALT})`,
  "u",
);
const BEFORE_DURATION_RE = new RegExp(
  `((?:${B}(?:${NUM_ALT})\\s*(?:${UNIT_ALT}))|${SINCE_ALT})\\s*(?:se|से|ki|की|ka|का|from)?\\s*(?:hi\\s+|ही\\s+)?` +
    // allow one severity word in between: "3 din se tez bukhar"
    `(?:(?:tez|bahut|high|halka|severe|mild|तेज|बहुत|हल्का)\\s*)?$`,
  "u",
);

const SEVERE = new RegExp(`${B}(severe|high|very|tez|bahut|तेज|बहुत|intense|unbearable)${E}`, "u");
const MILD = new RegExp(`${B}(mild|slight|low grade|low-grade|halka|हल्का|thoda|थोडा)${E}`, "u");

function extractSymptoms(seg: Segment, text: string, out: Extraction, rel: number) {
  for (const m of matches(symptomLex.re, text)) {
    const name = symptomLex.lookup.get(m[1].replace(/\s+/g, " "))!;
    const start = m.index;
    const end = start + m[0].length;
    if (isNegated(text, start, end)) continue;
    if (out.symptoms.some((s) => s.value.name === name)) continue;

    // Duration must be adjacent: after in English ("fever for 3 days"), before in Hindi
    // ("3 din se bukhar"). Anything further away belongs to another symptom.
    const after = text.slice(end, end + 45).split(/[.;\n।]/)[0];
    const before = text.slice(Math.max(0, start - 30), start).split(/[.;,\n।]/).pop() ?? "";
    const adjacentAfter = AFTER_DURATION_RE.exec(after)?.[1];
    const adjacentBefore = BEFORE_DURATION_RE.exec(before)?.[1];
    const duration = (adjacentAfter && parseDuration(adjacentAfter)) || (adjacentBefore && parseDuration(adjacentBefore)) || null;
    // Severity words must be right next to the symptom ("high fever", "bukhar tez").
    const near = before.trim().split(/\s+/).slice(-2).join(" ") + " " + after.trim().split(/\s+/).slice(0, 2).join(" ");
    const severity = SEVERE.test(near) ? "severe" : MILD.test(near) ? "mild" : null;
    out.symptoms.push({
      value: { name, duration, severity },
      confidence: (duration ? 0.85 : 0.75) * rel,
      source: "rule",
      source_ref: seg.id,
      evidence: clause(text, start, end),
    });
  }
}

// ------------------------------------------------------------------ allergies

const ALLERGY_PATTERNS = [
  // "allergic to penicillin", "allergy: sulfa", "allergy to dust"
  new RegExp(`${B}(?:allergic|allergy|allergies|एलर्जी)${E}\\s*(?:to|from|with|:|-|is|hai)?\\s*([\\p{L}\\p{M}][\\p{L}\\p{M}\\s-]{1,40})`, "gu"),
  // "penicillin se allergy", "धूल से एलर्जी", "penicillin allergy"
  new RegExp(`([\\p{L}\\p{M}][\\p{L}\\p{M}-]{1,30})\\s*(?:se|से)?\\s*(?:allergy|एलर्जी)${E}`, "gu"),
];
const ALLERGY_STOPWORDS =
  /^(to|is|hai|the|any|no|koi|nahi|से|se|known|history|drug|drugs|food|some|severe|mild|seasonal|skin|reaction|test|कोई|दवा)$/u;
const NO_ALLERGY_RE = new RegExp(
  `${B}(nkda|nka|no known (?:drug )?allerg(?:y|ies)|no allerg(?:y|ies)|koi allergy nahi|कोई एलर्जी नहीं)${E}`,
  "u",
);

/** Returns the text spans claimed by allergies so they aren't also read as prescriptions. */
function extractAllergies(seg: Segment, text: string, out: Extraction, rel: number): [number, number][] {
  const claimed: [number, number][] = [];
  if (NO_ALLERGY_RE.test(text)) out.warnings.push("Notes say: no known allergies.");
  for (const re of ALLERGY_PATTERNS) {
    for (const m of matches(re, text)) {
      // Stop at the end of the list: "allergic to penicillin and sulfa, has fever" -> two substances.
      const phrase = `${m[1]} `.split(/[.;\n।]|\s(?:but|has|have|had|was|since|hai|tha)\s|है/u)[0];
      const found = new Set<string>();
      for (const hit of matches(new RegExp(allergenLex.re.source, "gu"), phrase)) {
        found.add(allergenLex.lookup.get(hit[1].replace(/\s+/g, " "))!);
      }
      let confidence = 0.85;
      if (found.size === 0) {
        // Unknown substance: keep the first word, at lower confidence, for the clinician to check.
        const word = phrase.trim().split(/\s+/)[0];
        if (word && word.length > 2 && !ALLERGY_STOPWORDS.test(word)) {
          found.add(word[0].toUpperCase() + word.slice(1));
          confidence = 0.5;
        }
      }
      if (found.size === 0 || isNegated(text, m.index, m.index + m[0].length)) continue;
      claimed.push([m.index, m.index + m[0].length]);
      for (const substance of found) {
        if (out.allergies.some((a) => a.value.substance === substance)) continue;
        out.allergies.push({
          value: { substance, reaction: null, severity: null },
          confidence: confidence * rel,
          source: "rule",
          source_ref: seg.id,
          evidence: clause(text, m.index, m.index + m[0].length),
        });
      }
    }
  }
  return claimed;
}

// ------------------------------------------------------------------ medications

const DOSE_RE = /(\d+(?:\.\d+)?)\s*(mg|mcg|µg|g|gm|ml|iu|units?)(?![\p{L}])/u;
// Most specific first: "twice daily" must not be caught by the bare "daily" of once-daily.
const FREQUENCIES: [RegExp, string][] = [
  [/\b(\d)\s*-\s*(\d)\s*-\s*(\d)\b/, ""],
  [new RegExp(`${B}(qid|four times (?:a )?day|four times daily|char baar|चार बार)${E}`, "u"), "four times daily"],
  [new RegExp(`${B}(tds|tid|thrice (?:a )?day|thrice daily|three times (?:a |per )?day|three times daily|teen baar|तीन बार)${E}`, "u"), "three times daily"],
  [new RegExp(`${B}(bd|bid|twice (?:a |per )?day|twice daily|two times (?:a )?day|do baar|din mein do baar|दिन में दो बार|दो बार)${E}`, "u"), "twice daily"],
  [new RegExp(`${B}(od|qd|once (?:a |per )?day|once daily|daily|din mein ek baar|दिन में एक बार|एक बार)${E}`, "u"), "once daily"],
  [new RegExp(`${B}(hs|at bedtime|at night|raat ko|रात को)${E}`, "u"), "at night"],
  [new RegExp(`${B}(sos|prn|as needed|when needed|if needed|zarurat padne par|जरूरत पडने पर)${E}`, "u"), "as needed"],
  [new RegExp(`${B}(stat)${E}`, "u"), "stat"],
];
// Course length needs an explicit marker ("for 5 days", "x 5 days", "5 din tak"), otherwise
// "twice a day" would read as a one-day course.
const COURSE_RE = new RegExp(
  `(?:(?:${B}for|x|×)\\s*(?:${NUM_ALT})\\s*(?:${UNIT_ALT})${E})|(?:${B}(?:${NUM_ALT})\\s*(?:${UNIT_ALT})\\s*(?:tak|तक)${E})`,
  "u",
);
const ROUTES: [RegExp, string][] = [
  [new RegExp(`${B}(iv|intravenous)${E}`, "u"), "IV"],
  [new RegExp(`${B}(im|intramuscular)${E}`, "u"), "IM"],
  [new RegExp(`${B}(inj|injection|इंजेक्शन)${E}`, "u"), "injection"],
  [new RegExp(`${B}(inhaler|puffs?|nebuli[sz]ation)${E}`, "u"), "inhaled"],
  [new RegExp(`${B}(drops?|ointment|cream|gel)${E}`, "u"), "topical"],
  [new RegExp(`${B}(tab|tabs|tablets?|cap|caps|capsules?|syrup|syp|suspension|oral|by mouth|गोली)${E}`, "u"), "oral"],
];

function extractMedications(seg: Segment, text: string, out: Extraction, rel: number, claimed: [number, number][]) {
  const hits = [...matches(medicineLex.re, text)].filter(
    (m) => !claimed.some(([a, b]) => m.index >= a && m.index < b) && !isNegated(text, m.index, m.index + m[0].length),
  );
  hits.forEach((m, i) => {
    const name = medicineLex.lookup.get(m[1].replace(/\s+/g, " "))!;
    const start = m.index;
    const end = start + m[0].length;
    // Details belong to this medicine until the next medicine or the end of the sentence.
    const limit = Math.min(hits[i + 1]?.index ?? text.length, end + 80);
    const tail = text.slice(end, limit).split(/[.;\n।](?!\d)/)[0];
    const head = text.slice(Math.max(0, start - 20), start).split(/[.;,\n।]/).pop() ?? "";

    const dose = DOSE_RE.exec(tail);
    let frequency: string | null = null;
    for (const [re, label] of FREQUENCIES) {
      const f = re.exec(tail);
      if (f) {
        frequency = label || f[0].replace(/\s+/g, "");
        break;
      }
    }
    const course = COURSE_RE.exec(tail);
    const route = ROUTES.find(([re]) => re.test(head + " " + tail))?.[1] ?? null;
    const durationText = course ? parseDuration(course[0]) : null;
    const details = [dose, frequency, durationText].filter(Boolean).length;

    const existing = out.medications.find((x) => x.value.name === name);
    if (existing && existing.confidence >= (0.6 + 0.1 * details) * rel) return;
    if (existing) out.medications.splice(out.medications.indexOf(existing), 1);
    out.medications.push({
      value: {
        name,
        dose: dose ? `${dose[1]} ${dose[2].replace(/^gm$/, "g").replace(/^units?$/, "units")}` : null,
        frequency,
        duration: durationText,
        route,
      },
      confidence: Math.min(0.9, 0.6 + 0.1 * details) * rel,
      source: "rule",
      source_ref: seg.id,
      evidence: clause(text, start, end),
    });
  });
}

// ------------------------------------------------------------------ labs

const LAB_VALUE_RE =
  /^[\s:=\-–()]*(?:\(?[a-z/ ]{0,12}\)?)?[\s:=\-–]*([<>]?\s*\d+(?:[.,]\d+)?|positive|negative|non[- ]?reactive|reactive|present|absent|detected|not detected|nil|trace)\s*(g\s*\/\s*dl|gm\s*\/\s*dl|mg\s*\/\s*dl|mmol\s*\/\s*l|meq\s*\/\s*l|u\s*\/\s*l|iu\s*\/\s*l|%|\/\s*cumm|cells\s*\/\s*cumm|lakhs?\s*\/\s*cumm|lakh|mill(?:ion)?\s*\/\s*cumm|µ?iu\s*\/\s*ml|miu\s*\/\s*l|ng\s*\/\s*ml|mm\s*\/\s*hr|mm\/1st hr)?/u;

function extractLabs(seg: Segment, text: string, out: Extraction, rel: number) {
  for (const m of matches(labLex.re, text)) {
    const name = labLex.lookup.get(m[1].replace(/\s+/g, " "))!;
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 40).split("\n")[0];
    const v = LAB_VALUE_RE.exec(tail);
    if (!v || out.lab_results.some((l) => l.value.name === name)) continue;
    const unit = v[2]?.replace(/\s+/g, "").replace(/^gm/, "g") ?? null;
    out.lab_results.push({
      value: { name, value: v[1].replace(/\s+/g, "").replace(",", "."), unit: unit ? unit.replace("dl", "dL") : null },
      confidence: (unit ? 0.85 : 0.7) * rel,
      source: "rule",
      source_ref: seg.id,
      evidence: clause(text, m.index, m.index + m[0].length),
    });
  }
}

// ------------------------------------------------------------------ diagnosis & follow-up

const DIAGNOSIS_RE = new RegExp(
  `${B}(?:provisional diagnosis|diagnosis|diagnosed with|impression|dx|known case of|k/c/o|kco|suspected|nidan|निदान)${E}\\s*(?:is|of|as|:|-)?\\s*([^.;\\n।]{3,80})`,
  "gu",
);

function extractDiagnosis(seg: Segment, text: string, out: Extraction, rel: number) {
  for (const m of matches(DIAGNOSIS_RE, text)) {
    const suspected = /suspected/.test(m[0]);
    for (const part of m[1].split(/,|\band\b|\bwith\b|\baur\b|और/)) {
      const name = part
        .replace(/\b(advised|given|started|prescribed|tests?|investigations?|referred|to|for|patient)\b.*$/, "")
        .trim()
        .replace(/^(a|an|the)\s+/, "");
      if (name.length < 3) continue;
      const label = name[0].toUpperCase() + name.slice(1) + (suspected ? " (suspected)" : "");
      if (out.diagnosis.some((d) => d.value.toLowerCase() === label.toLowerCase())) continue;
      out.diagnosis.push({
        value: label,
        confidence: 0.8 * rel,
        source: "rule",
        source_ref: seg.id,
        evidence: clause(text, m.index, m.index + m[0].length),
      });
    }
  }
}

const FOLLOW_UP_RE = new RegExp(
  `(?:${B}(?:follow[- ]?up|review|revisit|come back|return|recheck|dobara|fir se|phir se|दोबारा|फिर से)${E}[^\\d\\n]{0,20}?(?:after|in|within)?\\s*(${NUM_ALT})\\s*(${UNIT_ALT})${E})|(?:(${NUM_ALT})\\s*(${UNIT_ALT})\\s*(?:baad|बाद)${E})`,
  "u",
);
const UNIT_DAYS = { day: 1, week: 7, month: 30, year: 365 } as const;

function extractFollowUp(seg: Segment, text: string, out: Extraction, rel: number) {
  if (out.follow_up) return;
  const m = FOLLOW_UP_RE.exec(text);
  if (!m) return;
  const n = toNumber(m[1] ?? m[3]);
  const unit = DURATION_UNITS[m[2] ?? m[4]];
  if (!n || !unit) return;
  const evidence = clause(text, m.index, m.index + m[0].length);
  out.follow_up = {
    value: { in_days: n * UNIT_DAYS[unit], instructions: evidence },
    confidence: 0.8 * rel,
    source: "rule",
    source_ref: seg.id,
    evidence,
  };
}

// ------------------------------------------------------------------ entry point

export function extractWithRules(segments: Segment[]): Extraction {
  const out = emptyExtraction();
  for (const seg of segments) {
    const text = normalize(seg.text);
    const rel = Math.max(0.5, Math.min(1, seg.reliability ?? 1));
    extractVitals(seg, text, out, rel);
    extractSymptoms(seg, text, out, rel);
    const claimed = extractAllergies(seg, text, out, rel);
    extractMedications(seg, text, out, rel, claimed);
    extractLabs(seg, text, out, rel);
    extractDiagnosis(seg, text, out, rel);
    extractFollowUp(seg, text, out, rel);
  }
  if (out.symptoms.length) {
    const top = out.symptoms.slice(0, 3).map((s) => s.value.name + (s.value.duration ? ` for ${s.value.duration}` : ""));
    const first = out.symptoms[0];
    out.chief_complaint = {
      value: top.join(", ").replace(/^./, (c) => c.toUpperCase()),
      confidence: 0.6,
      source: "rule",
      source_ref: first.source_ref,
      evidence: first.evidence,
    };
  }
  out.warnings = [...new Set(out.warnings)];
  return out;
}
