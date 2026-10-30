/**
 * Local search index (IndexedDB `search_index`), maintained automatically: Dexie hooks on
 * the record tables queue every create/update/delete, whatever the source (local save,
 * sync pull, conflict resolution), and a debounced flush re-derives the entries.
 */
import { lexiconTags, normalize } from "../../ai/extract/rules";
import type { Vault } from "../crypto/vault";
import type { HCareDB } from "../db";
import type { ConsultationData, DocumentData, EntityName, LocalRecord, PatientData, SearchEntry } from "../types";

/** Bump when tokenization changes; the index is then rebuilt on next start. */
export const INDEX_VERSION = 2; // v2: blind (HMAC) tokens + prefix tokens

/**
 * Make an entry safe to store: every token becomes a keyed hash (blind index), so the
 * searchable index holds no readable names, symptoms or dates, while equal words still
 * match. Prefix search works through hashed prefixes ("pre:ram" for "ramesh"), and the
 * plain word list needed for typo tolerance is kept in an encrypted field.
 */
export function sealEntry(entry: SearchEntry, vault: Vault): SearchEntry {
  const plainWords = entry.tokens.filter((t) => !t.includes(":"));
  const prefixes = plainWords.flatMap((w) =>
    Array.from({ length: Math.max(0, Math.min(w.length - 1, 10) - 1) }, (_, i) => `pre:${w.slice(0, i + 2)}`),
  );
  const tokens = [...new Set([...entry.tokens, ...prefixes])].map((t) => vault.blind(t));
  return { ...entry, tokens, words: [...new Set(plainWords)] };
}
const MAX_TOKENS = 400; // before prefix expansion

const STOPWORDS = new Set(
  (
    "the a an and or of for with to in on at is are was were has have had be been by from as it this that " +
    "patient pt c/o mareez marij hai hain ka ki ke ko se aur mein me bhi tha thi ho raha rahi " +
    "है हैं का की के को से और में भी था थी हो"
  ).split(" "),
);

