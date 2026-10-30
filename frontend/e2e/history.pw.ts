/**
 * Patient history (RAG over local records): synced past visits are summarized with sources,
 * trends and safety alerts when a new visit is opened, offline.
 */
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

const API = "http://127.0.0.1:8001";

test("opening a new visit shows the sourced patient history, offline", async ({ context, request }) => {
  const { access_token } = await (await request.post(`${API}/auth/login`, { data: { username: "doctor", password: "doctor123" } })).json();
  const pid = randomUUID();
  const currentId = randomUUID();
  const verified = (date: string) => ({ status: "verified", reviewed_by: "doctor", reviewed_at: `${date}T10:00:00Z` });
  const visit = (id: string, date: string, d: object, review: object = verified(date)) => ({
    op_id: randomUUID(),
    entity: "consultation",
    entity_id: id,
    op_type: "upsert",
    base_version: 0,
    data: { patient_id: pid, visit_date: date, sources: [], field_meta: {}, review, ...d },
  });
  const ops = [
    {
      op_id: randomUUID(),
      entity: "patient",
      entity_id: pid,
      op_type: "upsert",
      base_version: 0,
      data: { name: "Kamla Devi", sex: "female", age_years: 58, village: "Rampur", known_allergies: [{ substance: "Penicillin", reaction: "rash" }], chronic_conditions: ["Hypertension"] },
    },
    visit(randomUUID(), "2026-03-10", {
      chief_complaint: "Headache",
      vitals: { bp_systolic: 152, bp_diastolic: 96, weight_kg: 62 },
      medications: [{ name: "Amlodipine", dose: "5 mg", frequency: "once daily" }],
      lab_results: [{ name: "Haemoglobin", value: "11.2", unit: "g/dL" }],
    }),
    visit(randomUUID(), "2026-06-02", {
      chief_complaint: "Fever and cough for 3 days",
      symptoms: [{ name: "fever" }, { name: "cough" }],
      vitals: { bp_systolic: 146, bp_diastolic: 92, weight_kg: 60.5 },
      medications: [{ name: "Paracetamol", dose: "500 mg", frequency: "three times daily" }],
    }),
    visit(randomUUID(), "2026-09-15", {
      chief_complaint: "Weakness",
      vitals: { bp_systolic: 144, bp_diastolic: 90, weight_kg: 58 },
      lab_results: [{ name: "Haemoglobin", value: "9.8", unit: "g/dL" }],
    }, { status: "draft" }),
    // Today's visit: fever again, and a penicillin-group drug prescribed.
    visit(currentId, "2026-10-30", {
      chief_complaint: "Fever",
      symptoms: [{ name: "fever" }],
      medications: [{ name: "Penicillin" }],
      field_meta: { chief_complaint: { source: "manual", verified: true } },
    }, { status: "draft" }),
  ];
  const res = await request.post(`${API}/sync/push`, { headers: { Authorization: `Bearer ${access_token}` }, data: { device_id: "tablet-2", ops } });
  expect((await res.json()).results.every((r: { status: string }) => r.status === "applied")).toBe(true);

  const page = await context.newPage();
  await page.goto("/");
  // Offline navigation needs the service worker to control the page first.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.getByLabel("Username").fill("asha");
  await page.getByLabel("Password").fill("asha1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".badge")).toHaveText("Synced", { timeout: 15_000 });
  await context.setOffline(true);

  await page.goto(`/patients/${pid}/consultations/${currentId}`);
  // A full page load locks the app; unlock (offline) with the password.
  await page.getByLabel("Password").fill("asha1234");
  await page.getByRole("button", { name: "Unlock" }).click();
  const history = page.locator(".history");
  await expect(history).toContainText("3 earlier visits");

  // Safety alert: allergy vs today's prescription, with the source of the allergy.
  const alert = history.locator(".hist-alert").first();
  await expect(alert).toContainText("the patient has a recorded allergy to it");
  await expect(alert.locator(".src-link").first()).toHaveText("profile");

  await expect(history.locator(".hist-section", { hasText: "Medicines" })).toContainText("Amlodipine 5 mg, once daily");
  const bp = history.locator(".trend", { hasText: "Blood pressure" });
  await expect(bp).toContainText("Systolic BP fell from 152 to 144 mmHg");
  await expect(bp.locator(".spark-latest")).toContainText("144 / 90");
  // Facts from an unverified draft are marked as such.
  await expect(history.locator(".trend", { hasText: "Haemoglobin" }).locator(".src-unverified")).toContainText("draft");
  // Retrieval: the earlier fever visit ranks first for today's fever.
  await expect(history.locator(".hist-section", { hasText: "Most relevant" }).locator("li").first()).toContainText("Fever and cough");

  // Hover a sparkline point -> tooltip with date and both values.
  const svg = bp.locator("svg");
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await expect(bp.locator(".spark-tip")).toContainText("152");
  await page.screenshot({ path: "test-results/history-panel.png", fullPage: true });
  await history.screenshot({ path: "test-results/history-panel-crop.png" });

  // Source chips open the visit the fact came from.
  await bp.locator(".src-link").first().click();
  await expect(page.getByRole("heading", { name: /Case file · 2026-03-10/ })).toBeVisible();
});
