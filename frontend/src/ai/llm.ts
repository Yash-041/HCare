import { deviceProfile } from "./device";
import type { LlmDevice, LlmRequest, LlmResponse } from "./llm.worker";
import { LLM_MODEL } from "./models";

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type ChatMessage = { role: "system" | "user"; content: string };

/** Generation is abandoned if no token arrives for this long (first token includes warm-up). */
const STALL_MS = 90_000;

interface Pending {
  resolve: (r: LlmResponse) => void;
  reject: (e: Error) => void;
  onProgress?: (f: number) => void;
  onTokens?: (count: number) => void;
  watchdog?: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let gpuBroken = false;

function killWorker(reason: string) {
  for (const p of pending.values()) {
    clearTimeout(p.watchdog);
    p.reject(new Error(reason));
  }
  pending.clear();
  worker?.terminate();
  worker = null;
}

function armWatchdog(p: Pending) {
  clearTimeout(p.watchdog);
  // A stuck GPU job can't be cancelled from inside; terminating the worker frees it.
  p.watchdog = setTimeout(() => killWorker("The on-device AI model stopped responding."), STALL_MS);
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./llm.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<LlmResponse>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      if (e.data.type === "progress") return p.onProgress?.(e.data.progress / 100);
      if (e.data.type === "tokens") {
        if (p.watchdog) armWatchdog(p);
        return p.onTokens?.(e.data.count);
      }
      clearTimeout(p.watchdog);
      pending.delete(e.data.id);
      if (e.data.type === "error") p.reject(new Error(e.data.message));
      else p.resolve(e.data);
    };
    worker.onerror = (e) => killWorker(e.message || "AI worker crashed (possibly out of memory)");
  }
  return worker;
}

function call(req: WithoutId<LlmRequest>, hooks: Pick<Pending, "onProgress" | "onTokens"> = {}) {
  const id = nextId++;
  return new Promise<LlmResponse>((resolve, reject) => {
    const p: Pending = { resolve, reject, ...hooks };
    pending.set(id, p);
    getWorker().postMessage({ ...req, id } as LlmRequest);
    if (req.type === "generate") armWatchdog(p);
  });
}

export class LlmUnavailableError extends Error {
  name = "LlmUnavailableError";
}

/**
 * The 1.5B model needs WebGPU with fp16. On CPU-only browsers it does not fit: the WASM
 * runtime is limited to 4 GB and failed with std::bad_alloc while loading it in testing.
 * (Smaller models that do fit produced invented vitals, so we don't fall back to them.)
 */
export async function llmSupported(): Promise<boolean> {
  return !gpuBroken && (await deviceProfile()).webgpuF16;
}

async function runtime(): Promise<LlmDevice> {
  if (!(await llmSupported())) {
    throw new LlmUnavailableError("This device's browser has no GPU support (WebGPU), so the on-device AI model can't run here.");
  }
  return { device: "webgpu", dtype: "q4f16" };
}

async function withFallback(run: (r: LlmDevice) => Promise<LlmResponse>): Promise<LlmResponse> {
  const r = await runtime();
  try {
    return await run(r);
  } catch (e) {
    // Driver advertised WebGPU but failed on the real model: stop offering it this session.
    if (e instanceof Error && /webgpu|gpu|adapter|device lost/i.test(e.message)) gpuBroken = true;
    throw e;
  }
}

export async function loadLlm(onProgress?: (f: number) => void): Promise<void> {
  await withFallback((r) => call({ type: "load", model: LLM_MODEL.id, runtime: r }, { onProgress }));
}

export async function generate(
  messages: ChatMessage[],
  prefill = "",
  opts: { maxNewTokens?: number; onTokens?: (count: number) => void } = {},
): Promise<string> {
  const res = await withFallback((r) =>
    call(
      { type: "generate", model: LLM_MODEL.id, runtime: r, messages, prefill, maxNewTokens: opts.maxNewTokens ?? 300 },
      { onTokens: opts.onTokens },
    ),
  );
  if (res.type !== "result") throw new Error("unexpected response from AI worker");
  return res.text;
}