export function words(text: string | null | undefined): string[] {
  if (!text) return [];
  return normalize(text)
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

const slug = (s: string) => normalize(s).trim().replace(/\s+/g, "_");

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function finish(e: Omit<SearchEntry, "tokens" | "text_hash"> & { tokens: Iterable<string> }): SearchEntry {
  const tokens = [...new Set(e.tokens)].slice(0, MAX_TOKENS);
  return { ...e, tokens, text_hash: hash(e.text) };
}

function patientEntry(r: LocalRecord<PatientData>): SearchEntry {
  const d = r.data!;
  const tokens = [
    ...words(d.name),
    ...words(d.village),
    ...words(d.health_id),
    ...(d.phone ? [d.phone.replace(/\D/g, "")] : []),
    ...(d.health_id ? [normalize(d.health_id).replace(/[^\p{L}\p{N}]/gu, "")] : []),
    ...d.chronic_conditions.flatMap((c) => [...words(c), `dx:${slug(c)}`]),
    ...d.known_allergies.flatMap((a) => [...words(a.substance), `all:${slug(a.substance)}`]),
    `type:patient`,
  ];
  const text = [d.name, d.chronic_conditions.join(", "), d.known_allergies.map((a) => `allergic to ${a.substance}`).join(", ")]
    .filter(Boolean)
    .join(". ");
  return finish({ entity_id: r.id, entity: "patient", patient_id: r.id, date: null, tokens, text });
}

function consultationEntry(r: LocalRecord<ConsultationData>): SearchEntry {
  const d = r.data!;
  const free = [d.chief_complaint, d.notes, d.raw_transcript, d.raw_ocr_text, ...d.sources.map((s) => s.excerpt)].join("\n");
  const mentioned = lexiconTags(free);
  const symptoms = new Set([...d.symptoms.map((s) => s.name), ...mentioned.symptoms]);
  const medicines = new Set([...d.medications.map((m) => m.name), ...mentioned.medicines]);
  const tokens = [
    ...[...symptoms].flatMap((s) => [`sym:${slug(s)}`, ...words(s)]),
    ...[...medicines].flatMap((m) => [`med:${slug(m)}`, ...words(m)]),
    ...d.diagnosis.flatMap((x) => [`dx:${slug(x.replace(/\s*\(suspected\)$/, ""))}`, ...words(x)]),
    ...d.allergies.flatMap((a) => [`all:${slug(a.substance)}`, ...words(a.substance)]),
    ...(d.lab_results ?? []).flatMap((l) => [`lab:${slug(l.name)}`, ...words(l.name)]),
    `date:${d.visit_date}`,
    `date:${d.visit_date.slice(0, 7)}`,
    `review:${d.review.status}`,
    `type:consultation`,
    ...words(free),
  ];
  // English, canonical summary: what the embedding model sees.
  const text = [
    d.chief_complaint,
    symptoms.size ? `Symptoms: ${[...symptoms].join(", ")}` : null,
    d.diagnosis.length ? `Diagnosis: ${d.diagnosis.join(", ")}` : null,
    medicines.size ? `Medicines: ${[...medicines].join(", ")}` : null,
    d.allergies.length ? `Allergies: ${d.allergies.map((a) => a.substance).join(", ")}` : null,
    d.lab_results?.length ? `Labs: ${d.lab_results.map((l) => `${l.name} ${l.value}${l.unit ? " " + l.unit : ""}`).join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(". ");
  return finish({ entity_id: r.id, entity: "consultation", patient_id: d.patient_id, date: d.visit_date, tokens, text });
}

function documentEntry(r: LocalRecord<DocumentData>): SearchEntry {
  const d = r.data!;
  const mentioned = lexiconTags(d.ocr_text ?? "");
  const date = d.captured_at?.slice(0, 10) ?? null;
  const tokens = [
    ...words(d.ocr_text),
    ...mentioned.medicines.map((m) => `med:${slug(m)}`),
    `doc:${d.kind}`,
    ...words(d.kind.replace(/_/g, " ")),
    ...(date ? [`date:${date}`, `date:${date.slice(0, 7)}`] : []),
    `type:document`,
  ];
  const text = `${d.kind.replace(/_/g, " ")}. ${(d.ocr_text ?? "").slice(0, 300)}`;
  return finish({ entity_id: r.id, entity: "document", patient_id: d.patient_id, date, tokens, text });
}

export function entryFor(r: LocalRecord | undefined): SearchEntry | null {
  if (!r || r.deleted || !r.data) return null;
  switch (r.entity) {
    case "patient":
      return patientEntry(r as LocalRecord<PatientData>);
    case "consultation":
      return consultationEntry(r as LocalRecord<ConsultationData>);
    case "document":
      return documentEntry(r as LocalRecord<DocumentData>);
  }
}

// ------------------------------------------------------------------ maintenance

export class SearchIndexer {
  private queue = new Map<string, EntityName>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private listeners = new Set<() => void>();

  constructor(private db: HCareDB) {}

  /** Re-index records touched by any write, whatever code path made it. */
  attach(): void {
    for (const entity of ["patient", "consultation", "document"] as EntityName[]) {
      const table = this.db.records(entity);
      table.hook("creating", (key) => this.enqueue(entity, String(key)));
      table.hook("updating", (_mods, key) => this.enqueue(entity, String(key)));
      table.hook("deleting", (key) => this.enqueue(entity, String(key)));
    }
  }

  onIndexed(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private enqueue(entity: EntityName, id: string) {
    this.queue.set(id, entity);
    // Runs after the writing transaction; it re-reads the record, so an aborted write is harmless.
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 50);
  }

  private async flush(): Promise<void> {
    if (this.flushing) await this.flushing;
    if (this.queue.size === 0) return;
    const batch = [...this.queue];
    this.queue.clear();
    this.flushing = this.db
      .transaction("rw", [this.db.patients, this.db.consultations, this.db.documents, this.db.search_index], async () => {
        for (const [id, entity] of batch) {
          const plain = entryFor(await this.db.records(entity).get(id));
          const entry = plain && sealEntry(plain, this.db.vault);
          if (entry) {
            const old = await this.db.search_index.get(id);
            // Keep an existing embedding while its source text is unchanged.
            if (old?.embedding && old.embedded_hash === entry.text_hash) {
              entry.embedding = old.embedding;
              entry.embedded_hash = old.embedded_hash;
            }
            await this.db.search_index.put(entry);
          } else {
            await this.db.search_index.delete(id);
          }
        }
      })
      .finally(() => {
        this.flushing = null;
      });
    await this.flushing;
    for (const fn of this.listeners) fn();
  }

  /** Resolves once every queued change is in the index (used by tests and before searching). */
  async idle(): Promise<void> {
    while (this.timer || this.flushing || this.queue.size) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      await this.flush();
    }
  }

  /** Full rebuild when the tokenizer changed or the index is missing/out of date. */
  async ensureFresh(): Promise<void> {
    const version = await this.db.getMeta<number>("search_index_version");
    const counts = await Promise.all([this.db.patients.count(), this.db.consultations.count(), this.db.documents.count()]);
    if (version === INDEX_VERSION && (await this.db.search_index.count()) > 0 === counts.some((c) => c > 0)) return;
    await this.rebuild();
  }

  async rebuild(): Promise<void> {
    await this.db.transaction("rw", [this.db.patients, this.db.consultations, this.db.documents, this.db.search_index, this.db.meta], async () => {
      await this.db.search_index.clear();
      for (const entity of ["patient", "consultation", "document"] as EntityName[]) {
        const entries = (await this.db.records(entity).toArray())
          .map(entryFor)
          .filter((e): e is SearchEntry => !!e)
          .map((e) => sealEntry(e, this.db.vault));
        await this.db.search_index.bulkPut(entries);
      }
      await this.db.setMeta("search_index_version", INDEX_VERSION);
    });
    for (const fn of this.listeners) fn();
  }
}
