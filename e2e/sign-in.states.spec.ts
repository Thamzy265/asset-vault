import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { secretFromUri, totpCode } from "../packages/db/test/support/totp.ts";
import { newLogin, PASSWORD } from "./support/accounts.ts";
import { BASE, Client, enrolledAccount, passwordOnlyAccount, signInClient, type Account } from "./support/api-client.ts";
import { psql } from "./support/admin.ts";

// Independent tester round for M1.3, UI states matrix (docs/ui/m1-3-sign-in.md): the states the
// developer's own sign-in.spec.ts does not automate. Every failed sign-in costs the shared rate-limit
// budget, so these specs use correct credentials and the API to reach each screen.
test.describe.configure({ mode: "parallel" });

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const wrongCode = (key: string) => (totpCode(key) === "000000" ? "111111" : "000000");

async function axe(page: Page, screen: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), screen).toEqual([]);
}

/** Signs the browser in through the API (cookies go into the browser's jar), then opens a page. */
async function browserSession(page: Page, account: Account): Promise<void> {
  const first = await page.request.post("/api/auth/sign-in", { data: { email: account.email, password: PASSWORD }, headers: { origin: BASE } });
  expect(first.status()).toBe(200);
  const code = [1, -1, 0].map((o) => totpCode(account.key, Date.now(), o)).find((c) => !account.spent.has(c));
  account.spent.add(code ?? "");
  const second = code
    ? await page.request.post("/api/auth/two-factor/totp", { data: { code }, headers: { origin: BASE } })
    : await page.request.post("/api/auth/two-factor/backup-code", { data: { code: account.backupCodes.shift() }, headers: { origin: BASE } });
  expect(second.status()).toBe(200);
}

async function uiSignIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/**
 * Walks every screen of the sign-in flow (UI spec flow diagram) with correct credentials and calls
 * `visit` on each state the matrix names: default, empty-submit errors, offline banner, notices, expired link.
 */
async function walk(page: Page, visit: (screen: string) => Promise<void>) {
  const account = await enrolledAccount("Walker Example");
  await page.context().clearCookies();

  await page.goto("/sign-in");
  await visit("sign in");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "There is a problem" })).toBeFocused();
  await visit("sign in: field errors");
  await page.context().setOffline(true);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("You're offline. Check your connection and try again.").first()).toBeVisible();
  await visit("sign in: offline banner");
  await page.context().setOffline(false);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Enter your code" })).toBeFocused();
  await visit("code");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: "There is a problem" })).toBeFocused();
  await visit("code: empty error");
  await page.getByRole("button", { name: "Use a backup code" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Use a backup code" })).toBeFocused();
  await visit("backup code");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: "There is a problem" })).toBeFocused();
  await visit("backup code: empty error");
  await page.getByLabel("Backup code").fill(account.backupCodes[0]!);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^Welcome, / })).toBeVisible();
  await expect(page.getByText(/You have 9 backup codes left/)).toBeVisible();
  await visit("home with backup-codes notice");

  await page.route("**/api/v1/me", (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"code":"internal_error","message":"x"}}' }));
  await page.reload();
  await expect(page.getByText("Something went wrong. Reload the page.")).toBeVisible();
  await visit("home: error");
  await page.unroute("**/api/v1/me");

  const { setupPath } = await newLogin("Setup Walker");
  await page.context().clearCookies();
  await page.goto(setupPath);
  await expect(page.getByRole("heading", { level: 2, name: /Step 1 of 3/ })).toBeVisible();
  await visit("setup: choose password");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "There is a problem" })).toBeFocused();
  await visit("setup: password errors");
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm new password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /Step 2 of 3/ })).toBeVisible();
  await visit("setup: authenticator");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("heading", { name: "There is a problem" })).toBeFocused();
  await visit("setup: authenticator error");
  const key = (await page.locator("#setup-key").textContent())!.trim();
  await page.getByLabel("6-digit code").fill(totpCode(key));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /Step 3 of 3/ })).toBeVisible();
  await visit("setup: backup codes");

  await page.goto("/setup");
  await expect(page.getByRole("heading", { level: 1, name: "This link has expired" })).toBeVisible();
  await visit("setup: expired link");
}

