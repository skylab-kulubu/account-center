import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { csrfTokenFor, seedAuthenticatedSession } from "./auth-session";

/**
 * SkyMail no longer mails one of the person's addresses (rabbitmq-olaylar 10
 * and 14): the overview shows one line linking to `/email`, where the
 * address's row carries "Bu adrese posta ulaşmıyor.". The first test goes
 * through the real BFF: the mock serves SkyMail's `GET /v1/me/email-delivery`
 * for the session's `aud skymail` token and, for a `realm-` subject, the
 * realm's sky-account identity the BFF matches the addresses against. The
 * overview test answers the BFF reads with `page.route`, like the K4c nudge's
 * (the overview's server-side Account REST read would leave for the real
 * realm with a contract-shaped token).
 */

const baseUrl = "https://127.0.0.1:3100";
const mockCoreUrl = `https://127.0.0.1:${process.env.E2E_MOCK_CORE_PORT ?? "3101"}`;
const sessionCookieName = "__Host-sky-account";
const warning = "Bu adrese posta ulaşmıyor.";
/** The addresses of `tests/fixtures/sky-account-v1-identity.json`. */
const schoolEmail = "ada@std.yildiz.edu.tr";
const personalEmail = "ada-personal@example.invalid";

async function addSessionCookie(context: BrowserContext, handle: string) {
  await context.addCookies([{
    name: sessionCookieName,
    value: handle,
    url: baseUrl,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    expires: Math.floor(Date.now() / 1_000) + 8 * 60 * 60,
  }]);
}

async function expectAccessible(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
}

test("/email names the address SkyMail no longer mails, read through the real BFF", async ({ context, page, playwright }, testInfo) => {
  test.skip(testInfo.project.name === "reduced-motion", "covered by desktop and mobile");
  const fixture = await seedAuthenticatedSession(
    `realm-email-delivery-${testInfo.project.name}-${testInfo.retry}`,
    { contractToken: true, skymailAudience: true },
  );
  await addSessionCookie(context, fixture.handle);
  const mock = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const set = await mock.put(`${mockCoreUrl}/__e2e/email-delivery/${encodeURIComponent(fixture.subject)}`, {
      data: {
        undeliverable: [
          { address: personalEmail, since: "2026-10-25T09:00:00Z" },
          // A former address SkyMail still finds by the person's `sub`: no longer theirs, no warning.
          { address: "ada-old@example.invalid", since: "2026-09-01T09:00:00Z" },
        ],
      },
    });
    expect(set.status()).toBe(200);
    await page.route("**/api/account/email/pending", (route) => route.fulfill({ json: { pending: null } }));

    await page.goto("/email");
    const personal = page.getByRole("group", { name: personalEmail });
    await expect(personal).toBeVisible();
    await expect(personal).toHaveAccessibleDescription(warning);
    await expect(page.getByText(warning)).toHaveCount(1);
    await expect(page.getByRole("group", { name: schoolEmail })).toHaveCount(0);
    await expectAccessible(page);

    // The overview's own read, from the page (the session cookie): only the kind, never SkyMail's address or date.
    const overview = await page.evaluate(async () => {
      const response = await fetch("/api/account/email/delivery", { cache: "no-store", credentials: "same-origin" });
      return { status: response.status, cacheControl: response.headers.get("cache-control"), body: await response.text() };
    });
    expect(overview.status).toBe(200);
    expect(overview.cacheControl).toBe("no-store");
    expect(JSON.parse(overview.body)).toEqual({ undeliverable: ["personal"] });
    expect(overview.body).not.toMatch(/@|2026/);
    expect(errors).toEqual([]);
  } finally {
    await mock.dispose();
  }
});

test("the overview's line links to /email, where the address carries the warning", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name === "reduced-motion", "covered by desktop and mobile");
  const fixture = await seedAuthenticatedSession(`email-delivery-overview-${testInfo.project.name}-${testInfo.retry}`);
  await addSessionCookie(context, fixture.handle);
  const csrfToken = csrfTokenFor(fixture.sessionId);
  await page.route("**/api/account/email/delivery", (route) => route.fulfill({ json: { undeliverable: ["primary", "school"] } }));
  await page.route("**/api/account/email/nudge", (route) => route.fulfill({ json: { primaryEmailNudge: null } }));
  await page.route("**/api/account/email", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        email: schoolEmail,
        emailVerified: true,
        primary: "school",
        schoolEmail,
        verifiedYtu: true,
        personalEmail,
        personalEmailVerified: true,
        csrfToken,
        primaryEmailNudge: null,
        undeliverable: ["primary", "school"],
      },
    });
  });
  await page.route("**/api/account/email/pending", (route) => route.fulfill({ json: { pending: null } }));

  await page.goto("/");
  const line = page.getByRole("link", { name: "Bir e-posta adresine posta ulaşmıyor." });
  await expect(line).toBeVisible();
  await expectAccessible(page);

  await line.click();
  await expect(page).toHaveURL(`${baseUrl}/email`);
  const school = page.getByRole("group", { name: schoolEmail });
  await expect(school).toHaveAccessibleDescription(warning);
  await expect(page.getByText(warning)).toHaveCount(1);
  await expect(page.getByRole("group", { name: personalEmail })).toHaveCount(0);
});
