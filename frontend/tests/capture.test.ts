import { describe, expect, it } from "vitest";
import {
  addAudio,
  addImage,
  CaptureRunner,
  discardDraft,
  DraftNotReadyError,
  openDraft,
  saveDraftAsConsultation,
  updateItem,
  type CaptureAI,
} from "../src/lib/capture";
import { HCareDB } from "../src/lib/db";
import { newId } from "../src/lib/ids";
import { saveRecord } from "../src/lib/repo";
import type { AudioCaptureItem, ImageCaptureItem } from "../src/lib/types";

const actor = { userId: "user-1", deviceId: "dev-1" };

/** Deterministic stand-in for Whisper/Tesseract; the real models are exercised in the browser tests. */
function fakeAI(overrides: Partial<CaptureAI> = {}): CaptureAI & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    decodeAudio: async () => ({ samples: new Float32Array(16_000 * 3), durationS: 3 }),
    loadSpeech: async (model) => {
      calls.push(`load:${model}`);
    },
    transcribe: async (_s, opts) => {
      calls.push(`${opts.task}:${opts.language}`);
      return { text: opts.task === "translate" ? "Fever for three days" : "तीन दिन से बुखार है" };
    },
    preprocess: async (blob) => ({ original: blob, processed: new Blob(["png"]), skewDeg: 2.5 }),
    ocr: async () => ({
      text: "Hb 9.8 g/dL",
      confidence: 0.71,
      lowConfidenceSpans: [{ start: 3, end: 6, confidence: 0.4 }],
    }),
    ...overrides,
  };
}

async function setup() {
  const db = new HCareDB(`capture-${newId()}`);
  const patientId = await saveRecord(db, actor, "patient", null, {
    name: "Meena",
    sex: "female",
    known_allergies: [],
    chronic_conditions: [],
  });
  const draft = await openDraft(db, patientId, "hi");
  return { db, patientId, draft };
}