test("every screen reflows at 320 px with no sideways scroll, and every button, link-button and field is at least 44 px tall", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await walk(page, async (screen) => {
    const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(scroll, `${screen}: no sideways scrolling`).toBeLessThanOrEqual(client);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("button, input:not([type=checkbox]):not([type=hidden]), label.check")]
        .filter((el) => el.offsetParent !== null && !el.classList.contains("visually-hidden"))
        .map((el) => ({ name: el.textContent?.trim().slice(0, 30) || el.id || el.tagName, h: Math.round(el.getBoundingClientRect().height) }))
        .filter((x) => x.h < 44),
    );
    expect(small, `${screen}: targets under 44 px`).toEqual([]);
    const overflowing = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("main *, header *")].filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && el.offsetParent !== null).map((el) => el.tagName + (el.id ? `#${el.id}` : "")),
    );
    expect(overflowing, `${screen}: elements wider than the screen`).toEqual([]);
  });
});

test.describe("dark mode", () => {
  test.use({ colorScheme: "dark" });
  test("every screen and state is axe-clean (WCAG 2.2 AA) in the dark theme, including errors and the offline banner", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);
    await walk(page, async (screen) => {
      await axe(page, `dark: ${screen}`);
    });
  });
});

test("every screen is axe-clean in light mode too, in the states the developer's spec does not visit (empty-submit errors, offline banner, error notice)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await walk(page, async (screen) => {
    await axe(page, `light: ${screen}`);
  });
});

test("no animation anywhere (the spec allows only the focus ring), and none with reduced motion either", async ({ page }) => {
  for (const reduced of ["no-preference", "reduce"] as const) {
    await page.emulateMedia({ reducedMotion: reduced });
    let seen = 0;
    await walk(page, async (screen) => {
      seen++;
      const animations = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").map((a) => (a.effect as KeyframeEffect | null)?.target?.tagName ?? "?"));
      expect(animations, `${reduced}: ${screen}`).toEqual([]);
    });
    expect(seen).toBeGreaterThan(10);
  }
});

test("keyboard: the focus ring is visible and nothing covers the focused control on any screen at 320 px (WCAG 2.4.7, 2.4.11)", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await walk(page, async (screen) => {
    // Start from the top of the page and Tab through every stop until focus leaves the page content.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.evaluate(() => window.scrollTo(0, 0));
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      const state = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const r = el.getBoundingClientRect();
        const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
        const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
        const top = document.elementFromPoint(cx, cy);
        const style = getComputedStyle(el);
        return {
          name: el.textContent?.trim().slice(0, 30) || el.id || el.tagName,
          covered: !(top && (el === top || el.contains(top) || top.contains(el))),
          offscreen: r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth,
          ring: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2,
          fixed: [...document.querySelectorAll("*")].some((n) => ["fixed", "sticky"].includes(getComputedStyle(n).position)),
        };
      });
      if (!state) break;
      expect(state.covered, `${screen}: "${state.name}" is covered by another element`).toBe(false);
      expect(state.offscreen, `${screen}: "${state.name}" is outside the viewport`).toBe(false);
      expect(state.ring, `${screen}: "${state.name}" has no 2 px focus ring`).toBe(true);
      expect(state.fixed, `${screen}: a fixed or sticky element could cover focus`).toBe(false);
    }
  });
});

test("paste is allowed in every field on every screen (WCAG 3.3.8): no handler cancels a paste, and a pasted value arrives", async ({ page }) => {
  await walk(page, async (screen) => {
    const blocked = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement>("input:not([type=checkbox]):not([type=hidden])")].filter((input) => {
        const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
        input.dispatchEvent(event);
        const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
        input.dispatchEvent(drop);
        return event.defaultPrevented || drop.defaultPrevented || input.hasAttribute("onpaste") || input.getAttribute("autocomplete") === "off";
      }).map((i) => i.id),
    );
    expect(blocked, `${screen}: fields that block paste or turn autocomplete off`).toEqual([]);
  });
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").focus();
  await page.keyboard.insertText("pasted.person@example.org");
  await expect(page.getByLabel("Email")).toHaveValue("pasted.person@example.org");
});

test("each screen has exactly one h1 and a main landmark, and the sign-in step titles move focus so a screen reader announces them", async ({ page }) => {
  await walk(page, async (screen) => {
    expect(await page.getByRole("heading", { level: 1 }).count(), `${screen}: one h1`).toBe(1);
    expect(await page.getByRole("main").count(), `${screen}: one main landmark`).toBe(1);
    expect(await page.getByRole("link", { name: /create account|sign up|register/i }).count(), `${screen}: no sign-up link`).toBe(0);
  });
});

