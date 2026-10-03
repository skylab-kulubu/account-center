import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { csrfTokenFor, noticeDismissalsOf, seedAuthenticatedSession } from "./auth-session";

/**
 * K4c in the browser: a person whose Primary e-mail is the School e-mail is
 * nudged on the overview and on `/email` to make a proven Personal e-mail
 * primary or to add one. The e-mail read and the existing e-mail and Sudo
 * mode routes are answered by `page.route` in the BFF's shapes (their
 * handlers are unit-tested); the dismissal goes to the real BFF route and
 * lands in the test database.
 */

const baseUrl = "https://127.0.0.1:3100";
const sessionCookieName = "__Host-sky-account";
const sudoPassword = "hunter2-correct-horse-staple";
const schoolEmail = "ada@std.yildiz.edu.tr";
const personalEmail = "ada.lovelace@example.com";
const nudgeTitle = "Mezun olunca okul postan kapanabilir";

type EmailState = {
  email: string | null;
  emailVerified: boolean;
  primary: "school" | "personal" | "none";
  schoolEmail: string | null;
  verifiedYtu: boolean;
  personalEmail: string | null;
  personalEmailVerified: boolean;
  primaryEmailNudge: "make-personal-primary" | "add-personal" | null;
};

const schoolPrimaryWithPersonal: EmailState = {
  email: schoolEmail,
  emailVerified: true,
  primary: "school",
  schoolEmail,
  verifiedYtu: true,
  personalEmail,
  personalEmailVerified: true,
  primaryEmailNudge: "make-personal-primary",
};

async function installAuthenticatedSession(context: BrowserContext, label: string) {
  const fixture = await seedAuthenticatedSession(label);
  await context.addCookies([{
    name: sessionCookieName,
    value: fixture.handle,
    url: baseUrl,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    expires: Math.floor(Date.now() / 1_000) + 8 * 60 * 60,
  }]);
  return { ...fixture, csrfToken: csrfTokenFor(fixture.sessionId) };
}

async function mockEmail(page: Page, state: EmailState, csrfToken: string) {
  await page.route("**/api/account/email", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { ...state, csrfToken } });
  });
  await page.route("**/api/account/email/pending", (route) => route.fulfill({ json: { pending: null } }));
}

/** The overview's own read (`GET /api/account/email/nudge`), derived from the same record. */
async function mockOverviewNudge(page: Page, state: EmailState, csrfToken: string) {
  await page.route("**/api/account/email/nudge", (route) => route.fulfill({
    json: state.primaryEmailNudge === null
      ? { primaryEmailNudge: null }
      : {
          primaryEmailNudge: state.primaryEmailNudge,
          personalEmail: state.primaryEmailNudge === "make-personal-primary" ? state.personalEmail : null,
          csrfToken,
        },
  }));
}

async function mockSudo(page: Page, csrfToken: string) {
  await page.route("**/api/account/sudo/methods", (route) => route.fulfill({
    json: { methods: ["password"], fallback: null, active: null, csrfToken },
  }));
  await page.route("**/api/account/sudo/password", (route) => route.fulfill({
    json: { method: "password", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() },
  }));
}

/** The 4xx answers below are deliberate (the Sudo mode challenge); the browser logs them as resource errors. */
function failOnPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of 428/.test(message.text())) errors.push(message.text());
  });
  return errors;
}

async function expectAccessible(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
}

test("on /email the nudge preselects the personal address and saving still runs Sudo mode", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name === "reduced-motion", "covered by desktop and mobile");
  const { csrfToken } = await installAuthenticatedSession(context, `nudge-primary-${testInfo.project.name}-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  const state: EmailState = { ...schoolPrimaryWithPersonal };
  await mockEmail(page, state, csrfToken);
  await mockSudo(page, csrfToken);
  const primaryCalls: unknown[] = [];
  await page.route("**/api/account/email/primary", async (route) => {
    primaryCalls.push(route.request().postDataJSON());
    if (primaryCalls.length === 1) {
      await route.fulfill({ status: 428, json: { error: "sudo_required", reason: "missing", methods: ["password"], fallback: null } });
      return;
    }
    Object.assign(state, { primary: "personal", email: personalEmail, primaryEmailNudge: null });
    await route.fulfill({ status: 204 });
  });

  await page.goto("/email");
  const nudge = page.getByRole("region", { name: nudgeTitle });
  await expect(nudge).toBeVisible();
  await expect(nudge).toContainText(personalEmail);
  await expectAccessible(page);

  await nudge.getByRole("button", { name: "Kişisel adresi birincil yap" }).click();
  const group = page.getByRole("group", { name: "Birincil e-posta" });
  await expect(group.getByRole("radio", { name: /Kişisel e-posta/ })).toBeChecked();
  const save = page.getByRole("button", { name: "Birincil adresi kaydet" });
  await expect(save).toBeFocused();
  await expect(save).toBeInViewport();
  expect(primaryCalls).toEqual([]);

  await save.click();
  const dialog = page.getByRole("dialog", { name: "Kimliğini doğrula" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Parola" }).fill(sudoPassword);
  await dialog.getByRole("button", { name: "Doğrula" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Birincil adresin güncellendi" })).toBeVisible();
  await expect(nudge).toHaveCount(0);
  expect(primaryCalls).toEqual([{ which: "personal" }, { which: "personal" }]);
  expect(errors).toEqual([]);
});

test("on the overview the nudge links into the add form of /email", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name === "reduced-motion", "covered by desktop and mobile");
  const { csrfToken } = await installAuthenticatedSession(context, `nudge-add-${testInfo.project.name}-${testInfo.retry}`);
  const state: EmailState = {
    ...schoolPrimaryWithPersonal,
    personalEmail: null,
    personalEmailVerified: false,
    primaryEmailNudge: "add-personal",
  };
  await mockEmail(page, state, csrfToken);
  await mockOverviewNudge(page, state, csrfToken);

  await page.goto("/");
  const nudge = page.getByRole("region", { name: nudgeTitle });
  await expect(nudge).toBeVisible();
  await expectAccessible(page);
  await nudge.getByRole("link", { name: "Kişisel adres ekle" }).click();

  const form = page.getByRole("form", { name: "Kişisel e-posta ekle" });
  await expect(form).toBeVisible();
  await expect(form.getByLabel("E-posta adresi")).toBeFocused();
  await expect(page).toHaveURL(`${baseUrl}/email`);
});

test("\"Bir daha gösterme\" stores the dismissal for the person through the real BFF route", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only: writes the shared test database");
  const { csrfToken, subject } = await installAuthenticatedSession(context, `nudge-dismiss-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  await mockOverviewNudge(page, { ...schoolPrimaryWithPersonal }, csrfToken);

  await page.goto("/");
  const nudge = page.getByRole("region", { name: nudgeTitle });
  await expect(nudge).toBeVisible();
  const answer = page.waitForResponse((response) => response.url().endsWith("/api/account/email/nudge/dismiss"));
  await nudge.getByRole("button", { name: "Bir daha gösterme" }).click();
  expect((await answer).status()).toBe(204);

  const status = page.getByText("Bu öneriyi bir daha göstermeyeceğiz.", { exact: false });
  await expect(status).toBeVisible();
  await expect(status).toBeFocused();
  await expect(nudge).toHaveCount(0);
  expect(await noticeDismissalsOf(subject)).toEqual(["make-personal-primary"]);
  expect(errors).toEqual([]);
});
