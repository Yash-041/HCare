/// <reference lib="webworker" />
import { preprocessForOcr, toGray, toRgba } from "./imaging";

export type PreprocessRequest = { id: number; blob: Blob; maxSide: number };
export type PreprocessResponse =
  | { id: number; ok: true; original: Blob; processed: Blob; skewDeg: number; width: number; height: number }
  | { id: number; ok: false; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<PreprocessRequest>) => {
  const { id, blob, maxSide } = e.data;
  try {
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    // Compressed copy of the photo for the record (what the clinician verifies against).
    const original = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });

    const { image, skewDeg } = preprocessForOcr(toGray(ctx.getImageData(0, 0, w, h).data, w, h));
    const out = new OffscreenCanvas(image.width, image.height);
    out.getContext("2d")!.putImageData(new ImageData(toRgba(image), image.width, image.height), 0, 0);
    const processed = await out.convertToBlob({ type: "image/png" });

    scope.postMessage({ id, ok: true, original, processed, skewDeg, width: image.width, height: image.height } satisfies PreprocessResponse);
  } catch (err) {
    scope.postMessage({ id, ok: false, message: err instanceof Error ? err.message : String(err) } satisfies PreprocessResponse);
  }
};
