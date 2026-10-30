/**
 * Patient history summary (Phase 6: RAG over the patient's own records).
 *
 * Retrieval: all of the patient's past visits/documents are candidates (a patient's history
 * is small); the top-k most relevant to the current visit are ranked by shared clinical tags
 * (from the search index) with a recency decay.
 * Generation: deterministic aggregation into statements, every one carrying links to the
 * exact records it came from, so the clinician can verify each line. An optional on-device
 * LLM narrative (see narrative.ts) is only allowed to cite these statements.
 */
import { canonicalMedicine } from "../../ai/extract/rules";
import type { ConsultationData, DocumentData, LocalRecord, PatientData, SearchEntry, Vitals } from "../types";

export interface SourceLink {
  entity: "patient" | "consultation" | "document";
  id: string;
  date: string | null;
  /** Visit not yet verified by a clinician: shown so nobody mistakes it for a confirmed fact. */
  unverified: boolean;
}

export interface Statement {
  text: string;
  sources: SourceLink[];
}

export interface TrendPoint {
  date: string;
  value: number;
  source: SourceLink;
}

export interface Trend {
  key: string;
  label: string;
  unit: string;
  series: { name: string; points: TrendPoint[] }[];
  statement: Statement;
}

export interface RelevantVisit {
  source: SourceLink;
  score: number;
  shared: string[];
  summary: string;
}

export interface HistorySummary {
  visitCount: number;
  firstVisit: string | null;
  lastVisit: string | null;
  alerts: Statement[];
  allergies: Statement[];
  conditions: Statement[];
  medications: Statement[];
  trends: Trend[];
  relevant: RelevantVisit[];
}

const link = (r: LocalRecord<ConsultationData>): SourceLink => ({
  entity: "consultation",
  id: r.id,
  date: r.data!.visit_date,
  unverified: r.data!.review.status !== "verified",
});

const patientLink = (r: LocalRecord<PatientData>): SourceLink => ({ entity: "patient", id: r.id, date: null, unverified: false });

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const VITAL_TRENDS: { key: string; label: string; unit: string; series: [keyof Vitals, string][]; decimals: number }[] = [
  { key: "bp", label: "Blood pressure", unit: "mmHg", series: [["bp_systolic", "Systolic"], ["bp_diastolic", "Diastolic"]], decimals: 0 },
  { key: "weight", label: "Weight", unit: "kg", series: [["weight_kg", "Weight"]], decimals: 1 },
  { key: "glucose", label: "Blood glucose", unit: "mg/dL", series: [["blood_glucose_mg_dl", "Glucose"]], decimals: 0 },
  { key: "spo2", label: "SpO₂", unit: "%", series: [["spo2", "SpO₂"]], decimals: 0 },
  { key: "pulse", label: "Pulse", unit: "/min", series: [["pulse", "Pulse"]], decimals: 0 },
];

function describeChange(label: string, unit: string, points: TrendPoint[], decimals: number): string {
  const first = points[0];
  const last = points[points.length - 1];
  const f = (v: number) => v.toFixed(decimals);
  if (points.length === 1) return `${label} ${f(last.value)} ${unit} on ${fmtDate(last.date)}.`;
  const delta = last.value - first.value;
  const rel = Math.abs(delta) / Math.max(1e-9, Math.abs(first.value));
  const dir = rel < 0.03 ? "stable" : delta > 0 ? "up" : "down";
  return dir === "stable"
    ? `${label} stable around ${f(last.value)} ${unit} across ${plural(points.length, "reading")}.`
    : `${label} ${dir === "up" ? "rose" : "fell"} from ${f(first.value)} to ${f(last.value)} ${unit} (${fmtDate(first.date)} → ${fmtDate(last.date)}).`;
}

/** Shared clinical tags between two index entries, for relevance ranking. */
function clinicalTags(e: SearchEntry | undefined): Set<string> {
  return new Set((e?.tokens ?? []).filter((t) => /^(sym|med|dx|lab|all):/.test(t)));
}

