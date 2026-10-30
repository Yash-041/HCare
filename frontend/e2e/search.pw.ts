/**
 * Records created on another device arrive through sync, are indexed automatically, and are
 * searchable offline in English, Hinglish and Devanagari.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

const API = "http://127.0.0.1:8001";

async function seedFromAnotherDevice(request: APIRequestContext) {
  const { access_token } = await (await request.post(`${API}/auth/login`, { data: { username: "doctor", password: "doctor123" } })).json();
  const patientId = randomUUID();
  const ops = [
    {
      op_id: randomUUID(),
      entity: "patient",
      entity_id: patientId,
      op_type: "upsert",
      base_version: 0,
      data: { name: "Meera Bai", sex: "female", village: "Sitapur", known_allergies: [], chronic_conditions: [] },
    },
    {
      op_id: randomUUID(),
      entity: "consultation",
      entity_id: randomUUID(),
      op_type: "upsert",
      base_version: 0,
      data: {
        patient_id: patientId,
        visit_date: "2026-10-15",
        // Unstructured Hinglish draft: nothing but the transcript.
        raw_transcript: "do din se bukhar aur khansi hai. Dolo 650 di.",
        sources: [],
        field_meta: {},
        review: { status: "draft" },
      },
    },
    {
      op_id: randomUUID(),
      entity: "consultation",
      entity_id: randomUUID(),
      op_type: "upsert",
      base_version: 0,
      data: {
        patient_id: patientId,
        visit_date: "2026-09-02",
        raw_transcript: "do hafte se saans phoolna", // breathlessness, in Hinglish
        sources: [],
        field_meta: {},
        review: { status: "draft" },
      },
    },
  ];
  const res = await request.post(`${API}/sync/push`, {
    headers: { Authorization: `Bearer ${access_token}` },
    data: { device_id: "tablet-2", ops },
  });
  expect((await res.json()).results.map((r: { status: string }) => r.status)).toEqual(["applied", "applied", "applied"]);
}

async function searchFor(page: Page, q: string) {
  await page.getByLabel("Search", { exact: true }).fill(q);
}

test("synced records are searchable offline in any language", async ({ context, request }) => {
  await seedFromAnotherDevice(request);

  const page = await context.newPage();
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.getByLabel("Username").fill("asha");
  await page.getByLabel("Password").fill("asha1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".badge")).toHaveText("Synced", { timeout: 15_000 });
  await expect(page.getByText("Meera Bai")).toBeVisible();

  await context.setOffline(true);
  const group = page.locator(".result-group", { hasText: "Meera Bai" });

  for (const [q, reason] of [
    ["fever", "symptom: fever"],
    ["bukhar", "symptom: fever"],
    ["खांसी", "symptom: cough"],
    ["paracetamol", "medicine: Paracetamol"],
  ]) {
    await searchFor(page, q);
    await expect(group.locator(".sub-hit"), q).toContainText("Visit · 2026-10-15");
    await expect(group.locator(".sub-hit .reasons"), q).toContainText(reason);
  }

  await searchFor(page, "meera sitapur");
  await expect(group).toBeVisible();
  await searchFor(page, "meeraa"); // typo
  await expect(group).toBeVisible();
  await expect(page.getByText(/result.* ms, on this device/)).toBeVisible();

  // Date range only.
  await searchFor(page, "");
  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByLabel("From").fill("2026-10-01");
  await page.getByLabel("To").fill("2026-10-31");
  await expect(group.locator(".sub-hit")).toContainText("2026-10-15");
  await page.getByLabel("To").fill("2026-10-10");
  await expect(page.getByText("No matching records.")).toBeVisible();

  // Opening the hit works offline too.
  await page.getByLabel("To").fill("");
  await page.getByLabel("From").fill("");
  await searchFor(page, "bukhar");
  await group.locator(".sub-hit").click();
  await expect(page.getByRole("heading", { name: /Case file · 2026-10-15/ })).toBeVisible();
});

test("smart search finds related wording with the on-device embedding model", async ({ context, request }) => {
  test.skip(!process.env.HCARE_E2E_AI, "set HCARE_E2E_AI=1 to download the 22 MB embedding model");
  await seedFromAnotherDevice(request);
  const page = await context.newPage();
  await page.goto("/");
  await page.getByLabel("Username").fill("asha");
  await page.getByLabel("Password").fill("asha1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".badge")).toHaveText("Synced", { timeout: 15_000 });

  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByLabel(/Smart search/).check();
  await expect(page.getByText("Preparing smart search…")).toBeHidden({ timeout: 180_000 });
  await expect(page.getByLabel(/Smart search/)).toBeChecked();

  // No keyword overlap with "saans phoolna" (indexed as breathlessness): found by meaning.
  await searchFor(page, "breathing problem");
  // (Each test seeds its own "Meera Bai" on the shared server, hence .first().)
  const hit = page.locator(".result-group", { hasText: "Meera Bai" }).first().locator(".sub-hit", { hasText: "2026-09-02" });
  await expect(hit.locator(".chip-related")).toContainText(/related \(\d+%\)/, { timeout: 20_000 });
  // Colloquial phrasing the small model can't link is covered by the lexicon instead.
  await searchFor(page, "high temperature");
  await expect(page.locator(".result-group", { hasText: "Meera Bai" }).first().locator(".sub-hit", { hasText: "2026-10-15" })).toContainText(
    "symptom: fever",
  );
});
