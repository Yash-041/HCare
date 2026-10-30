/**
 * Offline search over the local index.
 *
 *  - Multilingual by construction: query phrases are mapped through the clinical lexicon
 *    ("bukhar", "बुखार", "fever" -> sym:fever; "dolo" -> med:paracetamol), the same way the
 *    index was built.
 *  - Every query word must match (AND), by tag, exact word, prefix or (fallback) a typo.
 *  - Optional semantic re-ranking with on-device embeddings adds "related" results.
 */
import { canonicalMedicine, canonicalSymptom, normalize } from "../../ai/extract/rules";
import { MEDICINES, SYMPTOMS } from "../../ai/extract/lexicon";
import type { HCareDB } from "../db";
import type { EntityName, SearchEntry } from "../types";
import { words } from "./indexer";

export interface SearchFilters {
  types?: EntityName[];
  dateFrom?: string | null;
  dateTo?: string | null;
  patientId?: string;
}

export interface SearchHit {
  entry: SearchEntry;
  score: number;
  /** Why it matched, for display: "symptom: fever", "name", "typo: ramesh", "related". */
  reasons: string[];
}

export type Embed = (texts: string[]) => Promise<number[][]>;

interface Term {
  label: string;
  /** Exact index tokens (tags or words) that satisfy this term. */
  exact: string[];
  /** Word to prefix-match (null for pure tag terms). */
  prefix: string | null;
}

// All clinical phrases (every language) compiled once into a single longest-first regex;
// compiling them per query cost ~100 ms.
let phraseIndex: { re: RegExp; tags: Map<string, string> } | null = null;
function phrases() {
  if (!phraseIndex) {
    const tags = new Map<string, string>([
      ...Object.entries(SYMPTOMS).flatMap(([c, forms]) => forms.map((f) => [normalize(f), `sym:${c}`] as [string, string])),
      ...Object.entries(MEDICINES).flatMap(([c, forms]) => forms.map((f) => [normalize(f), `med:${c}`] as [string, string])),
    ]);
    const alt = [...tags.keys()]
      .sort((a, b) => b.length - a.length)
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
      .join("|");
    phraseIndex = { re: new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(${alt})(?![\\p{L}\\p{M}])`, "gu"), tags };
  }
  return phraseIndex;
}

const tagSlug = (s: string) => normalize(s).trim().replace(/\s+/g, "_");
const DATE_ISO = /\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/;
const DATE_DMY = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/;

export function parseQuery(query: string): { terms: Term[]; canonicalText: string } {
  let q = ` ${normalize(query)} `;
  const terms: Term[] = [];
  const canonical: string[] = [];

  for (const re of [DATE_DMY, DATE_ISO]) {
    const m = re.exec(q);
    if (!m) continue;
    const iso = re === DATE_DMY ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`;
    terms.push({ label: `date ${iso}`, exact: [`date:${iso}`], prefix: null });
    q = q.replace(m[0], " ");
  }

  const { re, tags } = phrases();
  re.lastIndex = 0;
  for (const m of [...q.matchAll(re)]) {
    const tag = tags.get(m[1].replace(/\s+/g, " "));
    if (!tag) continue;
    const at = m.index!;
    const phrase = m[0];
    const [kind, name] = tag.split(":");
    const canon = kind === "sym" ? (canonicalSymptom(name) ?? name) : (canonicalMedicine(name) ?? name);
    terms.push({
      label: `${kind === "sym" ? "symptom" : "medicine"}: ${canon}`,
      // The tag is always indexed (structured fields + lexicon scan of free text). The bare
      // word is added only for one-word terms; "body ache" must not match any "body".
      exact: [`${kind}:${tagSlug(canon)}`, ...(/\s/.test(canon) ? [] : words(canon))],
      prefix: null,
    });
    canonical.push(canon);
    q = q.slice(0, at) + " ".repeat(phrase.length) + q.slice(at + phrase.length);
  }

  for (const w of words(q)) {
    terms.push({ label: w, exact: [w, `dx:${w}`, `all:${w}`, `lab:${w}`], prefix: w });
    canonical.push(w);
  }
  return { terms, canonicalText: canonical.join(" ") };
}

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** entity_id -> [score, reason] for one term. */
async function matchTerm(db: HCareDB, term: Term, vocabulary: () => Promise<string[]>): Promise<Map<string, [number, string]>> {
  const hits = new Map<string, [number, string]>();
  const add = (ids: string[], score: number, reason: string) => {
    for (const id of ids) if ((hits.get(id)?.[0] ?? 0) < score) hits.set(id, [score, reason]);
  };
  // One equals() per token, keys only: anyOf() on a multi-entry index was orders of
  // magnitude slower, and full entries are fetched once, after intersecting.
  const keysFor = (tokens: string[]) =>
    Promise.all(tokens.map((t) => db.search_index.where("tokens").equals(t).primaryKeys() as Promise<string[]>));
  const exact = await keysFor(term.exact);
  term.exact.forEach((t, i) => add(exact[i], t.includes(":") ? 3 : 2, term.label));
  if (term.prefix && term.prefix.length >= 2) {
    add((await db.search_index.where("tokens").startsWith(term.prefix).primaryKeys()) as string[], 1, term.label);
  }
  if (hits.size === 0 && term.prefix && term.prefix.length >= 4) {
    // Typo tolerance: nearest indexed words (1 edit, 2 for long words).
    const max = term.prefix.length >= 8 ? 2 : 1;
    const near = (await vocabulary()).filter((t) => !t.includes(":") && levenshtein(term.prefix!, t, max) <= max).slice(0, 20);
    if (near.length) add((await keysFor(near)).flat(), 0.5, `≈ ${near[0]}`);
  }
  return hits;
}

const cosine = (a: number[], b: number[]) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // vectors are L2-normalized
};

