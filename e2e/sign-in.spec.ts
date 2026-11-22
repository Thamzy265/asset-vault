import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { secretFromUri, totpCode } from "../packages/db/test/support/totp.ts";
import { deactivate, newLogin, PASSWORD } from "./support/accounts.ts";

// M1.3 sign-in with mandatory 2FA, on the running stack: the UI spec's flows and states
// (docs/ui/m1-3-sign-in.md), WCAG 2.2 AA with axe on every screen, 320 px reflow.
// TOTP codes are computed in the test from the enrolled key, as a phone would.
test.describe.configure({ mode: "parallel" });

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function axe(page: Page, screen: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), screen).toEqual([]);
}

async function noSidewaysScroll(page: Page, screen: string) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, `${screen}: no sideways scrolling`).toBeLessThanOrEqual(client);
}

/** Different from the current code, so it is always wrong. */
const wrongCode = (secret: string) => (totpCode(secret) === "000000" ? "111111" : "000000");

/** Follows a setup link through steps 1-3 to home. Returns the key and the backup codes. */
async function setUp(page: Page, setupPath: string, checks: (screen: string) => Promise<void> = async () => {}) {
  await page.goto(setupPath);
  await expect(page.getByRole("heading", { level: 2, name: "Step 1 of 3: Choose a password" })).toBeVisible();
  await expect(page).toHaveURL(/\/setup$/); // the token leaves the address bar at once
  await checks("setup: choose password");
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm new password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { level: 2, name: "Step 2 of 3: Set up your authenticator app" })).toBeVisible();
  await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  await checks("setup: authenticator");
  const key = (await page.locator("#setup-key").textContent())!.trim();
  await page.getByLabel("6-digit code").fill(totpCode(key));
  await page.getByRole("button", { name: "Verify and continue" }).click();

  await expect(page.getByRole("heading", { level: 2, name: "Step 3 of 3: Save your backup codes" })).toBeVisible();
  await checks("setup: backup codes");
  const codes = (await page.getByRole("list", { name: "Backup codes" }).getByRole("listitem").allTextContents()).map((c) => c.trim());
  expect(codes).toHaveLength(10);
  const proceed = page.getByRole("button", { name: "Continue" });
  await expect(proceed).toBeDisabled();
  await page.getByLabel("I've saved these codes").check();
  await proceed.click();
  await expect(page.getByRole("heading", { level: 1, name: /^Welcome, / })).toBeVisible();
  return { key, codes };
}

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("first-time setup via the setup link, every step axe-clean, at 320 px and on desktop", async ({ page }) => {
  const { setupPath } = await newLogin("Ada Lovelace", "admin");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 320, height: 800 });
  await setUp(page, setupPath, async (screen) => {
    await axe(page, screen);
    await noSidewaysScroll(page, screen);
    if (screen === "setup: backup codes") {
      await page.getByRole("button", { name: "Copy all" }).click();
      await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
      await expect(page.getByText("Copied to clipboard")).toBeAttached();
      expect((await page.evaluate(() => navigator.clipboard.readText())).split("\n")).toHaveLength(10);
      const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download as text" }).click()]);
      expect(download.suggestedFilename()).toBe("family-asset-vault-backup-codes.txt");
    }
  });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome, Ada Lovelace");
  await axe(page, "home");
  await noSidewaysScroll(page, "home");
  const me = await page.request.get("/api/v1/me");
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({ name: "Ada Lovelace", role: "admin", id: expect.any(String), personId: expect.any(String) });
});

test("setup: field errors, a too-common password and a wrong code each say how to recover", async ({ page }) => {
  const { setupPath } = await newLogin();
  await page.goto(setupPath);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "There is a problem" })).toBeFocused();
  await expect(page.getByRole("link", { name: "Use at least 12 characters" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Passwords don't match" })).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toHaveAttribute("aria-describedby", /new-password-error/);
  await axe(page, "setup: errors");

  await page.getByLabel("New password", { exact: true }).fill("password1234");
  await page.getByLabel("Confirm new password").fill("password1234");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("This password is too common — choose another").first()).toBeVisible();

  const toggle = page.getByRole("button", { name: "Show password" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("New password", { exact: true })).toHaveAttribute("type", "text");

  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm new password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  const key = (await page.locator("#setup-key").textContent())!.trim();
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("link", { name: "Enter the code your app shows" })).toBeVisible();
  await page.getByLabel("6-digit code").fill(wrongCode(key));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("link", { name: "That code is not right. Check your phone's time is set automatically." })).toBeVisible();
});

