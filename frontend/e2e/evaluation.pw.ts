/**
 * Measures the real product in a real browser (HCARE_EVAL=1):
 *   - speech-to-text word error rate on labeled clips (e2e/eval-data/speech/*.wav + .txt)
 *   - OCR character error rate on document photos under realistic conditions
 *   - latency of each, cold (first use, includes model load) and warm
 * Results go to ../docs/eval/results.json (summarized in docs/EVALUATION.md).
 * Add your own recordings (e.g. Hindi) as name.wav + name.txt and set HCARE_EVAL_LANG.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cer, wer } from "../src/lib/eval/metrics";

test.skip(!process.env.HCARE_EVAL, "set HCARE_EVAL=1 to run the evaluation (downloads ~130 MB of models)");
test.setTimeout(1_800_000);

const here = fileURLToPath(new URL(".", import.meta.url));
const SPEECH_DIR = path.join(here, "eval-data", "speech");
const OUT = path.join(here, "..", "..", "docs", "eval", "results.json");
const LANG = process.env.HCARE_EVAL_LANG ?? "en";

const DOCUMENTS: { name: string; condition: string; css: string; overlay?: string; lines: string[] }[] = [
  {
    name: "lab-report",
    condition: "Clean print, straight",
    css: "",
    lines: ["SUNRISE PATHOLOGY LAB", "Haemoglobin 9.8 g/dL", "Total Leucocyte Count 11200 /cumm", "Platelet Count 1.6 lakh/cumm", "Fasting Blood Sugar 132 mg/dL"],
  },
  {
    name: "prescription",
    condition: "Tilted 5 degrees",
    css: "transform: rotate(5deg);",
    lines: ["Rx", "Tab Azithromycin 500 mg OD x 3 days", "Tab Cetirizine 10 mg HS x 5 days", "Syp Ambroxol 5 ml TDS", "Review after 5 days"],
  },
  {
    name: "discharge-note",
    condition: "Tilted -8 degrees with a shadow across the page",
    css: "transform: rotate(-8deg);",
    overlay: "linear-gradient(100deg, rgba(0,0,0,0) 35%, rgba(0,0,0,0.45) 100%)",
    lines: ["DISCHARGE SUMMARY", "Diagnosis: Acute gastroenteritis", "BP 118/76 mmHg Pulse 88", "Advised ORS and Zinc 20 mg OD"],
  },
  {
    name: "kidney-panel",
    condition: "Dim, slightly blurred, low-contrast photo, tilted 3 degrees",
    css: "transform: rotate(3deg); filter: blur(0.6px) contrast(0.65) brightness(0.85);",
    lines: ["RENAL FUNCTION TEST", "Serum Creatinine 1.4 mg/dL", "Blood Urea 42 mg/dL", "Uric Acid 6.1 mg/dL"],
  },
];

async function photo(page: Page, doc: (typeof DOCUMENTS)[number]): Promise<Buffer> {
  const shot = await page.context().newPage();
  await shot.setViewportSize({ width: 1100, height: 800 });
  await shot.setContent(`
    <body style="margin:0;background:#cfc9bd;display:grid;place-items:center;height:100vh;position:relative">
      <div style="background:#fbfaf6;padding:44px 52px;font:28px/1.6 Arial,sans-serif;color:#1a1a1a;box-shadow:0 0 30px #0003;${doc.css}">
        ${doc.lines.map((l) => `<div>${l}</div>`).join("")}
      </div>
      ${doc.overlay ? `<div style="position:absolute;inset:0;background:${doc.overlay}"></div>` : ""}
    </body>`);
  const png = await shot.screenshot();
  await shot.close();
  return png;
}

async function openCapture(page: Page, name: string) {
  await page.getByRole("link", { name: "HCare" }).click();
  await page.getByRole("link", { name: "+ New patient" }).click();
  await page.getByLabel("Full name *").fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("link", { name: "+ New consultation" }).click();
  await page.getByLabel("Visit language").selectOption(LANG);
}

/** Wait for the nth capture item's text; returns [text, seconds]. */
async function result(page: Page, index: number, started: number): Promise<[string, number]> {
  const box = page.locator(".capture-item").nth(index).getByLabel("Corrected text");
  await expect(box).toBeVisible({ timeout: 600_000 });
  await expect(box).not.toHaveValue("", { timeout: 60_000 });
  return [await box.inputValue(), (Date.now() - started) / 1000];
}