export async function search(
  db: HCareDB,
  query: string,
  filters: SearchFilters = {},
  opts: { embed?: Embed; limit?: number; semanticThreshold?: number } = {},
): Promise<SearchHit[]> {
  const { terms, canonicalText } = parseQuery(query);
  if (terms.length === 0) {
    // No words: a date range alone lists the visits/documents in it (newest first).
    if (!filters.dateFrom && !filters.dateTo) return [];
    const inRange = await db.search_index
      .where("date")
      .between(filters.dateFrom || "0000", filters.dateTo || "9999", true, true)
      .reverse()
      .toArray();
    return inRange
      .filter((e) => passes(e, filters))
      .slice(0, opts.limit ?? 100)
      .map((entry) => ({ entry, score: 1, reasons: [entry.date ?? ""] }));
  }

  let vocab: Promise<string[]> | null = null;
  const vocabulary = () => (vocab ??= db.search_index.orderBy("tokens").uniqueKeys().then((k) => k as string[]));

  // AND across terms.
  const perTerm = await Promise.all(terms.map((t) => matchTerm(db, t, vocabulary)));
  let ids = [...perTerm[0].keys()];
  for (const m of perTerm.slice(1)) ids = ids.filter((id) => m.has(id));

  const entries = new Map((await db.search_index.bulkGet(ids)).filter((e): e is SearchEntry => !!e).map((e) => [e.entity_id, e]));
  const hits: SearchHit[] = [];
  for (const id of ids) {
    const entry = entries.get(id);
    if (!entry || !passes(entry, filters)) continue;
    const parts = perTerm.map((m) => m.get(id)!);
    hits.push({ entry, score: parts.reduce((s, [v]) => s + v, 0) / terms.length, reasons: [...new Set(parts.map(([, r]) => r))] });
  }

  if (opts.embed) {
    // Semantic layer: re-rank keyword hits and add closely related records.
    const [q] = await opts.embed([canonicalText || query]);
    // Calibrated on all-MiniLM-L6-v2: unrelated clinical pairs scored <= 0.30, related ones
    // 0.48-0.60 (e.g. "breathing problem" -> breathlessness 0.60).
    const threshold = opts.semanticThreshold ?? 0.4;
    const seen = new Set(hits.map((h) => h.entry.entity_id));
    for (const h of hits) if (h.entry.embedding) h.score += 0.5 * cosine(q, h.entry.embedding);
    await db.search_index.each((e) => {
      if (seen.has(e.entity_id) || !e.embedding || !passes(e, filters)) return;
      const sim = cosine(q, e.embedding);
      if (sim >= threshold) hits.push({ entry: e, score: sim, reasons: [`related (${Math.round(sim * 100)}%)`] });
    });
  }

  // Ties: newest visits first.
  hits.sort((a, b) => b.score - a.score || (b.entry.date ?? "").localeCompare(a.entry.date ?? ""));
  return hits.slice(0, opts.limit ?? 100);
}

function passes(e: SearchEntry, f: SearchFilters): boolean {
  if (f.types?.length && !f.types.includes(e.entity)) return false;
  if (f.patientId && e.patient_id !== f.patientId) return false;
  if (f.dateFrom && (!e.date || e.date < f.dateFrom)) return false;
  if (f.dateTo && (!e.date || e.date > f.dateTo)) return false;
  return true;
}

// ------------------------------------------------------------------ semantic index upkeep

/** Embed entries whose summary text changed since they were last embedded. */
export async function embedPending(db: HCareDB, embed: Embed, batchSize = 16): Promise<number> {
  const pending = (await db.search_index.toArray()).filter((e) => e.text && e.embedded_hash !== e.text_hash);
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const vectors = await embed(batch.map((e) => e.text));
    await db.transaction("rw", db.search_index, async () => {
      for (let j = 0; j < batch.length; j++) {
        // Re-check: the entry may have been re-indexed with new text meanwhile.
        const current = await db.search_index.get(batch[j].entity_id);
        if (current && current.text_hash === batch[j].text_hash) {
          await db.search_index.update(current.entity_id, { embedding: vectors[j], embedded_hash: current.text_hash });
        }
      }
    });
  }
  return pending.length;
}
