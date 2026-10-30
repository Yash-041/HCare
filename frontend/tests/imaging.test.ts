import { describe, expect, it } from "vitest";
import { estimateSkew, gray, median3, preprocessForOcr, rotate, sauvola, stretchContrast, type Gray } from "../src/ai/imaging";
import { toResult } from "../src/ai/ocr";

/** A synthetic "page": dark horizontal text-like bars with gaps, on white. */
function page(width = 600, height = 400): Gray {
  const g = gray(width, height, 245);
  for (let line = 40; line < height - 40; line += 28) {
    for (let x = 40; x < width - 40; x++) {
      if (Math.floor(x / 9) % 5 === 4) continue; // word gaps
      for (let y = line; y < line + 10; y++) g.data[y * width + x] = 20;
    }
  }
  return g;
}

function darkFraction(g: Gray): number {
  let n = 0;
  for (const v of g.data) if (v < 128) n++;
  return n / g.data.length;
}

describe("deskew", () => {
  it.each([-7, -2.5, 0, 3, 11])("recovers a %s° rotation within 0.5°", (deg) => {
    expect(estimateSkew(rotate(page(), deg))).toBeCloseTo(deg, 0);
    expect(Math.abs(estimateSkew(rotate(page(), deg)) - deg)).toBeLessThanOrEqual(0.5);
  });

  it("rotating back straightens the page", () => {
    const skewed = rotate(page(), 6);
    const straight = rotate(skewed, -estimateSkew(skewed));
    expect(Math.abs(estimateSkew(straight))).toBeLessThanOrEqual(0.5);
  });
});

describe("threshold and cleanup", () => {
  it("Sauvola keeps text dark and turns an uneven (shadowed) background white", () => {
    const g = page();
    // Shadow: background darkens from 245 on the left to ~120 on the right.
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        const i = y * g.width + x;
        if (g.data[i] > 100) g.data[i] = 245 - (125 * x) / g.width;
      }
    }
    const bin = sauvola(g, 31);
    // Text pixel inside the shadowed right half stays black...
    expect(bin.data[45 * g.width + 500]).toBe(0);
    // ...and background in the shadow becomes white (a global threshold at 128 would fail here).
    expect(bin.data[30 * g.width + 560]).toBe(255);
    expect(bin.data[60 * g.width + 560]).toBe(255);
  });

  it("median filter removes isolated noise pixels", () => {
    const g = gray(50, 50, 255);
    for (let i = 0; i < 40; i++) g.data[Math.floor((i * 97) % 2500)] = 0;
    expect(darkFraction(median3(g))).toBe(0);
  });

  it("contrast stretch expands a faded image to the full range", () => {
    const g = gray(100, 100, 180);
    for (let i = 0; i < 2000; i++) g.data[i] = 140;
    const s = stretchContrast(g);
    expect(Math.min(...s.data)).toBe(0);
    expect(Math.max(...s.data)).toBe(255);
  });

  it("full pipeline returns a binary, deskewed image", () => {
    const { image, skewDeg } = preprocessForOcr(rotate(page(), 4));
    expect(Math.abs(skewDeg - 4)).toBeLessThanOrEqual(0.5);
    expect(new Set(image.data)).toEqual(new Set([0, 255]));
    expect(darkFraction(image)).toBeGreaterThan(0.05);
  });
});

describe("OCR confidence mapping", () => {
  it("maps word confidences to text offsets and flags uncertain words", () => {
    const text = "BP 130/80 mmHg\nPulse 88\n";
    const r = toResult(text, [
      { text: "BP", confidence: 96 },
      { text: "130/80", confidence: 52 },
      { text: "mmHg", confidence: 90 },
      { text: "Pulse", confidence: 93 },
      { text: "88", confidence: 41 },
    ]);
    expect(r.lowConfidenceSpans.map((s) => text.slice(s.start, s.end))).toEqual(["130/80", "88"]);
    expect(r.confidence).toBeCloseTo((96 + 52 + 90 + 93 + 41) / 500, 5);
  });
});