test("loading states: the sign-in, code and backup buttons say what they are doing, the fields stay readable but read-only, and a second click does nothing", async ({ page }) => {
  const account = await enrolledAccount();
  await page.context().clearCookies();
  let calls = 0;
  await page.route("**/api/auth/sign-in", async (route) => {
    calls++;
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  const busy = page.getByRole("button", { name: "Signing in…" });
  await expect(busy).toBeDisabled();
  await expect(page.getByLabel("Email")).toHaveAttribute("readonly", "");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("readonly", "");
  await busy.click({ force: true }).catch(() => {});
  await expect(page.getByRole("heading", { level: 1, name: "Enter your code" })).toBeVisible();
  expect(calls, "double submit").toBe(1);

  for (const [link, label, route] of [
    [null, "6-digit code", "**/api/auth/two-factor/totp"],
    ["Use a backup code", "Backup code", "**/api/auth/two-factor/backup-code"],
  ] as const) {
    if (link) await page.getByRole("button", { name: link }).click();
    await page.route(route, async (r) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await r.fulfill({ status: 401, contentType: "application/json", body: '{"error":{"code":"invalid_code","message":"x"}}' });
    });
    await page.getByLabel(label).fill("123456");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("button", { name: "Checking…" })).toBeDisabled();
    await expect(page.getByLabel(label)).toHaveAttribute("readonly", "");
    await expect(page.getByRole("button", { name: "Verify" })).toBeVisible();
    await page.unroute(route);
  }
});

test("loading states: the setup steps say 'Saving…' and 'Checking…', and the home page shows a skeleton and aria-busy until the name arrives", async ({ page }) => {
  const { setupPath } = await newLogin("Slow Setup");
  await page.route("**/api/auth/setup/password", async (r) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await r.continue();
  });
  await page.goto(setupPath);
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm new password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await expect(page.getByRole("heading", { level: 2, name: /Step 2 of 3/ })).toBeVisible();
  const key = (await page.locator("#setup-key").textContent())!.trim();
  await page.route("**/api/auth/setup/confirm", async (r) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await r.continue();
  });
  await page.getByLabel("6-digit code").fill(totpCode(key));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("button", { name: "Checking…" })).toBeDisabled();
  await expect(page.getByRole("heading", { level: 2, name: /Step 3 of 3/ })).toBeVisible();

  await page.route("**/api/v1/me", async (r) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await r.continue();
  });
  await page.goto("/");
  await expect(page.getByRole("main")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("img", { name: "Loading your name" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Slow Setup" })).toBeVisible();
  await expect(page.getByRole("main")).toHaveAttribute("aria-busy", "false");
});

test("offline: the banner shows on the code screen, the backup-code screen, setup step 1 and step 2, and the typed values are kept", async ({ page, context }) => {
  const account = await enrolledAccount();
  await page.context().clearCookies();
  await uiSignIn(page, account.email);
  await expect(page.getByRole("heading", { level: 1, name: "Enter your code" })).toBeVisible();
  const banner = page.getByRole("alert").filter({ hasText: "You're offline. Check your connection and try again." });
  await page.getByLabel("6-digit code").fill("123456");
  await context.setOffline(true);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(banner).toBeVisible();
  await expect(page.getByLabel("6-digit code")).toHaveValue("123456");
  await expect(page.getByRole("button", { name: "Verify" })).toBeEnabled();
  await page.getByRole("button", { name: "Use a backup code" }).click();
  await page.getByLabel("Backup code").fill("abcde-fghij");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(banner).toBeVisible();
  await expect(page.getByLabel("Backup code")).toHaveValue("abcde-fghij");
  await context.setOffline(false);

  const { setupPath } = await newLogin("Offline Setup");
  await page.context().clearCookies();
  await page.goto(setupPath);
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm new password").fill(PASSWORD);
  await context.setOffline(true);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(banner).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toHaveValue(PASSWORD);
  await context.setOffline(false);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /Step 2 of 3/ })).toBeVisible();
  const key = (await page.locator("#setup-key").textContent())!.trim();
  await page.getByLabel("6-digit code").fill(totpCode(key));
  await context.setOffline(true);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(banner).toBeVisible();
  await expect(page.getByLabel("6-digit code")).toHaveValue(totpCode(key));
  await context.setOffline(false);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /Step 3 of 3/ })).toBeVisible();
});

