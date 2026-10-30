import { deviceProfile } from "./device";
import type { WhisperRequest, WhisperResponse } from "./whisper.worker";

export interface TranscribeOptions {
  model: string;
  language: string | null;
  task: "transcribe" | "translate";
  /** Model download progress (only reported if the model isn't cached yet). */
  onProgress?: (fraction: number) => void;
}

export interface Transcript {
  text: string;
  chunks: { text: string; timestamp: [number, number | null] }[];
}

type Pending = {
  resolve: (r: WhisperResponse) => void;
  reject: (e: Error) => void;
  onProgress?: (fraction: number) => void;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<WhisperResponse>) => {
      const msg = e.data;
      const p = pending.get(msg.id);
      if (!p) return;
      if (msg.type === "progress") {
        p.onProgress?.(msg.progress / 100);
        return;
      }
      pending.delete(msg.id);
      if (msg.type === "error") p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || "speech worker crashed"));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

// Omit applied per union member (plain Omit<Union, K> collapses to the shared fields).
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

function call(req: WithoutId<WhisperRequest>,onProgress?: (f: number) => void, transfer: Transferable[] = []) {
  const id = nextId++;
  return new Promise<WhisperResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ ...req, id } as WhisperRequest, transfer);
  });
}

// Some WebGPU drivers advertise support but fail on real models; fall back once and stick to WASM.
let webgpuBroken = false;

async function device(): Promise<"webgpu" | "wasm"> {
  return !webgpuBroken && (await deviceProfile()).webgpu ? "webgpu" : "wasm";
}

async function withFallback(run: (d: "webgpu" | "wasm") => Promise<WhisperResponse>): Promise<WhisperResponse> {
  const d = await device();
  try {
    return await run(d);
  } catch (e) {
    if (d !== "webgpu") throw e;
    webgpuBroken = true;
    return run("wasm");
  }
}

/** Downloads (or loads from cache) the model so later transcription works offline. */
export async function loadSpeechModel(model: string, onProgress?: (fraction: number) => void): Promise<void> {
  await withFallback((d) => call({ type: "load", model, device: d }, onProgress));
}

/** `audio` is copied before transfer, so the caller can reuse it (e.g. for a translation pass). */
export async function transcribe(audio: Float32Array, opts: TranscribeOptions): Promise<Transcript> {
  const res = await withFallback((d) => {
    const copy = audio.slice();
    return call(
      { type: "transcribe", model: opts.model, device: d, audio: copy, language: opts.language, task: opts.task },
      opts.onProgress,
      [copy.buffer],
    );
  });
  if (res.type !== "result") throw new Error("unexpected response from speech worker");
  return { text: res.text, chunks: res.chunks };
}
