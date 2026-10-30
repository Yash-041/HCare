import type { EmbedRequest, EmbedResponse } from "./embed.worker";

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: EmbedResponse) => void; reject: (e: Error) => void; onProgress?: (f: number) => void }>();

function call(req: WithoutId<EmbedRequest>, onProgress?: (f: number) => void) {
  if (!worker) {
    worker = new Worker(new URL("./embed.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<EmbedResponse>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      if (e.data.type === "progress") return p.onProgress?.(e.data.progress / 100);
      pending.delete(e.data.id);
      if (e.data.type === "error") p.reject(new Error(e.data.message));
      else p.resolve(e.data);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || "embedding worker crashed"));
      pending.clear();
      worker = null;
    };
  }
  const id = nextId++;
  return new Promise<EmbedResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker!.postMessage({ ...req, id } as EmbedRequest);
  });
}

export async function loadEmbedder(onProgress?: (f: number) => void): Promise<void> {
  await call({ type: "load" }, onProgress);
}

export async function embed(texts: string[]): Promise<number[][]> {
  const res = await call({ type: "embed", texts });
  if (res.type !== "result") throw new Error("unexpected response from embedding worker");
  return res.vectors;
}