test("offline on the home page: signing out says you're offline and does NOT claim you are signed out; the session is still alive", async ({ page, context }) => {
  const account = await enrolledAccount("Offline Home");
  await browserSession(page, account);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Offline Home" })).toBeVisible();
  await context.setOffline(true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "You're offline. Check your connection and try again." })).toBeVisible();
  await expect(page).toHaveURL(`${BASE}/`);
  await context.setOffline(false);
  expect((await page.request.get("/api/v1/me")).status()).toBe(200);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByText("You're signed out.")).toBeVisible();
});

test("home: when /me can't be reached the offline banner shows, and the name placeholder is not left as a fake name", async ({ page }) => {
  const account = await enrolledAccount("Unreachable Me");
  await browserSession(page, account);
  await page.route("**/api/v1/me", (route) => route.abort("connectionfailed"));
  await page.goto("/");
  await expect(page.getByRole("alert").filter({ hasText: "You're offline. Check your connection and try again." })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).not.toContainText("Unreachable Me");
});

test("home: when /me answers 503 (database down) or 500 the error banner shows and the page stays, never a blank name or a redirect loop", async ({ page }) => {
  const account = await enrolledAccount("Status Walker");
  await browserSession(page, account);
  for (const [status, code] of [[503, "unavailable"], [500, "internal_error"]] as const) {
    await page.route("**/api/v1/me", (r) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code, message: "x" } }) }));
    await page.goto("/");
    await expect(page.getByText("Something went wrong. Reload the page.")).toBeVisible();
    await expect(page).toHaveURL(`${BASE}/`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("main")).toHaveAttribute("aria-busy", "false");
    await page.unroute("**/api/v1/me");
  }
});

test("BUG: when signing out fails (500) the person is told, instead of the page silently reloading with the session still alive", async ({ page }) => {
  const account = await enrolledAccount("Shared Computer");
  await browserSession(page, account);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Shared Computer" })).toBeVisible();
  await page.route("**/api/auth/sign-out", (r) => r.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"code":"internal_error","message":"x"}}' }));
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForTimeout(1500);
  expect((await page.request.get("/api/v1/me")).status(), "the session is still alive").toBe(200);
  expect(await page.getByText("You're signed out.").count(), "the page must not claim a sign-out that did not happen").toBe(0);
  // Every error says how to recover (UI spec, Copy). Today the page just reloads itself with no word.
  await expect(page.getByRole("alert").filter({ hasText: /couldn.?t|could not|went wrong|try again|failed|not signed out/i }), "the person is told the sign-out failed").toBeVisible();
});

test("BUG: when 'Sign out of all devices' fails (403) the person is told; the other devices are still signed in", async ({ page }) => {
  const account = await enrolledAccount("Lost Laptop");
  const other = await signInClient(account);
  await browserSession(page, account);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Lost Laptop" })).toBeVisible();
  await page.route("**/api/auth/sign-out-everywhere", (r) => r.fulfill({ status: 403, contentType: "application/json", body: '{"error":{"code":"forbidden","message":"x"}}' }));
  await page.getByRole("button", { name: "Sign out of all devices" }).click();
  await page.waitForTimeout(1500);
  expect((await other.get("/api/v1/me")).status, "the other device is still signed in").toBe(200);
  expect(await page.getByText("You're signed out.").count(), "the page must not claim every device is signed out").toBe(0);
  await expect(page.getByRole("alert").filter({ hasText: /couldn.?t|could not|went wrong|try again|failed|not signed out/i }), "the person is told the sign-out failed").toBeVisible();
});

test("after signing out, the Back button does not show the signed-in page again", async ({ page }) => {
  const account = await enrolledAccount("Back Button");
  await browserSession(page, account);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Back Button" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByText("You're signed out.")).toBeVisible();
  await page.goBack();
  await page.waitForTimeout(800);
  await expect(page.getByRole("heading", { level: 1, name: /^Welcome, / })).toHaveCount(0);
  expect((await page.request.get("/api/v1/me")).status()).toBe(401);
});

