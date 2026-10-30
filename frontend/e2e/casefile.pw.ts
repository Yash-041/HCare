/**
 * Voice note -> transcript -> structured case file -> clinician review -> verified -> synced.
 * Uses real Whisper (HCARE_E2E_AI=1). The GPU-only on-device LLM is tested in llm.pw.ts.
 */
import { expect, test } from "@playwright/test";
import { captureVoiceNote, fieldRow } from "./helpers";

test.skip(!process.env.HCARE_E2E_AI, "set HCARE_E2E_AI=1 to run real-model tests");
test.setTimeout(600_000);

test("voice note becomes a structured case file the clinician verifies", async ({ page }) => {
  await captureVoiceNote(page, "Sushila Bai");

  // Rules run automatically on a fresh draft.
  await expect(page.getByText(/Filled \d+ fields?/)).toBeVisible();
  const symptoms = fieldRow(page, "Symptoms");
  await expect(symptoms.getByLabel("Symptom").first()).toHaveValue("fever");
  await expect(symptoms.getByLabel("Duration").first()).toHaveValue("3 days");
  await expect(symptoms.getByLabel("Symptom").nth(1)).toHaveValue("cough");
  await expect(fieldRow(page, "Allergies").getByLabel("Substance").first()).toHaveValue("Penicillin");

  // Provenance: source + confidence, with the evidence one click away.
  const prov = fieldRow(page, "Allergies").locator(".prov");
  await expect(prov).toContainText(/Rule · \d+% · Voice note 1/);
  await prov.click();
  await expect(fieldRow(page, "Allergies").locator(".prov-pop")).toContainText(/penicillin/i);

  // Clinician correction marks the field as their own entry.
  await fieldRow(page, "Chief complaint").locator("textarea").fill("Fever for 3 days with dry cough");
  await expect(fieldRow(page, "Chief complaint").locator(".prov")).toHaveText("Edited");

  // Invalid values block verification.
  const pulse = page.locator(".vitals-grid label", { hasText: "Pulse" }).locator("input");
  await pulse.fill("400");
  await expect(page.getByRole("button", { name: "Verify & save" })).toBeDisabled();
  await pulse.fill("92");

  await page.getByRole("button", { name: "Verify & save" }).click();
  await expect(page.locator(".chip.review-verified")).toHaveText("Verified");
  // Verified files are read-only until explicitly reopened.
  await expect(fieldRow(page, "Chief complaint").locator("textarea")).toBeDisabled();
  await expect(page.locator(".badge")).toHaveText("Synced", { timeout: 20_000 });

  // Back on the patient page the visit shows as verified.
  await page.getByRole("link", { name: /Sushila Bai/ }).click();
  await expect(page.locator(".list-item", { hasText: "Fever for 3 days with dry cough" })).toContainText("Verified");
});

test("on CPU-only browsers the LLM option is replaced by an explanation", async ({ page }) => {
  // Headless Chromium has no GPU adapter, like most low-end phones.
  await captureVoiceNote(page, "Lata Joshi");
  await expect(page.getByText(/needs a browser with GPU support/)).toBeVisible();
  await expect(page.getByLabel(/Also use the on-device AI model/)).toBeHidden();
  await expect(page.getByText(/Filled \d+ fields?/)).toBeVisible();
});
