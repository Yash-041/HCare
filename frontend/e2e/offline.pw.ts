import { expect, test, type BrowserContext, type Page } from "@playwright/test";

async function signIn(page: Page, username: string, password: string) {
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

/** First visit installs the service worker; a reload puts the page under its control. */
async function openControlledApp(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  return page;
}

async function addPatient(page: Page, name: string, village: string) {
  await page.getByRole("link", { name: "+ New patient" }).click();
  await page.getByLabel("Full name *").fill(name);
  await page.getByLabel("Village").fill(village);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

const badge = (page: Page) => page.locator(".badge");

test("offline capture survives a reload and an offline sign-in, then syncs on reconnect", async ({ context }) => {
  const page = await openControlledApp(context);
  await signIn(page, "asha", "asha1234");
  await expect(badge(page)).toHaveText("Synced");

  await context.setOffline(true);
  await expect(badge(page)).toHaveText(/Offline/);
  await addPatient(page, "Kamla Bai", "Rampur");
  await expect(badge(page)).toHaveText("Offline · 1 pending");

  // Reload with no network: the service worker must serve the app shell.
  await page.reload();
  await expect(page.locator(".chip")).toHaveText("Pending");

  // Sign out and back in while still offline.
  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn(page, "asha", "asha1234");
  await expect(page.getByText("Kamla Bai")).toBeVisible();

  await context.setOffline(false);
  await expect(badge(page)).toHaveText("Synced", { timeout: 15_000 });
  await expect(page.locator(".list-item", { hasText: "Kamla Bai" }).locator(".chip")).toHaveText("Synced");
});

test("concurrent offline edits on two devices raise a conflict that the user resolves", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await openControlledApp(ctxA);
  const b = await openControlledApp(ctxB);
  await signIn(a, "asha", "asha1234");
  await signIn(b, "doctor", "doctor123");

  await addPatient(a, "Ravi Shankar", "Kheri");
  await expect(badge(a)).toHaveText("Synced", { timeout: 15_000 });

  await syncNow(b);
  await b.getByText("Ravi Shankar").click();
  await a.getByText("← Patients").click();
  await a.getByText("Ravi Shankar").click();

  // Both devices go offline and edit the same patient.
  await ctxA.setOffline(true);
  await ctxB.setOffline(true);
  await editVillage(a, "Kheri Kalan");
  await editVillage(b, "Kheri Khurd");

  await ctxA.setOffline(false);
  await expect(badge(a)).toHaveText("Synced", { timeout: 15_000 });
  await ctxB.setOffline(false);
  await expect(badge(b)).toHaveText("Conflict · 1", { timeout: 15_000 });
  await expect(b.getByText("changed on another device")).toBeVisible();

  await badge(b).click();
  const row = b.locator("tr", { hasText: "village" });
  await expect(row).toContainText("Kheri Khurd");
  await expect(row).toContainText("Kheri Kalan");
  await b.getByRole("button", { name: "Keep mine" }).click();
  await expect(badge(b)).toHaveText("Synced", { timeout: 15_000 });

  // Device A receives the resolved version.
  await syncNow(a);
  await a.getByText("Ravi Shankar").click();
  await expect(a.getByLabel("Village")).toHaveValue("Kheri Khurd");
});

async function syncNow(page: Page) {
  await badge(page).click();
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(badge(page)).toHaveText("Synced", { timeout: 15_000 });
  await page.getByRole("link", { name: "HCare" }).click();
}

async function editVillage(page: Page, village: string) {
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Village").fill(village);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
}
