/// <reference lib="webworker" />
/**
 * Speech-to-text worker. Keeps the model off the UI thread so the app stays responsive
 * on low-end phones. Model files are cached by transformers.js (Cache Storage), so after
 * the first download transcription works offline.
 */
import { env, pipeline, type AutomaticSpeechRecognitionPipeline, type ProgressInfo } from "@huggingface/transformers";

env.allowLocalModels = false;
env.useBrowserCache = true;

export type WhisperRequest =
  | { id: number; type: "load"; model: string; device: "webgpu" | "wasm" }
  | {
      id: number;
      type: "transcribe";
      model: string;
      device: "webgpu" | "wasm";
      audio: Float32Array;
      language: string | null;
      task: "transcribe" | "translate";
    };

export type WhisperResponse =
  | { id: number; type: "progress"; loaded: number; total: number; progress: number }
  | { id: number; type: "ready" }
  | { id: number; type: "result"; text: string; chunks: { text: string; timestamp: [number, number | null] }[] }
  | { id: number; type: "error"; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let loaded: { key: string; asr: Promise<AutomaticSpeechRecognitionPipeline> } | null = null;

function getPipeline(model: string, device: "webgpu" | "wasm", id: number) {
  const key = `${model}|${device}`;
  if (loaded?.key !== key) {
    const progress_callback = (p: ProgressInfo) => {
      if (p.status === "progress_total") {
        scope.postMessage({ id, type: "progress", loaded: p.loaded, total: p.total, progress: p.progress } satisfies WhisperResponse);
      }
    };
    const asr = pipeline("automatic-speech-recognition", model, {
      device,
      // WebGPU: full-precision encoder for accuracy, 4-bit decoder for speed.
      // WASM (most low-end phones): 8-bit everywhere keeps memory and download small.
      dtype: device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
      progress_callback,
    }) as Promise<AutomaticSpeechRecognitionPipeline>;
    // A failed load must not poison later attempts (e.g. download interrupted by going offline).
    asr.catch(() => {
      if (loaded?.asr === asr) loaded = null;
    });
    loaded = { key, asr };
  }
  return loaded.asr;
}

scope.onmessage = async (e: MessageEvent<WhisperRequest>) => {
  const msg = e.data;
  try {
    const asr = await getPipeline(msg.model, msg.device, msg.id);
    if (msg.type === "load") {
      scope.postMessage({ id: msg.id, type: "ready" } satisfies WhisperResponse);
      return;
    }
    const output = await asr(msg.audio, {
      language: msg.language ?? undefined,
      task: msg.task,
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
    });
    const out = Array.isArray(output) ? output[0] : output;
    scope.postMessage({
      id: msg.id,
      type: "result",
      text: out.text.trim(),
      chunks: (out.chunks ?? []) as { text: string; timestamp: [number, number | null] }[],
    } satisfies WhisperResponse);
  } catch (err) {
    scope.postMessage({ id: msg.id, type: "error", message: err instanceof Error ? err.message : String(err) } satisfies WhisperResponse);
  }
};
