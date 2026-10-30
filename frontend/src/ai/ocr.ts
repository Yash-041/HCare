/**
 * Document OCR: preprocessing (worker) + Tesseract (its own worker). Tesseract caches
 * language data in IndexedDB and its engine files are cached by our service worker, so
 * after one online run OCR works offline.
 */
import { createWorker, OEM, type Worker as TesseractWorker } from "tesseract.js";
import type { PreprocessRequest, PreprocessResponse } from "./preprocess.worker";

/** Tesseract word confidence (0-100) below which a word is flagged for manual review. */
export const LOW_CONFIDENCE = 65;

export interface OcrWord {
  text: string;
  confidence: number; // 0..1
  start: number; // offsets into OcrResult.text
  end: number;
}

export interface OcrResult {
  text: string;
  confidence: number; // 0..1, mean over words
  words: OcrWord[];
  lowConfidenceSpans: { start: number; end: number; confidence: number }[];
}

export interface PreprocessedImage {
  original: Blob;
  processed: Blob;
  skewDeg: number;
}

// ------------------------------------------------------------------ preprocessing

let preWorker: Worker | null = null;
let preId = 1;
const prePending = new Map<number, (r: PreprocessResponse) => void>();

export function preprocessImage(blob: Blob, maxSide = 2000): Promise<PreprocessedImage> {
  if (!preWorker) {
    preWorker = new Worker(new URL("./preprocess.worker.ts", import.meta.url), { type: "module" });
    preWorker.onmessage = (e: MessageEvent<PreprocessResponse>) => {
      prePending.get(e.data.id)?.(e.data);
      prePending.delete(e.data.id);
    };
  }
  const id = preId++;
  return new Promise((resolve, reject) => {
    prePending.set(id, (r) =>
      r.ok ? resolve({ original: r.original, processed: r.processed, skewDeg: r.skewDeg }) : reject(new Error(r.message)),
    );
    preWorker!.postMessage({ id, blob, maxSide } satisfies PreprocessRequest);
  });
}

// ------------------------------------------------------------------ tesseract

let tess: { langs: string; worker: Promise<TesseractWorker> } | null = null;
let progressListener: ((fraction: number) => void) | null = null;

function getTesseract(langs: string): Promise<TesseractWorker> {
  if (tess?.langs !== langs) {
    const previous = tess;
    const worker = createWorker(langs.split("+"), OEM.LSTM_ONLY, {
      logger: (m) => {
        if (m.status === "recognizing text") progressListener?.(m.progress);
      },
    });
    worker.catch(() => {
      if (tess?.worker === worker) tess = null;
    });
    tess = { langs, worker };
    void previous?.worker.then((w) => w.terminate()).catch(() => undefined);
  }
  return tess.worker;
}

/** Download/load language data now (while online) so OCR works offline later. */
export async function loadOcrLanguages(langs: string): Promise<void> {
  await getTesseract(langs);
}

export async function recognize(image: Blob, langs: string, onProgress?: (f: number) => void): Promise<OcrResult> {
  const worker = await getTesseract(langs);
  progressListener = onProgress ?? null;
  try {
    const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
    return toResult(data.text, (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words))));
  } finally {
    progressListener = null;
  }
}

/** Map Tesseract words back onto character offsets of the page text. */
export function toResult(text: string, words: { text: string; confidence: number }[]): OcrResult {
  const out: OcrWord[] = [];
  let cursor = 0;
  for (const w of words) {
    if (!w.text.trim()) continue;
    const start = text.indexOf(w.text, cursor);
    if (start < 0) continue;
    cursor = start + w.text.length;
    out.push({ text: w.text, confidence: w.confidence / 100, start, end: cursor });
  }
  const confidence = out.length ? out.reduce((s, w) => s + w.confidence, 0) / out.length : 0;
  return {
    text,
    confidence,
    words: out,
    lowConfidenceSpans: out
      .filter((w) => w.confidence * 100 < LOW_CONFIDENCE)
      .map(({ start, end, confidence }) => ({ start, end, confidence })),
  };
}
