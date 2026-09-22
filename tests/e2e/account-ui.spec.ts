import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test } from "@playwright/test";
import type { BrowserContext, BrowserContextOptions, Page } from "@playwright/test";
import { seedAuthenticatedSession } from "./auth-session";

const baseUrl = "https://127.0.0.1:3100";

const routes = [
  { href: "/", heading: "Hesabın, tek ve güvenli bir merkezde." },
  { href: "/personal-information", heading: "Kişisel bilgiler" },
  { href: "/club-profile", heading: "Kulüp profili" },
  { href: "/security", heading: "Giriş ve güvenlik" },
  { href: "/sessions", heading: "Oturumlar ve cihazlar" },
  { href: "/permissions", heading: "Yetkilerim" },
  { href: "/delete-account", heading: "Hesabı sil" },
] as const;

const { defaultBrowserType: _desktopBrowser, ...desktop } = devices["Desktop Chrome"];
const { defaultBrowserType: _pixelBrowser, ...pixel } = devices["Pixel 7"];
void _desktopBrowser;
void _pixelBrowser;

const profiles: ReadonlyArray<{
  name: string;
  options: BrowserContextOptions;
}> = [
  { name: "desktop", options: desktop },
  { name: "pixel-7", options: pixel },
  {
    name: "320px-webview",
    options: { ...pixel, viewport: { width: 320, height: 720 } },
  },
  {
    name: "reduced-motion",
    options: { ...desktop, reducedMotion: "reduce" },
  },
];

async function installSession(context: BrowserContext, label: string) {
  const fixture = await seedAuthenticatedSession(label);
  await context.addCookies([{
    name: "__Host-sky-account",
    value: fixture.handle,
    url: baseUrl,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    expires: Math.floor(Date.now() / 1_000) + 8 * 60 * 60,
  }]);
}

function collectPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

test("all seven account routes remain accessible and responsive in the browser matrix", async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);

  for (const profile of profiles) {
    await test.step(profile.name, async () => {
      const context = await browser.newContext({
        ...profile.options,
        baseURL: baseUrl,
        ignoreHTTPSErrors: true,
      });
      try {
        await installSession(
          context,
          `ui-matrix-${profile.name}-${testInfo.retry}`,
        );
        const page = await context.newPage();
        const errors = collectPageErrors(page);

        await page.route("**/api/account/sessions", async (route) => {
          if (route.request().method() === "GET") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ sessions: [], csrfToken: "session-bound-csrf" }),
            });
            return;
          }
          await route.continue();
        });
        await page.route("**/api/account/security", async (route) => {
          if (route.request().method() === "GET") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                password: true,
                totp: [{ reference: "t".repeat(43), label: "Telefon", createdAt: "2026-09-21T13:10:41.130Z" }],
                passkeys: [{ reference: "p".repeat(43), label: "MacBook", createdAt: "2026-09-01T08:00:00.000Z", transports: ["internal"] }],
                sudo: { methods: ["password", "passkey", "totp"], fallback: null, active: null },
                csrfToken: "session-bound-csrf",
              }),
            });
            return;
          }
          await route.continue();
        });

        for (const route of routes) {
          await test.step(`${profile.name} ${route.href}`, async () => {
            const refreshResponse = page.waitForResponse((response) =>
              response.url().endsWith("/api/auth/session/refresh"),
            );
            await page.goto(route.href);
            expect((await refreshResponse).status()).toBe(204);
            await expect(page).toHaveURL(new RegExp(`${route.href === "/" ? "/$" : `${route.href}$`}`));
            await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
            await expect(page.locator("main#main-content")).toBeVisible();

            const overflow = await page.evaluate(() => ({
              body: document.body.scrollWidth - document.body.clientWidth,
              document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            }));
            expect(overflow.body, "body must not overflow horizontally").toBeLessThanOrEqual(1);
            expect(overflow.document, "document must not overflow horizontally").toBeLessThanOrEqual(1);

            const accessibility = await new AxeBuilder({ page })
              .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
              .analyze();
            expect(accessibility.violations, JSON.stringify(accessibility.violations, null, 2)).toEqual([]);
          });
        }

        if (profile.name === "320px-webview") {
          expect(page.viewportSize()).toEqual({ width: 320, height: 720 });
        }
        if (profile.name === "reduced-motion") {
          const duration = await page.locator(".background__bloom").evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).animationDuration),
          );
          expect(duration).toBeLessThanOrEqual(0.001);
        }
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});