test("a used, made-up or missing setup link shows the expired screen, with no sign-up anywhere", async ({ page }) => {
  const { setupPath } = await newLogin();
  await setUp(page, setupPath);
  for (const p of [setupPath, "/setup#made-up", "/setup"]) {
    await page.context().clearCookies();
    await page.goto("/sign-in");
    await page.goto(p);
    await expect(page.getByRole("heading", { level: 1, name: "This link has expired" }), p).toBeVisible();
    await expect(page.getByText("This setup link has expired or was already used. Ask your admin for a new one.")).toBeVisible();
    await expect(page.getByRole("link")).toHaveCount(0);
  }
  await axe(page, "setup: expired link");
  await page.goto("/sign-in");
  await expect(page.getByText(/create account|sign up/i)).toHaveCount(0);
});

test("daily sign-in with a code, sign out, then a backup code with the codes-left notice, then sign out of all devices", async ({ page, browser }) => {
  const { email, setupPath } = await newLogin("Bea Example");
  const { key, codes } = await setUp(page, setupPath);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in\?reason=signed-out$/);
  await expect(page.getByText("You're signed out.")).toBeVisible();
  expect((await page.request.get("/api/v1/me")).status()).toBe(401);

  await axe(page, "sign in");
  await signIn(page, email);
  await expect(page.getByRole("heading", { level: 1, name: "Enter your code" })).toBeFocused();
  await expect(page.getByText("Open your authenticator app and enter the 6-digit code for Family Asset Vault.")).toBeVisible();
  const code = page.getByLabel("6-digit code");
  await expect(code).toHaveAttribute("inputmode", "numeric");
  await expect(code).toHaveAttribute("autocomplete", "one-time-code");
  await axe(page, "code");
  await code.fill(totpCode(key, Date.now(), 1)); // the current step was used by setup (a code works once)
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Bea Example" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in\?reason=signed-out$/);

  await signIn(page, email);
  await page.getByRole("button", { name: "Use a backup code" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Use a backup code" })).toBeVisible();
  await axe(page, "backup code");
  await page.getByRole("button", { name: "Use your authenticator app instead" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Enter your code" })).toBeVisible();
  await page.getByRole("button", { name: "Use a backup code" }).click();
  await page.getByLabel("Backup code").fill(codes[0]!);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("You have 9 backup codes left. When you run low, ask your admin to reset your two-step sign-in.")).toBeVisible();

  // A second device, then "Sign out of all devices" ends both.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signIn(otherPage, email);
  await otherPage.getByLabel("6-digit code").fill(totpCode(key, Date.now(), -1)); // the other two steps were used already (a code works once)
  await otherPage.getByRole("button", { name: "Verify" }).click();
  await expect(otherPage.getByRole("heading", { level: 1, name: "Welcome, Bea Example" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out of all devices" }).click();
  await expect(page.getByText("You're signed out.")).toBeVisible();
  await otherPage.reload();
  await expect(otherPage).toHaveURL(/\/sign-in\?reason=ended$/);
  await expect(otherPage.getByText("Your session ended. Please sign in again.")).toBeVisible();
  expect((await otherPage.request.get("/api/v1/me")).status()).toBe(401);
  await other.close();
});

test("sign in: empty fields, a wrong password, then the rate limit, with focus on the message", async ({ page }) => {
  const { email, setupPath } = await newLogin();
  await setUp(page, setupPath);
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "There is a problem" })).toBeFocused();
  await expect(page.getByRole("link", { name: "Enter your email" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Enter your password" })).toBeVisible();
  await axe(page, "sign in: field errors");

  for (let i = 0; i < 5; i++) {
    await signIn(page, email, `wrong password ${i}`);
    await expect(page.getByRole("alert").filter({ hasText: "Email or password is not right." })).toBeFocused();
  }
  await signIn(page, email);
  await expect(page.getByRole("alert").filter({ hasText: /^Too many tries\. Try again in 15 minutes\.$/ })).toBeVisible();
});

test("5 wrong codes send you back to sign in with 'Please sign in again.'", async ({ page }) => {
  const { email, setupPath } = await newLogin();
  const { key } = await setUp(page, setupPath);
  await page.context().clearCookies();
  await signIn(page, email);
  for (let i = 0; i < 5; i++) {
    await page.getByLabel("6-digit code").fill(wrongCode(key));
    await page.getByRole("button", { name: "Verify" }).click();
    if (i < 4) await expect(page.getByRole("link", { name: "That code is not right. Codes change every 30 seconds — try the newest one." })).toBeVisible();
  }
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expect(page.getByText("Please sign in again.")).toBeVisible();
});

test("a deactivated user is refused on the next request and the home page says the session ended", async ({ page }) => {
  const { email, setupPath } = await newLogin();
  await setUp(page, setupPath);
  await deactivate(email);
  await page.reload();
  await expect(page.getByText("Your session ended. Please sign in again.")).toBeVisible();
  expect((await page.request.get("/api/v1/me")).status()).toBe(401);
});

test("password-only session (setup abandoned after step 1): the API says 2fa_required; the password alone does not resume setup, the link does", async ({ page }) => {
  const { email, setupPath } = await newLogin("Cy Example");
  await page.goto(setupPath);
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm new password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /Step 2 of 3/ })).toBeVisible();
  const firstKey = (await page.locator("#setup-key").textContent())!.trim();
  const me = await page.request.get("/api/v1/me");
  expect(me.status()).toBe(403);
  expect(await me.json()).toEqual({ error: { code: "2fa_required", message: expect.any(String) } });
  await page.goto("/");
  await expect(page.getByText("Please sign in again.")).toBeVisible();
  // The password alone gets no secret and does not resume setup (lead decision 5).
  await signIn(page, email);
  const unfinished = page.getByRole("alert").filter({ hasText: "Your account setup isn't finished. Open your setup link again, or ask your admin for a new one." });
  await expect(unfinished).toBeVisible();
  await expect(unfinished).toBeFocused();
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);
  await expect(page.locator("#setup-key")).toHaveCount(0);
  await axe(page, "sign in: setup not finished");
  // The link still works and resumes at step 2, with a new key.
  await page.goto(setupPath);
  await expect(page.getByRole("heading", { level: 2, name: "Step 2 of 3: Set up your authenticator app" })).toBeVisible();
  const key = (await page.locator("#setup-key").textContent())!.trim();
  expect(secretFromUri(`otpauth://totp/x?secret=${key}`)).toBe(key);
  expect(key).not.toBe(firstKey);
});

test("offline: the banner appears and nothing is lost", async ({ page, context }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("someone@example.org");
  await page.getByLabel("Password", { exact: true }).fill("whatever password");
  await context.setOffline(true);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("You're offline. Check your connection and try again.").first()).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveValue("someone@example.org");
  await context.setOffline(false);
});

test("keyboard only, and pasting a code works (WCAG 3.3.8)", async ({ page, context }) => {
  const { email, setupPath } = await newLogin();
  const { key } = await setUp(page, setupPath);
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email")).toBeFocused();
  await page.keyboard.type(email);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Enter your code" })).toBeFocused();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate((c) => navigator.clipboard.writeText(c), totpCode(key, Date.now(), 1)); // the current step was used by setup (a code works once)
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("6-digit code")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+V");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: /^Welcome, / })).toBeVisible();
});

test("the password fields tell password managers what they are", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "email");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("autocomplete", "current-password");
  const { setupPath } = await newLogin();
  await page.goto(setupPath);
  await expect(page.getByLabel("New password", { exact: true })).toHaveAttribute("autocomplete", "new-password");
  await expect(page.getByLabel("Confirm new password")).toHaveAttribute("autocomplete", "new-password");
});
