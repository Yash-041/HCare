/**
 * Capture drafts: voice notes and document photos collected during a visit.
 *
 * Everything stays on the device (IndexedDB) until the clinician saves, and survives
 * reloads/crashes: blobs are written before processing starts, and processing resumes
 * from the queue. Item id = blob id = later SourceRef/document id, so provenance links
 * from the case file back to the original audio/photo never break.
 */
import { getBlob, putBlobs, sealBlob } from "./crypto/blobs";
import type { HCareDB } from "./db";
import { newId, nowIso } from "./ids";
import { saveRecord, type Actor } from "./repo";
import type {
  AudioCaptureItem,
  CaptureDraft,
  CaptureItem,
  ConsultationData,
  DocumentData,
  ImageCaptureItem,
  SourceRef,
} from "./types";

export interface CaptureAI {
  decodeAudio(blob: Blob): Promise<{ samples: Float32Array; durationS: number }>;
  /** Load (first time: download) the speech model; progress is download progress. */
  loadSpeech(model: string, onProgress?: (f: number) => void): Promise<void>;
  transcribe(
    samples: Float32Array,
    opts: { model: string; language: string | null; task: "transcribe" | "translate"; onProgress?: (f: number) => void },
  ): Promise<{ text: string }>;
  preprocess(blob: Blob): Promise<{ original: Blob; processed: Blob; skewDeg: number }>;
  ocr(
    image: Blob,
    langs: string,
    onProgress?: (f: number) => void,
  ): Promise<{ text: string; confidence: number; lowConfidenceSpans: { start: number; end: number; confidence: number }[] }>;
}

const MAX_RAW_TEXT = 50_000;

export async function openDraft(db: HCareDB, patientId: string, language: string): Promise<CaptureDraft> {
  return db.transaction("rw", db.capture_drafts, async () => {
    const existing = await db.capture_drafts.get(patientId);
    if (existing) return existing;
    const draft: CaptureDraft = { id: patientId, patient_id: patientId, language, created_at: nowIso(), updated_at: nowIso() };
    await db.capture_drafts.add(draft);
    return draft;
  });
}

export async function addAudio(
  db: HCareDB,
  draftId: string,
  blob: Blob,
  opts: { durationS: number | null; language: string | null; model: string; translate: boolean },
): Promise<string> {
  const id = newId();
  // Encrypt first: WebCrypto is async and must not run inside the transaction.
  const sealed = await sealBlob(db, id, blob, blob.type || "audio/webm");
  await db.transaction("rw", db.blobs, db.capture_items, async () => {
    await db.blobs.put(sealed);
    await db.capture_items.add({
      id,
      draft_id: draftId,
      blob_id: id,
      kind: "audio",
      mime_type: blob.type || "audio/webm",
      created_at: nowIso(),
      status: "queued",
      duration_s: opts.durationS,
      language: opts.language,
      model: opts.model,
      transcript: null,
      edited_text: null,
      translate: opts.translate,
      translation: null,
    } satisfies AudioCaptureItem);
  });
  return id;
}

export async function addImage(
  db: HCareDB,
  draftId: string,
  blob: Blob,
  opts: { docKind: DocumentData["kind"]; ocrLangs: string },
): Promise<string> {
  const id = newId();
  const sealed = await sealBlob(db, id, blob, blob.type || "image/jpeg");
  await db.transaction("rw", db.blobs, db.capture_items, async () => {
    await db.blobs.put(sealed);
    await db.capture_items.add({
      id,
      draft_id: draftId,
      blob_id: id,
      kind: "image",
      mime_type: blob.type || "image/jpeg",
      created_at: nowIso(),
      status: "queued",
      doc_kind: opts.docKind,
      ocr_langs: opts.ocrLangs,
      processed_blob_id: null,
      skew_deg: null,
      ocr_text: null,
      edited_text: null,
      confidence: null,
      low_confidence_spans: [],
      sha256: null,
    } satisfies ImageCaptureItem);
  });
  return id;
}

export async function updateItem(db: HCareDB, id: string, changes: Partial<CaptureItem>): Promise<void> {
  await db.capture_items.update(id, changes as never);
}

export async function retryItem(db: HCareDB, id: string): Promise<void> {
  await db.capture_items.update(id, { status: "queued", error: null, progress: null, stage: null });
}

