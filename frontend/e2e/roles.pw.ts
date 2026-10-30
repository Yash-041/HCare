/**
 * Role-based homes: admin manages staff (no patient screens); a doctor the admin adds can
 * sign in and sees the health workers' case files waiting for review; deactivation cuts off
 * their device.
 */
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

const API = "http://127.0.0.1:8001";

async function signIn(page: Page, username: string, password: string) {
  await page.goto("/");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

test("admin adds a doctor, who reviews health workers' case files; deactivation cuts them off", async ({ browser, request }) => {
  // A health worker's draft case file, synced from her tablet.
  const { access_token } = await (await request.post(`${API}/auth/login`, { data: { username: "asha", password: "asha1234" } })).json();
  const pid = randomUUID();
  await request.post(`${API}/sync/push`, {
    headers: { Authorization: `Bearer ${access_token}` },
    data: {
      device_id: "asha-tablet",
      ops: [
        { op_id: randomUUID(), entity: "patient", entity_id: pid, op_type: "upsert", base_version: 0, data: { name: "Radha Kumari", known_allergies: [], chronic_conditions: [] } },
        {
          op_id: randomUUID(), entity: "consultation", entity_id: randomUUID(), op_type: "upsert", base_version: 0,
          data: { patient_id: pid, visit_date: "2026-10-29", chief_complaint: "Fever for 2 days", sources: [], field_meta: {}, review: { status: "draft" } },
        },
      ],
    },
  });

  // ---- admin
  const adminPage = await (await browser.newContext()).newPage();
  await signIn(adminPage, "admin", "admin123");
  await expect(adminPage.getByRole("heading", { name: "Staff" })).toBeVisible();
  await expect(adminPage.getByRole("link", { name: "+ New patient" })).toHaveCount(0);
  await adminPage.goto("/patients/new");
  await adminPage.getByLabel("Password").fill("admin123"); // full page load -> unlock
  await adminPage.getByRole("button", { name: "Unlock" }).click();
  await expect(adminPage).toHaveURL(/\/admin\/users$/); // patient screens are not offered to admins

  await adminPage.getByLabel("Full name").fill("Dr. Kavya Iyer");
  await adminPage.getByLabel("New user's role").selectOption("doctor");
  await adminPage.getByLabel("Username").fill("dr.kavya");
  await adminPage.getByLabel("Temporary password").fill("kavya-temp-1");
  await adminPage.getByRole("button", { name: "Add" }).click();
  await expect(adminPage.getByText("Added Dr. Kavya Iyer")).toBeVisible();
  const row = adminPage.locator(".user-row", { hasText: "dr.kavya" });
  await expect(row).toContainText("Dr. Kavya Iyer");
  await adminPage.screenshot({ path: "test-results/admin-staff.png", fullPage: true });

  // ---- the new doctor, on her own phone
  const doctorPage = await (await browser.newContext()).newPage();
  await signIn(doctorPage, "dr.kavya", "kavya-temp-1");
  await expect(doctorPage.locator(".role-chip")).toHaveText("Doctor");
  const queue = doctorPage.locator(".review-queue");
  await expect(queue).toContainText("Radha Kumari", { timeout: 15_000 });
  await expect(queue).toContainText("Fever for 2 days");
  await doctorPage.screenshot({ path: "test-results/doctor-home.png", fullPage: true });
  await queue.getByText("Radha Kumari").click();
  await expect(doctorPage.getByRole("heading", { name: /Case file · 2026-10-29/ })).toBeVisible();

  // ---- admin deactivates her; her next sync is refused
  adminPage.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Deactivate" }).click();
  await expect(row).toContainText("deactivated");
  await doctorPage.locator(".badge").click();
  await doctorPage.getByRole("button", { name: "Sync now" }).click();
  await expect(doctorPage.locator(".badge")).toHaveText("Sign in to sync", { timeout: 15_000 });

  // ---- the audit log shows the account changes
  await adminPage.getByRole("link", { name: "Audit log" }).click();
  await expect(adminPage.locator("tbody")).toContainText("Staff account added");
  await expect(adminPage.locator("tbody")).toContainText("Staff account changed");
  await adminPage.getByRole("button", { name: "Check integrity" }).click();
  await expect(adminPage.getByText(/✓ Intact: all \d+ entries verified/)).toBeVisible();
});

test("a health worker's home has no review queue or admin sections", async ({ page }) => {
  await signIn(page, "asha", "asha1234");
  await expect(page.locator(".role-chip")).toHaveText("Health worker");
  await expect(page.locator(".review-queue")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Audit log" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Staff" })).toHaveCount(0);
});