test("evaluation: speech WER, OCR CER, latency", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Username").fill("doctor");
  await page.getByLabel("Password").fill("doctor123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  const device = await page.evaluate(async () => ({
    webgpu: !!(await (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu?.requestAdapter()),
    cores: navigator.hardwareConcurrency,
  }));
  const results: Record<string, unknown> = {
    date: new Date().toISOString(),
    machine: { cpu: cpus()[0]?.model, cores: cpus().length, ram_gb: Math.round(totalmem() / 2 ** 30), webgpu: device.webgpu, browser: "Chromium (Playwright)" },
  };

  // ---------------- speech
  const clips = readdirSync(SPEECH_DIR).filter((f) => f.endsWith(".wav")).sort();
  const speech: Record<string, unknown> = {};
  for (const model of ["onnx-community/whisper-tiny", "onnx-community/whisper-base"]) {
    await openCapture(page, `WER ${model.split("/")[1]}`);
    await page.getByLabel("Speech model").selectOption(model);
    const rows = [];
    for (const [i, clip] of clips.entries()) {
      const reference = readFileSync(path.join(SPEECH_DIR, clip.replace(/\.wav$/, ".txt")), "utf8").trim();
      const started = Date.now();
      await page.locator(".recorder input[type=file]").setInputFiles(path.join(SPEECH_DIR, clip));
      const [hypothesis, seconds] = await result(page, i, started);
      rows.push({ clip, reference, hypothesis, ...wer(reference, hypothesis), seconds });
    }
    const words = rows.reduce((s, r) => s + r.words, 0);
    const errors = rows.reduce((s, r) => s + r.errors, 0);
    speech[model] = {
      wer: errors / words,
      words,
      errors,
      cold_seconds: rows[0].seconds,
      warm_seconds_avg: rows.slice(1).reduce((s, r) => s + r.seconds, 0) / Math.max(1, rows.length - 1),
      clips: rows,
    };
    console.log(`${model}: WER ${((errors / words) * 100).toFixed(1)}% over ${words} words; cold ${rows[0].seconds.toFixed(1)}s`);
  }
  results.speech = { language: LANG, source: "Windows SAPI text-to-speech (2 voices), 16 kHz", models: speech };

  // ---------------- OCR
  await openCapture(page, "OCR evaluation");
  const ocrRows = [];
  for (const [i, doc] of DOCUMENTS.entries()) {
    const started = Date.now();
    await page.getByLabel("Upload document image").setInputFiles({ name: `${doc.name}.png`, mimeType: "image/png", buffer: await photo(page, doc) });
    const [text, seconds] = await result(page, i, started);
    const truth = doc.lines.join("\n");
    const card = page.locator(".capture-item").nth(i);
    const meta = await card.locator(".doc-text p.small").first().innerText();
    ocrRows.push({ document: doc.name, condition: doc.condition, ...cer(truth, text), seconds, reported: meta, text });
    console.log(`OCR ${doc.name}: CER ${((cer(truth, text).rate) * 100).toFixed(1)}% (${doc.condition})`);
  }
  const chars = ocrRows.reduce((s, r) => s + r.chars, 0);
  results.ocr = {
    engine: "Tesseract.js (eng) after on-device preprocessing (contrast, denoise, deskew, Sauvola)",
    cer: ocrRows.reduce((s, r) => s + r.errors, 0) / chars,
    chars,
    documents: ocrRows,
  };

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`wrote ${OUT}`);
});
