/**
 * Document image preprocessing for OCR on phone photos: uneven lighting, shadows,
 * slight rotation, sensor noise. Pure functions over 8-bit grayscale buffers so they run
 * in a worker and can be unit-tested without a browser.
 */

export interface Gray {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function gray(width: number, height: number, fill = 255): Gray {
  return { width, height, data: new Uint8ClampedArray(width * height).fill(fill) };
}

/** RGBA -> luminance (Rec. 601). */
export function toGray(rgba: Uint8ClampedArray, width: number, height: number): Gray {
  const out = gray(width, height);
  for (let i = 0, j = 0; j < out.data.length; i += 4, j++) {
    out.data[j] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
  }
  return out;
}

export function toRgba(g: Gray): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(g.data.length * 4);
  for (let i = 0, j = 0; i < g.data.length; i++, j += 4) {
    out[j] = out[j + 1] = out[j + 2] = g.data[i];
    out[j + 3] = 255;
  }
  return out;
}

/** Stretch the [low, high] percentile range to 0..255 (fixes faded or dim photos). */
export function stretchContrast(g: Gray, lowPct = 0.01, highPct = 0.99): Gray {
  const hist = new Uint32Array(256);
  for (const v of g.data) hist[v]++;
  const n = g.data.length;
  let lo = 0;
  let hi = 255;
  for (let acc = 0, i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= n * lowPct) {
      lo = i;
      break;
    }
  }
  for (let acc = 0, i = 255; i >= 0; i--) {
    acc += hist[i];
    if (acc >= n * (1 - highPct)) {
      hi = i;
      break;
    }
  }
  if (hi - lo < 10) return g;
  const scale = 255 / (hi - lo);
  const out = gray(g.width, g.height);
  for (let i = 0; i < n; i++) out.data[i] = (g.data[i] - lo) * scale;
  return out;
}

/** 3x3 median: removes salt-and-pepper sensor noise while keeping stroke edges. */
export function median3(g: Gray): Gray {
  const { width: w, height: h, data } = g;
  const out = gray(w, h);
  const win = new Uint8Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          win[k++] = data[yy * w + xx];
        }
      }
      win.sort();
      out.data[y * w + x] = win[4];
    }
  }
  return out;
}

/** Nearest-neighbour downscale so the longest side is at most `maxSide`. */
export function downscale(g: Gray, maxSide: number): Gray {
  const scale = Math.min(1, maxSide / Math.max(g.width, g.height));
  if (scale === 1) return g;
  const w = Math.max(1, Math.round(g.width * scale));
  const h = Math.max(1, Math.round(g.height * scale));
  const out = gray(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(g.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      out.data[y * w + x] = g.data[sy * g.width + Math.min(g.width - 1, Math.floor(x / scale))];
    }
  }
  return out;
}

/**
 * Estimate text skew in degrees (positive = clockwise on screen) via projection profiles:
 * when the candidate angle matches, dark pixels pile up into sharp rows, maximising the
 * squared differences between adjacent row sums.
 */
export function estimateSkew(g: Gray, maxDeg = 15): number {
  const small = downscale(g, 600);
  const { width: w, height: h, data } = small;
  let mean = 0;
  for (const v of data) mean += v;
  mean /= data.length;
  const threshold = Math.min(mean * 0.75, 160);

  const xs: number[] = [];
  const ys: number[] = [];
  const step = Math.max(1, Math.floor((w * h) / 60_000));
  for (let i = 0; i < data.length; i += step) {
    if (data[i] < threshold) {
      xs.push((i % w) - w / 2);
      ys.push(Math.floor(i / w) - h / 2);
    }
  }
  if (xs.length < 50) return 0;

  const diag = Math.ceil(Math.hypot(w, h));
  const bins = new Float64Array(diag * 2 + 1);
  const score = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    const sin = Math.sin(a);
    const cos = Math.cos(a);
    bins.fill(0);
    for (let i = 0; i < xs.length; i++) bins[Math.round(-xs[i] * sin + ys[i] * cos) + diag]++;
    let s = 0;
    for (let i = 1; i < bins.length; i++) s += (bins[i] - bins[i - 1]) ** 2;
    return s;
  };

  let best = 0;
  let bestScore = -1;
  for (let d = -maxDeg; d <= maxDeg; d += 0.5) {
    const s = score(d);
    if (s > bestScore) [best, bestScore] = [d, s];
  }
  const coarse = best;
  for (let d = coarse - 0.5; d <= coarse + 0.5; d += 0.1) {
    const s = score(d);
    if (s > bestScore) [best, bestScore] = [d, s];
  }
  return Math.round(best * 10) / 10;
}

