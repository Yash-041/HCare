/// <reference lib="webworker" />
/** Sentence embeddings for semantic search (all-MiniLM-L6-v2, 22 MB, CPU). */
import { env, pipeline, type FeatureExtractionPipeline, type ProgressInfo } from "@huggingface/transformers";

env.allowLocalModels = false;
env.useBrowserCache = true;

export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";

export type EmbedRequest = { id: number; type: "load" } | { id: number; type: "embed"; texts: string[] };
export type EmbedResponse =
  | { id: number; type: "progress"; progress: number }
  | { id: number; type: "ready" }
  | { id: number; type: "result"; vectors: number[][] }
  | { id: number; type: "error"; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let extractor: Promise<FeatureExtractionPipeline> | null = null;

function load(id: number) {
  extractor ??= pipeline("feature-extraction", EMBED_MODEL, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (p: ProgressInfo) => {
      if (p.status === "progress_total") scope.postMessage({ id, type: "progress", progress: p.progress } satisfies EmbedResponse);
    },
  }) as Promise<FeatureExtractionPipeline>;
  extractor.catch(() => (extractor = null));
  return extractor;
}

scope.onmessage = async (e: MessageEvent<EmbedRequest>) => {
  const msg = e.data;
  try {
    const fe = await load(msg.id);
    if (msg.type === "load") return scope.postMessage({ id: msg.id, type: "ready" } satisfies EmbedResponse);
    const output = await fe(msg.texts, { pooling: "mean", normalize: true });
    scope.postMessage({ id: msg.id, type: "result", vectors: output.tolist() as number[][] } satisfies EmbedResponse);
  } catch (err) {
    scope.postMessage({ id: msg.id, type: "error", message: err instanceof Error ? err.message : String(err) } satisfies EmbedResponse);
  }
};
