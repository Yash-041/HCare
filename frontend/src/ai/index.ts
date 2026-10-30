import { CaptureRunner, type CaptureAI } from "../lib/capture";
import type { HCareDB } from "../lib/db";
import type { ConsultationData } from "../lib/types";
import { decodeTo16kMono } from "./audio";
import { structureConsultation } from "./extract/structure";
import { generate, loadLlm } from "./llm";
import { LLM_MODEL } from "./models";
import { loadOcrLanguages, preprocessImage, recognize } from "./ocr";
import { loadSpeechModel, transcribe } from "./whisper";

let runner: CaptureRunner | null = null;

export function captureRunner(db: HCareDB): CaptureRunner {
  const ai: CaptureAI = {
    decodeAudio: decodeTo16kMono,
    loadSpeech: (model, onProgress) => downloadSpeechModel(db, model, onProgress),
    transcribe,
    preprocess: (blob) => preprocessImage(blob),
    ocr: async (image, langs, onProgress) => {
      const result = await recognize(image, langs, onProgress);
      await markReady(db, "ocr", langs);
      return result;
    },
  };
  runner ??= new CaptureRunner(db, ai);
  return runner;
}

// ------------------------------------------------------------------ offline readiness

const READY_KEY = "ai_ready";
const SPEECH_MODEL_KEY = "speech_model";

export interface AiReadiness {
  speech: string[]; // model ids downloaded on this device
  ocr: string[]; // tesseract language strings downloaded on this device
  llm: string[]; // LLM ids downloaded on this device
}

export async function aiReadiness(db: HCareDB): Promise<AiReadiness> {
  return { speech: [], ocr: [], llm: [], ...(await db.getMeta<Partial<AiReadiness>>(READY_KEY)) };
}

async function markReady(db: HCareDB, kind: keyof AiReadiness, value: string) {
  const r = await aiReadiness(db);
  if (!r[kind].includes(value)) await db.setMeta(READY_KEY, { ...r, [kind]: [...r[kind], value] });
}

export async function selectedSpeechModel(db: HCareDB, fallback: string): Promise<string> {
  return (await db.getMeta<string>(SPEECH_MODEL_KEY)) ?? fallback;
}

export async function setSpeechModel(db: HCareDB, model: string): Promise<void> {
  await db.setMeta(SPEECH_MODEL_KEY, model);
}

/** Fetch models while online so capture works later without a connection. */
export async function downloadSpeechModel(db: HCareDB, model: string, onProgress?: (f: number) => void) {
  await loadSpeechModel(model, onProgress);
  await markReady(db, "speech", model);
}

export async function downloadOcrLanguages(db: HCareDB, langs: string) {
  await loadOcrLanguages(langs);
  await markReady(db, "ocr", langs);
}

export async function downloadLlm(db: HCareDB, onProgress?: (f: number) => void) {
  await loadLlm(onProgress);
  await markReady(db, "llm", LLM_MODEL.id);
}

/** Structure a consultation's notes into a draft case file (rules, optionally + on-device LLM). */
export async function structure(
  db: HCareDB,
  consultation: ConsultationData,
  useLlm: boolean,
  onTokens?: (count: number) => void,
) {
  const documents = await db.documents.where("patient_id").equals(consultation.patient_id).toArray();
  return structureConsultation(consultation, documents, {
    generate: useLlm
      ? async (messages, prefill) => {
          const text = await generate(messages, prefill, { onTokens });
          await markReady(db, "llm", LLM_MODEL.id);
          return text;
        }
      : undefined,
  });
}
