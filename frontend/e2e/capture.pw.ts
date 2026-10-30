/**
 * Real-model capture tests: Tesseract OCR and Whisper speech-to-text running in the
 * browser, including offline after the models were downloaded once.
 * They download ~50 MB of models, so they only run with HCARE_E2E_AI=1.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

test.skip(!process.env.HCARE_E2E_AI, "set HCARE_E2E_AI=1 to run real-model tests");
test.setTimeout(240_000);

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));

async function openApp(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.getByLabel("Username").fill("asha");
  await page.getByLabel("Password").fill("asha1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "+ New patient" }).click();
  await page.getByLabel("Full name *").fill("Geeta Kumari");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("link", { name: "+ New consultation" }).click();
  await expect(page.getByText("Offline AI models")).toBeVisible();
  return page;
}

/** Render a lab report as HTML, photograph it tilted, return PNG bytes. */
async function labReportPhoto(page: Page, lines: string[], tiltDeg: number): Promise<Buffer> {
  const shot = await page.context().newPage();
  await shot.setContent(`
    <body style="margin:0;background:#d6d3cc;display:grid;place-items:center;height:100vh">
      <div id="doc" style="background:#fbfaf6;padding:48px 56px;font:28px/1.6 Arial,sans-serif;color:#1a1a1a;
        transform:rotate(${tiltDeg}deg);box-shadow:0 0 30px #0003">
        ${lines.map((l) => `<div>${l}</div>`).join("")}
      </div>
    </body>`);
  await shot.setViewportSize({ width: 1100, height: 800 });
  const png = await shot.screenshot();
  await shot.close();
  return png;
}

test("document scan: tilted lab report is straightened and read, also offline", async ({ context }) => {
  const page = await openApp(context);
  await page.getByLabel("Document type").selectOption("lab_report");

  const report = ["CITY DIAGNOSTIC LAB", "Haemoglobin 9.8 g/dL", "Blood Pressure 130/80 mmHg", "Fasting Glucose 142 mg/dL"];
  await page.getByLabel("Upload document image").setInputFiles({
    name: "report.png",
    mimeType: "image/png",
    buffer: await labReportPhoto(page, report, 4),
  });
  const card = page.locator(".capture-item").first();
  const text = card.getByLabel("Corrected text");
  await expect(text).toBeVisible({ timeout: 120_000 });
  await expect(text).toHaveValue(/Haemoglobin 9\.8/);
  await expect(text).toHaveValue(/130\/80/);
  await expect(card).toContainText(/straightened -?[34](\.\d)?°/);

  // Offline: engine and language data must now come from local caches.
  await context.setOffline(true);
  await page.getByLabel("Upload document image").setInputFiles({
    name: "report2.png",
    mimeType: "image/png",
    buffer: await labReportPhoto(page, ["Serum Creatinine 1.4 mg/dL", "Platelets 210000"], -3),
  });
  const offlineText = page.locator(".capture-item").nth(1).getByLabel("Corrected text");
  await expect(offlineText).toHaveValue(/Creatinine 1\.4/, { timeout: 60_000 });

  // Still offline: save, then the scanned values are structured into the case file.
  await page.getByRole("button", { name: "Save & structure case file" }).click();
  await expect(page.getByRole("heading", { name: /Case file/ })).toBeVisible();
  const labs = page.locator(".cf-field", { has: page.locator(".cf-label", { hasText: "Lab results" }) });
  await expect(labs.getByLabel("Test").first()).toHaveValue("Haemoglobin");
  await expect(labs.getByLabel("Value").first()).toHaveValue("9.8");
  await expect(labs.getByLabel("Test").nth(1)).toHaveValue("Serum creatinine");
  await expect(page.locator(".vitals-grid label", { hasText: "Blood glucose" }).locator("input")).toHaveValue("142");
  await expect(page.locator(".vitals-grid label", { hasText: "BP systolic" }).locator("input")).toHaveValue("130");
});

test("voice note: Whisper transcribes an English clip, also offline", async ({ context }) => {
  const page = await openApp(context);
  await page.getByLabel("Speech model").selectOption("onnx-community/whisper-tiny");
  await page.getByLabel("Visit language").selectOption("en");

  const recording = path.join(fixtures, "fever-note.wav");
  await page.locator(".recorder input[type=file]").setInputFiles(recording);
  const transcript = page.locator(".capture-item").first().getByLabel("Corrected text");
  await expect(transcript).toBeVisible({ timeout: 200_000 });
  await expect(transcript).toHaveValue(/fever/i);
  await expect(transcript).toHaveValue(/cough/i);
  await expect(transcript).toHaveValue(/penicillin/i);

  await context.setOffline(true);
  await page.locator(".recorder input[type=file]").setInputFiles(recording);
  await expect(page.locator(".capture-item").nth(1).getByLabel("Corrected text")).toHaveValue(/fever/i, {
    timeout: 120_000,
  });
});
