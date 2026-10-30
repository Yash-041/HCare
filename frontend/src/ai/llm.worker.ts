/// <reference lib="webworker" />
/** Quantized instruction-tuned LLM running fully on-device (WebGPU or WASM). */
import { env, pipeline, TextStreamer, type ProgressInfo, type TextGenerationPipeline } from "@huggingface/transformers";

env.allowLocalModels = false;
env.useBrowserCache = true;

export type LlmDevice = { device: "webgpu"; dtype: "q4f16" };

export type LlmRequest =
  | { id: number; type: "load"; model: string; runtime: LlmDevice }
  | {
      id: number;
      type: "generate";
      model: string;
      runtime: LlmDevice;
      messages: { role: "system" | "user"; content: string }[];
      /** Text the assistant reply is forced to start with, e.g. "{" for JSON. */
      prefill: string;
      maxNewTokens: number;
    };

export type LlmResponse =
  | { id: number; type: "progress"; progress: number }
  /** Streamed while generating: number of tokens so far (doubles as a heartbeat). */
  | { id: number; type: "tokens"; count: number }
  | { id: number; type: "ready" }
  | { id: number; type: "result"; text: string }
  | { id: number; type: "error"; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let loaded: { key: string; gen: Promise<TextGenerationPipeline> } | null = null;

function getPipeline(model: string, runtime: LlmDevice, id: number) {
  const key = `${model}|${runtime.device}|${runtime.dtype}`;
  if (loaded?.key !== key) {
    const gen = pipeline("text-generation", model, {
      device: runtime.device,
      dtype: runtime.dtype,
      progress_callback: (p: ProgressInfo) => {
        if (p.status === "progress_total") scope.postMessage({ id, type: "progress", progress: p.progress } satisfies LlmResponse);
      },
    }) as Promise<TextGenerationPipeline>;
    gen.catch(() => {
      if (loaded?.gen === gen) loaded = null;
    });
    loaded = { key, gen };
  }
  return loaded.gen;
}

scope.onmessage = async (e: MessageEvent<LlmRequest>) => {
  const msg = e.data;
  try {
    const gen = await getPipeline(msg.model, msg.runtime, msg.id);
    if (msg.type === "load") {
      scope.postMessage({ id: msg.id, type: "ready" } satisfies LlmResponse);
      return;
    }
    // Apply the chat template ourselves so the reply can be prefilled: starting the answer
    // with "{" is what makes a small model reliably emit JSON instead of prose.
    const prompt =
      (gen.tokenizer.apply_chat_template(msg.messages, { tokenize: false, add_generation_prompt: true }) as string) + msg.prefill;
    let count = 0;
    const streamer = new TextStreamer(gen.tokenizer, {
      skip_prompt: true,
      callback_function: () => scope.postMessage({ id: msg.id, type: "tokens", count: ++count } satisfies LlmResponse),
    });
    // Greedy decoding: extraction should be deterministic, not creative.
    const output = (await gen(prompt, {
      max_new_tokens: msg.maxNewTokens,
      do_sample: false,
      return_full_text: false,
      streamer,
    })) as unknown as { generated_text: string }[];
    scope.postMessage({ id: msg.id, type: "result", text: msg.prefill + (output[0]?.generated_text ?? "") } satisfies LlmResponse);
  } catch (err) {
    scope.postMessage({ id: msg.id, type: "error", message: err instanceof Error ? err.message : String(err) } satisfies LlmResponse);
  }
};