test("the signed-in page and the sign-in pages are not cacheable (no stale copy on a shared computer)", async ({ page }) => {
  const account = await enrolledAccount("Cache Check");
  await browserSession(page, account);
  for (const path of ["/", "/sign-in", "/setup"]) {
    const res = await page.request.get(path, { maxRedirects: 0 });
    expect(res.headers()["cache-control"] ?? "", path).toMatch(/no-store|no-cache|private/);
  }
  const me = await page.request.get("/api/v1/me");
  expect(me.headers()["cache-control"]).toContain("no-store");
});

test("already signed in, the sign-in page sends you home", async ({ page }) => {
  const account = await enrolledAccount("Already In");
  await browserSession(page, account);
  await page.goto("/sign-in");
  await expect(page).toHaveURL(`${BASE}/`);
});

test("long content: a 100-character name and a 254-character email don't break the home page or the sign-in field at 320 px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const longName = "W".repeat(40) + " " + "Ö".repeat(30) + "-" + "x".repeat(28);
  expect(longName.length).toBe(100);
  const account = await enrolledAccount(longName);
  await browserSession(page, account);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("WWWW");
  expect(await page.locator(".header-name").getAttribute("title"), "the header name carries the full name").toBe(longName);
  expect(await page.getByRole("heading", { level: 1 }).getAttribute("title")).toBe(`Welcome, ${longName}`);
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Sign out of all devices" })).toBeInViewport();
  await axe(page, "home with a long name");

  await page.context().clearCookies();
  await page.goto("/sign-in");
  const longEmail = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(55)}.org`;
  expect(longEmail.length).toBeLessThanOrEqual(254);
  await page.getByLabel("Email").fill(longEmail);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client);
});

test("the backup-codes notice counts down: '1 backup code left' (singular), then 'no backup codes left', and it shows once", async ({ page }) => {
  const account = await enrolledAccount("Few Codes");
  for (let i = 0; i < 8; i++) {
    const c = new Client();
    await c.post("/api/auth/sign-in", { email: account.email, password: PASSWORD });
    expect((await c.post("/api/auth/two-factor/backup-code", { code: account.backupCodes.shift() })).status).toBe(200);
  }
  await uiSignIn(page, account.email);
  await page.getByRole("button", { name: "Use a backup code" }).click();
  await page.getByLabel("Backup code").fill(account.backupCodes.shift()!);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("You have 1 backup code left. When you run low, ask your admin to reset your two-step sign-in.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Few Codes" })).toBeVisible();
  await expect(page.getByText(/backup code/)).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByText("You're signed out.")).toBeVisible();
  await uiSignIn(page, account.email);
  await page.getByRole("button", { name: "Use a backup code" }).click();
  await page.getByLabel("Backup code").fill(account.backupCodes.shift()!);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("You have no backup codes left. Ask your admin to reset your two-step sign-in.")).toBeVisible();
});

test("the code screen, after 10 wrong codes in a row, says 'Too many tries. Try again in N minutes.' with focus on the message, and a right code still doesn't get in", async ({ page }) => {
  const account = await enrolledAccount("Locked Out");
  for (let round = 0; round < 2; round++) {
    const c = new Client();
    await c.post("/api/auth/sign-in", { email: account.email, password: PASSWORD });
    for (let i = 0; i < 5; i++) await c.post("/api/auth/two-factor/totp", { code: wrongCode(account.key) });
  }
  await uiSignIn(page, account.email);
  await expect(page.getByRole("heading", { level: 1, name: "Enter your code" })).toBeVisible();
  await page.getByLabel("6-digit code").fill(totpCode(account.key, Date.now(), 1));
  await page.getByRole("button", { name: "Verify" }).click();
  const message = page.getByRole("alert").filter({ hasText: /^Too many tries\. Try again in (14|15) minutes\.$/ });
  await expect(message).toBeVisible();
  await expect(message).toBeFocused();
  await axe(page, "code: locked");
  await psql(`update auth_two_factors set locked_until = null, failed_verification_count = 0 where user_id = (select id from auth_users where email = '${account.email}')`);
});

test("error summary links move focus to the field they name, with the error read out through aria-describedby", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Enter your password" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("aria-describedby", /password-error/);
  await page.getByRole("link", { name: "Enter your email" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Email")).toBeFocused();
  await page.getByLabel("Email").fill("a@example.org");
  await page.getByLabel("Password", { exact: true }).fill("x");
  await page.getByRole("button", { name: "Sign in" }).click();
});

test("BUG: a pasted password longer than 128 characters is not silently cut: the person is told, instead of getting a password their password manager doesn't hold", async ({ page }) => {
  const { email, setupPath } = await newLogin("Long Paste");
  await page.goto(setupPath);
  const long = "Pw-" + "x7Q".repeat(46); // 141 characters, as a password manager can generate
  await page.getByLabel("New password", { exact: true }).focus();
  await page.keyboard.insertText(long);
  await page.getByLabel("Confirm new password").focus();
  await page.keyboard.insertText(long);
  await page.getByRole("button", { name: "Continue" }).click();
  // Either the field kept all 141 characters and the person is told the limit, or the next step must not have been reached with a shorter password.
  const step2 = page.getByRole("heading", { level: 2, name: /Step 2 of 3/ });
  await Promise.race([step2.waitFor({ timeout: 5000 }).catch(() => {}), page.getByRole("heading", { name: "There is a problem" }).waitFor({ timeout: 5000 }).catch(() => {})]);
  const reachedStep2 = await step2.isVisible();
  const stored = await page.getByLabel("New password", { exact: true }).inputValue().catch(() => "");
  if (reachedStep2) {
    const signIn = await new Client().post("/api/auth/sign-in", { email, password: long });
    expect(signIn.status, "the full pasted password does not sign in: it was cut to 128 characters without a word").toBe(200);
  } else {
    expect(stored.length === long.length || stored.length === 0).toBe(true);
    await expect(page.getByText(/128/)).toBeVisible();
  }
});

test("a person who set a password and left can sign in, resumes at the authenticator step with a key that works, and finishes setup", async ({ page }) => {
  const half = await passwordOnlyAccount("Resume Me");
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(half.email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Step 2 of 3: Set up your authenticator app" })).toBeVisible();
  const key = (await page.locator("#setup-key").textContent())!.trim();
  expect(secretFromUri(`otpauth://totp/x?secret=${key}`)).toBe(key);
  await page.getByLabel("6-digit code").fill(totpCode(key));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /Step 3 of 3/ })).toBeVisible();
  await page.getByLabel("I've saved these codes").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Resume Me" })).toBeVisible();
});