describe("capture drafts", () => {
  it("transcribes (and translates) voice notes and OCRs photos in the background", async () => {
    const { db, draft } = await setup();
    const ai = fakeAI();
    const audioId = await addAudio(db, draft.id, new Blob(["a"], { type: "audio/webm" }), {
      durationS: null,
      language: "hi",
      model: "whisper-base",
      translate: true,
    });
    const imageId = await addImage(db, draft.id, new Blob(["i"], { type: "image/jpeg" }), {
      docKind: "lab_report",
      ocrLangs: "eng+hin",
    });

    await new CaptureRunner(db, ai).kick();

    const audio = (await db.capture_items.get(audioId)) as AudioCaptureItem;
    expect(audio).toMatchObject({
      status: "done",
      transcript: "तीन दिन से बुखार है",
      edited_text: "तीन दिन से बुखार है",
      translation: "Fever for three days",
      duration_s: 3,
    });
    expect(ai.calls).toEqual(["load:whisper-base", "transcribe:hi", "translate:hi"]);

    const image = (await db.capture_items.get(imageId)) as ImageCaptureItem;
    expect(image).toMatchObject({ status: "done", ocr_text: "Hb 9.8 g/dL", skew_deg: 2.5, confidence: 0.71 });
    expect(image.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await db.blobs.get(`${imageId}:processed`)).toBeDefined();
  });

  it("records failures per item and lets the user retry", async () => {
    const { db, draft } = await setup();
    const id = await addAudio(db, draft.id, new Blob(["a"]), { durationS: 1, language: "en", model: "m", translate: false });
    await new CaptureRunner(db, fakeAI({ loadSpeech: async () => Promise.reject(new Error("download interrupted")) })).kick();
    expect(await db.capture_items.get(id)).toMatchObject({ status: "error", error: "download interrupted" });
  });

  it("items interrupted mid-processing (reload/crash) are picked up again", async () => {
    const { db, draft } = await setup();
    const id = await addAudio(db, draft.id, new Blob(["a"]), { durationS: 1, language: "en", model: "m", translate: false });
    await updateItem(db, id, { status: "processing" });
    await new CaptureRunner(db, fakeAI()).kick();
    expect((await db.capture_items.get(id))?.status).toBe("done");
  });

  it("does not overwrite corrections the clinician typed while processing", async () => {
    const { db, draft } = await setup();
    const id = await addAudio(db, draft.id, new Blob(["a"]), { durationS: 1, language: "en", model: "m", translate: false });
    const ai = fakeAI({
      transcribe: async () => {
        await updateItem(db, id, { edited_text: "typed by clinician" });
        return { text: "machine text" };
      },
    });
    await new CaptureRunner(db, ai).kick();
    expect(await db.capture_items.get(id)).toMatchObject({ transcript: "machine text", edited_text: "typed by clinician" });
  });

  it("refuses to save while items are still processing", async () => {
    const { db, draft } = await setup();
    await addAudio(db, draft.id, new Blob(["a"]), { durationS: 1, language: "en", model: "m", translate: false });
    await expect(saveDraftAsConsultation(db, actor, draft.id)).rejects.toBeInstanceOf(DraftNotReadyError);
  });

  it("saves a draft consultation + documents with provenance, queued for sync in order", async () => {
    const { db, draft, patientId } = await setup();
    const audioId = await addAudio(db, draft.id, new Blob(["a"]), { durationS: 3, language: "hi", model: "m", translate: true });
    const imageId = await addImage(db, draft.id, new Blob(["i"]), { docKind: "lab_report", ocrLangs: "eng+hin" });
    await new CaptureRunner(db, fakeAI()).kick();
    await updateItem(db, audioId, { edited_text: "तीन दिन से तेज़ बुखार है" }); // clinician correction

    const cid = await saveDraftAsConsultation(db, actor, draft.id);

    const consultation = (await db.consultations.get(cid))!;
    expect(consultation.patient_id).toBe(patientId);
    expect(consultation.data).toMatchObject({
      patient_id: patientId,
      language: "hi",
      review: { status: "draft" },
    });
    expect(consultation.data!.raw_transcript).toContain("तीन दिन से तेज़ बुखार है");
    expect(consultation.data!.raw_transcript).toContain("Fever for three days");
    expect(consultation.data!.raw_ocr_text).toContain("Hb 9.8 g/dL");
    expect(consultation.data!.sources).toEqual([
      expect.objectContaining({ id: audioId, kind: "audio", language: "hi" }),
      expect.objectContaining({ id: imageId, kind: "image", document_id: imageId }),
    ]);

    const doc = (await db.documents.get(imageId))!;
    expect(doc.data).toMatchObject({ consultation_id: cid, kind: "lab_report", ocr_confidence: 0.71 });
    expect(doc.data!.low_confidence_spans).toHaveLength(1);

    // Patient (from setup), then consultation, then its documents.
    const outbox = await db.outbox.orderBy("seq").toArray();
    expect(outbox.map((o) => o.entity)).toEqual(["patient", "consultation", "document"]);

    // Draft is gone; the photo and recording stay on the device for verification.
    expect(await db.capture_drafts.get(draft.id)).toBeUndefined();
    expect(await db.capture_items.count()).toBe(0);
    expect(await db.blobs.get(audioId)).toBeDefined();
    expect(await db.blobs.get(imageId)).toBeDefined();
    expect(await db.blobs.get(`${imageId}:processed`)).toBeUndefined();
  });

  it("drops uncertainty offsets once the OCR text was edited (they would point at the wrong words)", async () => {
    const { db, draft } = await setup();
    const imageId = await addImage(db, draft.id, new Blob(["i"]), { docKind: "prescription", ocrLangs: "eng" });
    await new CaptureRunner(db, fakeAI()).kick();
    await updateItem(db, imageId, { edited_text: "Hb 9.6 g/dL" });
    await saveDraftAsConsultation(db, actor, draft.id);
    expect((await db.documents.get(imageId))!.data!.low_confidence_spans).toEqual([]);
  });

  it("discarding a draft removes its recordings and photos", async () => {
    const { db, draft } = await setup();
    await addAudio(db, draft.id, new Blob(["a"]), { durationS: 1, language: "en", model: "m", translate: false });
    await addImage(db, draft.id, new Blob(["i"]), { docKind: "other", ocrLangs: "eng" });
    await discardDraft(db, draft.id);
    expect(await db.capture_items.count()).toBe(0);
    expect(await db.blobs.count()).toBe(0);
    expect(await db.capture_drafts.count()).toBe(0);
  });
});