/** Rotate by `deg` (clockwise on screen), bilinear, white background, canvas grown to fit. */
export function rotate(g: Gray, deg: number): Gray {
  if (Math.abs(deg) < 0.05) return g;
  const a = (deg * Math.PI) / 180;
  const sin = Math.sin(a);
  const cos = Math.cos(a);
  const w = Math.ceil(Math.abs(g.width * cos) + Math.abs(g.height * sin));
  const h = Math.ceil(Math.abs(g.width * sin) + Math.abs(g.height * cos));
  const out = gray(w, h);
  const cx = g.width / 2;
  const cy = g.height / 2;
  const ox = w / 2;
  const oy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Inverse mapping: where in the source does this output pixel come from?
      const dx = x - ox;
      const dy = y - oy;
      const sx = cx + dx * cos + dy * sin;
      const sy = cy - dx * sin + dy * cos;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= g.width - 1 || y0 >= g.height - 1) continue;
      const fx = sx - x0;
      const fy = sy - y0;
      const i = y0 * g.width + x0;
      const top = g.data[i] * (1 - fx) + g.data[i + 1] * fx;
      const bottom = g.data[i + g.width] * (1 - fx) + g.data[i + g.width + 1] * fx;
      out.data[y * w + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}

/**
 * Sauvola adaptive threshold: each pixel is compared with the mean/stddev of its own
 * neighbourhood, so shadows and gradients from phone photos don't swallow text.
 */
export function sauvola(g: Gray, window = 31, k = 0.3, R = 128): Gray {
  const { width: w, height: h, data } = g;
  const W = w + 1;
  const sum = new Float64Array(W * (h + 1));
  const sq = new Float64Array(W * (h + 1));
  for (let y = 1; y <= h; y++) {
    let rowSum = 0;
    let rowSq = 0;
    for (let x = 1; x <= w; x++) {
      const v = data[(y - 1) * w + (x - 1)];
      rowSum += v;
      rowSq += v * v;
      sum[y * W + x] = sum[(y - 1) * W + x] + rowSum;
      sq[y * W + x] = sq[(y - 1) * W + x] + rowSq;
    }
  }
  const r = Math.floor(window / 2);
  const out = gray(w, h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const s = sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0];
      const s2 = sq[y1 * W + x1] - sq[y0 * W + x1] - sq[y1 * W + x0] + sq[y0 * W + x0];
      const mean = s / n;
      const std = Math.sqrt(Math.max(0, s2 / n - mean * mean));
      const t = mean * (1 + k * (std / R - 1));
      out.data[y * w + x] = data[y * w + x] > t ? 255 : 0;
    }
  }
  return out;
}

export interface PreprocessResult {
  image: Gray;
  skewDeg: number;
}

/** Full pipeline: grayscale input -> contrast -> denoise -> deskew -> adaptive threshold. */
export function preprocessForOcr(g: Gray): PreprocessResult {
  const stretched = stretchContrast(g);
  const denoised = median3(stretched);
  const skewDeg = estimateSkew(denoised);
  const straight = rotate(denoised, -skewDeg);
  // Window scales with resolution: roughly 2-3 text-line heights.
  const window = Math.max(15, Math.round(Math.max(straight.width, straight.height) / 60) | 1);
  return { image: sauvola(straight, window), skewDeg };
}