const tagLabel = (t: string) => {
  const [kind, v] = t.split(":");
  const name = v.replace(/_/g, " ");
  return { sym: "symptom", med: "medicine", dx: "diagnosis", lab: "lab", all: "allergy" }[kind] + `: ${name}`;
};

export function summarizeHistory(input: {
  patient: LocalRecord<PatientData>;
  consultations: LocalRecord<ConsultationData>[];
  documents?: LocalRecord<DocumentData>[];
  index?: SearchEntry[];
  /** The visit being worked on: excluded from history, used for relevance and alerts. */
  current?: LocalRecord<ConsultationData>;
  topK?: number;
  today?: string;
}): HistorySummary {
  const { patient, current } = input;
  const p = patient.data!;
  const visits = input.consultations
    .filter((c) => !c.deleted && c.data && c.id !== current?.id && c.data.review.status !== "rejected")
    .sort((a, b) => a.data!.visit_date.localeCompare(b.data!.visit_date));

  // ---- allergies: patient profile + any visit that recorded one
  const allergyMap = new Map<string, Statement>();
  for (const a of p.known_allergies) {
    allergyMap.set(a.substance.toLowerCase(), { text: a.substance + (a.reaction ? ` (${a.reaction})` : ""), sources: [patientLink(patient)] });
  }
  for (const v of visits) {
    for (const a of v.data!.allergies) {
      const k = a.substance.toLowerCase();
      const s = allergyMap.get(k) ?? { text: a.substance + (a.reaction ? ` (${a.reaction})` : ""), sources: [] };
      s.sources.push(link(v));
      allergyMap.set(k, s);
    }
  }

  // ---- conditions: chronic conditions + diagnoses with first/last seen
  const condMap = new Map<string, { name: string; visits: LocalRecord<ConsultationData>[]; chronic: boolean }>();
  for (const c of p.chronic_conditions) condMap.set(c.toLowerCase(), { name: c, visits: [], chronic: true });
  for (const v of visits) {
    for (const d of v.data!.diagnosis) {
      const k = d.replace(/\s*\(suspected\)$/i, "").toLowerCase();
      const entry = condMap.get(k) ?? { name: d, visits: [], chronic: false };
      entry.visits.push(v);
      condMap.set(k, entry);
    }
  }
  const conditions: Statement[] = [...condMap.values()].map((c) => {
    const dates = c.visits.map((v) => v.data!.visit_date);
    const seen = dates.length
      ? dates.length === 1
        ? ` (recorded ${fmtDate(dates[0])})`
        : ` (recorded on ${plural(dates.length, "visit")}, ${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])})`
      : "";
    return {
      text: `${c.name}${c.chronic ? ", known chronic condition" : ""}${seen}`,
      sources: [...(c.chronic ? [patientLink(patient)] : []), ...c.visits.map(link)],
    };
  });

  // ---- medications: last prescription details + how often
  const medMap = new Map<string, { name: string; visits: LocalRecord<ConsultationData>[]; last: ConsultationData["medications"][number] }>();
  for (const v of visits) {
    for (const m of v.data!.medications) {
      const k = (canonicalMedicine(m.name) ?? m.name).toLowerCase();
      const entry = medMap.get(k) ?? { name: canonicalMedicine(m.name) ?? m.name, visits: [], last: m };
      entry.visits.push(v);
      entry.last = m;
      medMap.set(k, entry);
    }
  }
  const medications: Statement[] = [...medMap.values()]
    .sort((a, b) => b.visits[b.visits.length - 1].data!.visit_date.localeCompare(a.visits[a.visits.length - 1].data!.visit_date))
    .map((m) => {
      const details = [m.last.dose, m.last.frequency, m.last.duration && `for ${m.last.duration}`].filter(Boolean).join(", ");
      const lastDate = m.visits[m.visits.length - 1].data!.visit_date;
      return {
        text: `${m.name}${details ? ` ${details}` : ""}: last prescribed ${fmtDate(lastDate)}${m.visits.length > 1 ? `, ${plural(m.visits.length, "visit")} in total` : ""}`,
        sources: m.visits.map(link),
      };
    });

  // ---- trends: vitals over time + lab values
  const trends: Trend[] = [];
  for (const t of VITAL_TRENDS) {
    const series = t.series.map(([key, name]) => ({
      name,
      points: visits
        .filter((v) => typeof v.data!.vitals[key] === "number")
        .map((v) => ({ date: v.data!.visit_date, value: v.data!.vitals[key] as number, source: link(v) })),
    }));
    const main = series[0].points;
    if (main.length === 0) continue;
    let text = describeChange(t.label === "Blood pressure" ? "Systolic BP" : t.label, t.unit, main, t.decimals);
    if (t.key === "bp") {
      const high = visits.filter((v) => (v.data!.vitals.bp_systolic ?? 0) >= 140 || (v.data!.vitals.bp_diastolic ?? 0) >= 90);
      if (high.length) text += ` BP was 140/90 or higher on ${plural(high.length, "visit")} of ${main.length}.`;
    }
    trends.push({ key: t.key, label: t.label, unit: t.unit, series, statement: { text, sources: main.map((pt) => pt.source) } });
  }
  const labs = new Map<string, TrendPoint[]>();
  const labUnits = new Map<string, string>();
  for (const v of visits) {
    for (const l of v.data!.lab_results ?? []) {
      const n = parseFloat(l.value.replace(/[<>,]/g, ""));
      if (!Number.isFinite(n)) continue;
      labs.set(l.name, [...(labs.get(l.name) ?? []), { date: v.data!.visit_date, value: n, source: link(v) }]);
      if (l.unit) labUnits.set(l.name, l.unit);
    }
  }
  for (const [name, points] of labs) {
    const unit = labUnits.get(name) ?? "";
    trends.push({
      key: `lab:${name}`,
      label: name,
      unit,
      series: [{ name, points }],
      statement: { text: describeChange(name, unit, points, 1), sources: points.map((pt) => pt.source) },
    });
  }

  // ---- retrieval: past visits most relevant to the current one
  const index = new Map((input.index ?? []).map((e) => [e.entity_id, e]));
  const currentTags = clinicalTags(current ? index.get(current.id) : undefined);
  const today = input.today ?? current?.data?.visit_date ?? new Date().toISOString().slice(0, 10);
  const relevant: RelevantVisit[] = visits
    .map((v) => {
      const shared = [...clinicalTags(index.get(v.id))].filter((t) => currentTags.has(t));
      const ageDays = Math.max(0, (Date.parse(today) - Date.parse(v.data!.visit_date)) / 86_400_000);
      const recency = Math.exp(-ageDays / 180); // half-weight after ~4 months
      const d = v.data!;
      return {
        source: link(v),
        score: shared.length * 2 + recency,
        shared: shared.map(tagLabel),
        summary: d.chief_complaint ?? (d.symptoms.map((s) => s.name).join(", ") || d.diagnosis.join(", ") || "Visit"),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, input.topK ?? 5);

  // ---- alerts: deterministic safety checks against the current visit
  const alerts: Statement[] = [];
  if (current?.data) {
    for (const m of current.data.medications) {
      const name = canonicalMedicine(m.name) ?? m.name;
      const allergy = allergyMap.get(name.toLowerCase()) ?? allergyMap.get(m.name.toLowerCase());
      if (allergy) alerts.push({ text: `${name} is prescribed in this visit, but the patient has a recorded allergy to it.`, sources: allergy.sources });
    }
  }
  const bp = trends.find((t) => t.key === "bp");
  const lastTwoHigh = bp?.series[0].points.slice(-2).filter((pt) => pt.value >= 140);
  if (lastTwoHigh && lastTwoHigh.length === 2) {
    alerts.push({ text: "Systolic BP was 140 or higher at the last two visits.", sources: lastTwoHigh.map((pt) => pt.source) });
  }

  return {
    visitCount: visits.length,
    firstVisit: visits[0]?.data!.visit_date ?? null,
    lastVisit: visits[visits.length - 1]?.data!.visit_date ?? null,
    alerts,
    allergies: [...allergyMap.values()],
    conditions,
    medications,
    trends,
    relevant,
  };
}