test("BUG: if the setup link can't be checked because the connection drops on first load, a reload gets the person back to step 1, not 'This link has expired'", async ({ page }) => {
  const { setupPath } = await newLogin("Flaky Signal");
  let first = true;
  await page.route("**/api/auth/setup/check", (route) => {
    if (first) {
      first = false;
      return route.abort("connectionfailed");
    }
    return route.continue();
  });
  await page.goto(setupPath);
  await expect(page.getByText("You're offline. Check your connection and try again.").first()).toBeVisible();
  // "Try again": the connection is back and the person reloads the page they are on.
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "Step 1 of 3: Choose a password" }), "the link is still valid on the server, but the reload shows the expired screen").toBeVisible();
});

test("keyboard only through the whole first-time setup: password, show/hide toggle, authenticator code, backup codes, tick box, home", async ({ page }) => {
  const { setupPath } = await newLogin("Keys Only");
  await page.goto(setupPath);
  await expect(page.getByRole("heading", { level: 2, name: /Step 1 of 3/ })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("New password", { exact: true })).toBeFocused();
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Confirm new password")).toBeFocused();
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press("Tab");
  const toggle = page.getByRole("button", { name: "Show password" });
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("New password", { exact: true })).toHaveAttribute("type", "text");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Continue" })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { level: 2, name: /Step 2 of 3/ })).toBeFocused();
  const key = (await page.locator("#setup-key").textContent())!.trim();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Copy key" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("6-digit code")).toBeFocused();
  await page.keyboard.type(totpCode(key));
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { level: 2, name: /Step 3 of 3/ })).toBeFocused();
  const proceed = page.getByRole("button", { name: "Continue" });
  await expect(proceed).toBeDisabled();
  for (const name of ["Copy all", "Download as text"]) {
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name })).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("I've saved these codes")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(proceed).toBeEnabled();
  await page.keyboard.press("Tab");
  await expect(proceed).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Keys Only" })).toBeVisible();
  // And out again, by keyboard: both sign-out buttons are in the tab order after the name.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Sign out of all devices" })).toBeFocused();
});
