/**
 * On-device LLM (Qwen2.5-1.5B, WebGPU) on top of the rules. Runs headed, because headless
 * Chromium has no GPU adapter, with a persistent profile so the ~1.1 GB model is cached
 * between runs. Needs HCARE_E2E_AI=1 and HCARE_E2E_LLM=1.
 */
import { chromium, expect, test } from "@playwright/test";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureVoiceNote, fieldRow } from "./helpers";

test.skip(!process.env.HCARE_E2E_AI || !process.env.HCARE_E2E_LLM, "set HCARE_E2E_AI=1 and HCARE_E2E_LLM=1");
test.setTimeout(1_800_000);

test("on-device LLM adds grounded fields on top of the rules", async ({ baseURL }) => {
  const context = await chromium.launchPersistentContext(path.join(tmpdir(), "hcare-llm-profile"), {
    headless: false,
    args: ["--enable-unsafe-webgpu"],
    baseURL,
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[browser]", m.text());
  });
  try {
    await page.goto("/");
    // Fresh server DB each run, but the persistent profile may still hold an old session.
    if (await page.getByRole("button", { name: "Sign in as someone else" }).isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "Sign in as someone else" }).click();
    }
    await captureVoiceNote(page, "Kavita Rao");
    const f16 = await page.evaluate(async () => {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
      return !!(await gpu?.requestAdapter())?.features.has("shader-f16");
    });
    test.skip(!f16, "no WebGPU fp16 on this machine");
    await expect(page.getByText(/Filled \d+ fields?/)).toBeVisible();

    await page.getByLabel(/Also use the on-device AI model/).check();
    const download = page.getByRole("button", { name: "Download now" });
    if (await download.isVisible()) await download.click();
    await expect(page.getByText(/downloaded ✓/)).toBeVisible({ timeout: 1_200_000 });

    const started = Date.now();
    await page.getByRole("button", { name: "Re-extract from notes" }).click();
    const status = page.getByText(/On-device AI is/);
    await expect(status).toBeVisible();
    // Log progress so a failure shows whether tokens were flowing (slow) or not (stuck).
    while (await status.isVisible()) {
      console.log(`${Math.round((Date.now() - started) / 1000)}s:`, await status.innerText().catch(() => "(done)"));
      await page.waitForTimeout(20_000);
      if (Date.now() - started > 600_000) break;
    }
    console.log(`LLM structuring took ${Math.round((Date.now() - started) / 1000)}s`);

    const notice = page.locator(".notice");
    console.log("Notice:", await notice.innerText());
    await expect(notice).toContainText(/Filled \d+ field/);
    await expect(notice).not.toContainText("could not be read");
    await expect(notice).not.toContainText(/failed|stopped responding/);
    // Rule-extracted facts survive; nothing ungrounded is added.
    await expect(fieldRow(page, "Allergies").getByLabel("Substance").first()).toHaveValue("Penicillin");
    await expect(fieldRow(page, "Diagnosis").getByLabel("Diagnosis")).toHaveCount(0);
    const cc = fieldRow(page, "Chief complaint");
    console.log("Chief complaint:", await cc.locator("textarea").inputValue(), "|", await cc.locator(".prov").innerText());
  } finally {
    await context.close();
  }
});
