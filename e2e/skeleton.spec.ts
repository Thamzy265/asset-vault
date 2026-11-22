import { expect, test } from "@playwright/test";

test("health endpoint reports ok with the database up", async ({ request }) => {
  const res = await request.get("/api/v1/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ status: "ok", db: "ok" });
  expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
});

// M1.3: the home page needs a signed-in user; without one it sends you to sign in.
test("home page sends a signed-out visitor to sign in, under the app title", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page).toHaveTitle("Family Asset Vault");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
});