export async function removeItem(db: HCareDB, id: string): Promise<void> {
  await db.transaction("rw", db.blobs, db.capture_items, async () => {
    const item = await db.capture_items.get(id);
    if (!item) return;
    await db.blobs.bulkDelete([item.blob_id, ...(item.kind === "image" && item.processed_blob_id ? [item.processed_blob_id] : [])]);
    await db.capture_items.delete(id);
  });
}

export async function discardDraft(db: HCareDB, draftId: string): Promise<void> {
  const items = await db.capture_items.where("draft_id").equals(draftId).toArray();
  for (const item of items) await removeItem(db, item.id);
  await db.capture_drafts.delete(draftId);
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------ background processing

/** Processes queued items one at a time (AI models are memory-hungry on low-end phones). */
export class CaptureRunner {
  private running = false;
  private recovered = false;

  constructor(
    private db: HCareDB,
    private ai: CaptureAI,
  ) {}

  kick(): Promise<void> {
    return this.running ? Promise.resolve() : this.run();
  }

  private async run() {
    this.running = true;
    try {
      if (!this.recovered) {
        // Items left "processing" by a reload or crash restart from scratch.
        await this.db.capture_items.where("status").equals("processing").modify({ status: "queued", progress: null });
        this.recovered = true;
      }
      for (;;) {
        const next = (await this.db.capture_items.where("status").equals("queued").sortBy("created_at"))[0];
        if (!next) return;
        await this.process(next);
      }
    } finally {
      this.running = false;
    }
  }

  private async process(item: CaptureItem) {
    const update = (changes: Partial<CaptureItem>) => updateItem(this.db, item.id, changes);
    let lastReported = -1;
    const onProgress = (f: number) => {
      const pct = Math.round(f * 100);
      if (pct >= lastReported + 5 || pct === 100) {
        lastReported = pct;
        void update({ progress: f });
      }
    };
    try {
      await update({ status: "processing", progress: null, error: null });
      const stored = await getBlob(this.db, item.blob_id);
      if (!stored) throw new Error("recording or photo is missing from this device");
      if (item.kind === "audio") await this.processAudio(item, stored, update, onProgress);
      else await this.processImage(item, stored, update, onProgress);
    } catch (e) {
      await update({ status: "error", stage: null, progress: null, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async processAudio(
    item: AudioCaptureItem,
    blob: Blob,
    update: (c: Partial<AudioCaptureItem>) => Promise<void>,
    onProgress: (f: number) => void,
  ) {
    await update({ stage: "Preparing audio" });
    const { samples, durationS } = await this.ai.decodeAudio(blob);
    if (durationS < 0.5) throw new Error("recording is too short");

    await update({ stage: "Loading speech model", duration_s: durationS });
    await this.ai.loadSpeech(item.model, onProgress);

    await update({ stage: "Transcribing", progress: null });
    const opts = { model: item.model, language: item.language };
    const first = await this.ai.transcribe(samples, { ...opts, task: "transcribe" });
    let translation: string | null = null;
    if (item.translate && item.language !== "en") {
      await update({ stage: "Translating to English", transcript: first.text });
      translation = (await this.ai.transcribe(samples, { ...opts, task: "translate" })).text;
    }
    const current = await this.db.capture_items.get(item.id);
    await update({
      status: "done",
      stage: null,
      progress: null,
      transcript: first.text,
      translation,
      // Never clobber text the clinician already started correcting.
      edited_text: current?.edited_text ?? first.text,
    });
  }

  private async processImage(
    item: ImageCaptureItem,
    blob: Blob,
    update: (c: Partial<ImageCaptureItem>) => Promise<void>,
    onProgress: (f: number) => void,
  ) {
    await update({ stage: "Cleaning up image" });
    const pre = await this.ai.preprocess(blob);
    const processedId = `${item.id}:processed`;
    const sha256 = await sha256Hex(pre.original);
    await putBlobs(this.db, [
      // Replace the raw camera file with the compressed copy to save storage.
      { id: item.blob_id, blob: pre.original, mime_type: "image/jpeg" },
      { id: processedId, blob: pre.processed, mime_type: "image/png" },
    ]);
    await update({ stage: "Reading text", mime_type: "image/jpeg", processed_blob_id: processedId, skew_deg: pre.skewDeg, sha256 });

    const result = await this.ai.ocr(pre.processed, item.ocr_langs, onProgress);
    const current = await this.db.capture_items.get(item.id);
    await update({
      status: "done",
      stage: null,
      progress: null,
      ocr_text: result.text,
      confidence: result.confidence,
      low_confidence_spans: result.lowConfidenceSpans,
      edited_text: current?.edited_text ?? result.text,
    });
  }
}

// ------------------------------------------------------------------ save

export class DraftNotReadyError extends Error {
  name = "DraftNotReadyError";
}

function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Turns a capture draft into a *draft* consultation (review.status = "draft") plus one
 * document record per photo. Raw text and source references are kept so every later
 * AI-extracted field can be traced back to the recording or photo it came from.
 */
export async function saveDraftAsConsultation(db: HCareDB, actor: Actor, draftId: string): Promise<string> {
  const draft = await db.capture_drafts.get(draftId);
  if (!draft) throw new Error("capture draft not found");
  const all = await db.capture_items.where("draft_id").equals(draftId).sortBy("created_at");
  const failed = all.filter((i) => i.status === "error");
  const items = all.filter((i) => i.status !== "error");
  if (items.some((i) => i.status !== "done")) throw new DraftNotReadyError("Wait until all recordings and photos are processed.");
  if (items.length === 0) throw new DraftNotReadyError("Add at least one voice note or document.");

  const audio = items.filter((i): i is AudioCaptureItem => i.kind === "audio");
  const images = items.filter((i): i is ImageCaptureItem => i.kind === "image");
  const consultationId = newId();

  const sources: SourceRef[] = [
    ...audio.map((a) => ({
      id: a.id,
      kind: "audio" as const,
      language: a.language,
      // Keep the machine translation alongside: extraction reads both languages.
      excerpt: truncate(
        (a.edited_text ?? "") + (a.translation ? `\n[English translation] ${a.translation}` : ""),
        4000,
      ),
    })),
    ...images.map((img) => ({
      id: img.id,
      kind: "image" as const,
      document_id: img.id,
      language: img.ocr_langs.slice(0, 16),
      excerpt: truncate(img.edited_text ?? "", 4000),
    })),
  ];

  const rawTranscript = audio
    .map((a, i) => {
      const parts = [`[Voice note ${i + 1}${a.language ? ` · ${a.language}` : ""}]`, a.edited_text ?? ""];
      if (a.translation) parts.push(`[English translation]`, a.translation);
      return parts.join("\n");
    })
    .join("\n\n");
  const rawOcr = images.map((img, i) => `[Document ${i + 1} · ${img.doc_kind}]\n${img.edited_text ?? ""}`).join("\n\n");

  const consultation: ConsultationData = {
    patient_id: draft.patient_id,
    visit_date: localDate(),
    language: draft.language,
    chief_complaint: null,
    symptoms: [],
    vitals: {},
    diagnosis: [],
    medications: [],
    allergies: [],
    follow_up: null,
    notes: null,
    raw_transcript: rawTranscript ? truncate(rawTranscript, MAX_RAW_TEXT) : null,
    raw_ocr_text: rawOcr ? truncate(rawOcr, MAX_RAW_TEXT) : null,
    sources,
    field_meta: {},
    review: { status: "draft" },
  };

  await db.transaction(
    "rw",
    [db.consultations, db.documents, db.outbox, db.capture_drafts, db.capture_items, db.blobs],
    async () => {
      // Consultation first so the outbox sends it before the documents that reference it.
      await saveRecord(db, actor, "consultation", consultationId, consultation);
      for (const img of images) {
        const edited = img.edited_text !== img.ocr_text;
        await saveRecord(db, actor, "document", img.id, {
          patient_id: draft.patient_id,
          consultation_id: consultationId,
          kind: img.doc_kind,
          mime_type: "image/jpeg",
          captured_at: img.created_at,
          ocr_text: img.edited_text ? truncate(img.edited_text, MAX_RAW_TEXT) : null,
          ocr_confidence: img.confidence,
          ocr_language: img.ocr_langs.slice(0, 16),
          // Offsets only make sense for the untouched OCR text.
          low_confidence_spans: edited ? [] : img.low_confidence_spans,
          blob_sha256: img.sha256,
        });
        if (img.processed_blob_id) await db.blobs.delete(img.processed_blob_id);
      }
      // Failed items are left out of the record; don't keep their media either.
      await db.blobs.bulkDelete(
        failed.flatMap((i) => [i.blob_id, ...(i.kind === "image" && i.processed_blob_id ? [i.processed_blob_id] : [])]),
      );
      await db.capture_items.where("draft_id").equals(draftId).delete();
      await db.capture_drafts.delete(draftId);
    },
  );
  return consultationId;
}
