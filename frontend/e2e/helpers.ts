import { expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Windows TTS: "The patient has had a fever for three days and a dry cough. She is allergic to penicillin." */
export const FEVER_CLIP = path.join(fileURLToPath(new URL("./fixtures", import.meta.url)), "fever-note.wav");

/** Sign in, create a patient, transcribe the fixture voice note with Whisper Tiny, open the case file. */
export async function captureVoiceNote(page: Page, patientName: string) {
  await page.goto("/");
  await page.getByLabel("Username").fill("doctor");
  await page.getByLabel("Password").fill("doctor123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "+ New patient" }).click();
  await page.getByLabel("Full name *").fill(patientName);
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("link", { name: "+ New consultation" }).click();
  await page.getByLabel("Speech model").selectOption("onnx-community/whisper-tiny");
  await page.getByLabel("Visit language").selectOption("en");
  await page.locator(".recorder input[type=file]").setInputFiles(FEVER_CLIP);
  await expect(page.getByLabel("Corrected text")).toHaveValue(/penicillin/i, { timeout: 300_000 });
  await page.getByRole("button", { name: "Save & structure case file" }).click();
  await expect(page.getByRole("heading", { name: /Case file/ })).toBeVisible();
}

export const fieldRow = (page: Page, label: string) =>
  page.locator(".cf-field", { has: page.locator(".cf-label", { hasText: label }) });
