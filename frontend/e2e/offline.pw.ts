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

  // Reload with no network: the service worker serves the app shell, and patient data
  // stays encrypted until the password is entered (unlocking works offline).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Locked" })).toBeVisible();
  await expect(page.getByText("Kamla Bai")).toBeHidden();
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Invalid username or password")).toBeVisible();
  await page.getByLabel("Password").fill("asha1234");
  await page.getByRole("button", { name: "Unlock" }).click();
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

  // Both devices go offline and edit the same patient: village on both (a real clash),
  // phone only on A and age only on B (these must merge without asking anyone).
  await ctxA.setOffline(true);
  await ctxB.setOffline(true);
  await edit(a, { Village: "Kheri Kalan", Phone: "9000000001" });
  await edit(b, { Village: "Kheri Khurd", "Age (years)": "33" });

  await ctxA.setOffline(false);
  await expect(badge(a)).toHaveText("Synced", { timeout: 15_000 });
  await ctxB.setOffline(false);
  await expect(badge(b)).toHaveText("Conflict · 1", { timeout: 15_000 });
  await expect(b.getByText("changed on another device")).toBeVisible();

  await badge(b).click();
  await expect(b.locator(".conflict")).toContainText("1 field needs a decision, 2 merge automatically");
  await b.getByRole("link", { name: "Review & resolve" }).click();

  const village = b.getByRole("radiogroup", { name: "Village" });
  await expect(village).toContainText("Kheri Khurd");
  await expect(village).toContainText("Kheri Kalan");
  const apply = b.getByRole("button", { name: "Apply merge" });
  await expect(apply).toBeDisabled(); // the clash must be decided first
  await expect(b.getByText("Merged automatically (2)")).toBeVisible();
  await village.getByText("This device").click();
  await b.screenshot({ path: "test-results/conflict-resolver.png", fullPage: true });
  await apply.click();
  await expect(badge(b)).toHaveText("Synced", { timeout: 15_000 });

  // The decision is visible from the server's audit log.
  await expect(b.locator(".resolved-item").first()).toContainText("village: this device");
  await expect(b.locator(".resolved-item").first()).toContainText("phone: server");

  // Device A receives the merged record: B's village and age, A's phone.
  await syncNow(a);
  await a.getByText("Ravi Shankar").click();
  await expect(a.getByLabel("Village")).toHaveValue("Kheri Khurd");
  await expect(a.getByLabel("Phone")).toHaveValue("9000000001");
  await expect(a.getByLabel("Age (years)")).toHaveValue("33");
});

async function edit(page: Page, fields: Record<string, string>) {
  await page.getByRole("button", { name: "Edit" }).click();
  for (const [label, value] of Object.entries(fields)) await page.getByLabel(label).fill(value);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
}

async function syncNow(page: Page) {
  await badge(page).click();
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(badge(page)).toHaveText("Synced", { timeout: 15_000 });
  await page.getByRole("link", { name: "HCare" }).click();
}
