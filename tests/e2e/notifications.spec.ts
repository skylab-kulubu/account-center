import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test } from "@playwright/test";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { seedAuthenticatedSession } from "./auth-session";

const baseUrl = "https://127.0.0.1:3100";
const mockCoreUrl = `https://127.0.0.1:${process.env.E2E_MOCK_CORE_PORT ?? "3101"}`;
const sessionCookieName = "__Host-sky-account";
const ticketItem = "5d0c2f9e-0000-4000-8000-000000000001";
const certificateItem = "5d0c2f9e-0000-4000-8000-000000000002";

type InboxState = { items: Array<{ id: string; seen_at: string | null; read_at: string | null; archived_at: string | null }>; marks: string[] };

function collectPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

async function installSession(context: BrowserContext, label: string) {
  const fixture = await seedAuthenticatedSession(label, { contractToken: true, skymailAudience: true });
  await context.addCookies([{
    name: sessionCookieName,
    value: fixture.handle,
    url: baseUrl,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    expires: Math.floor(Date.now() / 1_000) + 8 * 60 * 60,
  }]);
  return fixture;
}

async function inboxState(request: APIRequestContext, subject: string): Promise<InboxState> {
  const response = await request.get(`${mockCoreUrl}/__e2e/inbox/${encodeURIComponent(subject)}`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<InboxState>;
}

test("Bildirimlerim lists the inbox, clears the badge, marks read and archives through SkyMail", async ({ context, page, playwright }, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await installSession(context, `notifications-${testInfo.project.name}-${testInfo.retry}`);
  const inspector = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  const errors = collectPageErrors(page);

  try {
    // Another page first: the sidebar shows one unseen item.
    const firstRefresh = page.waitForResponse((response) => response.url().endsWith("/api/auth/session/refresh"));
    await page.goto("/communication-preferences");
    // The seeded session is due for rotation: let the shell's refresh land before the next page (the
    // page's own seen-all also waits for the shell's refresh; this keeps the test about Bildirimlerim).
    expect((await firstRefresh).status()).toBe(204);
    const navigation = page.getByRole("navigation", { name: "Hesap ayarları" });
    if (await navigation.isVisible()) {
      await expect(navigation.getByRole("link", { name: /Bildirimlerim\s*1 yeni bildirim/ })).toBeVisible();
    }

    const seen = page.waitForResponse((response) => response.url().endsWith("/api/account/inbox/seen-all"));
    await page.goto("/notifications");
    await expect(page.getByRole("heading", { level: 1, name: "Bildirimlerim" })).toBeVisible();
    await expect(page.getByText("Kodlama Gecesi biletin hazır")).toBeVisible();
    expect((await seen).status()).toBe(200);
    if (await navigation.isVisible()) {
      await expect(navigation.locator(".account-nav__badge")).toHaveCount(0);
    }
    // sky-app's path has no web page; the certificate's address opens.
    await expect(page.getByRole("link", { name: /Kodlama Gecesi/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Katılım sertifikan hazır/ })).toHaveAttribute("href", "https://yildizskylab.com/sertifika/AB12CD");
    await expect(page.getByText("Bildirimler 90 gün tutulur.", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Kodlama Gecesi biletin hazır: okundu yap" }).click();
    await expect(page.getByRole("button", { name: "Kodlama Gecesi biletin hazır: okunmadı yap" })).toBeVisible();
    await page.getByRole("button", { name: "Katılım sertifikan hazır: arşivle" }).click();
    await expect(page.getByText("Katılım sertifikan hazır")).toHaveCount(0);

    const state = await inboxState(inspector, fixture.subject);
    expect(state.marks).toEqual(["seen-all", `read:${ticketItem}`, `archive:${certificateItem}`]);

    await page.reload();
    await expect(page.getByText("Katılım sertifikan hazır")).toHaveCount(0);
    await expect(page.getByText("Kodlama Gecesi biletin hazır")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await inspector.dispose();
  }
});

test("Bildirimlerim passes axe and fits a 320px WebView", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "account-ui-matrix", "one accessibility pass of the ready state is sufficient");
  const { defaultBrowserType: _browserType, ...pixel } = devices["Pixel 7"];
  void _browserType;
  for (const viewport of [{ width: 1280, height: 900 }, { width: 320, height: 720 }]) {
    const context = await browser.newContext({
      ...(viewport.width === 320 ? pixel : {}),
      viewport,
      baseURL: baseUrl,
      ignoreHTTPSErrors: true,
    });
    try {
      await installSession(context, `notifications-axe-${viewport.width}-${testInfo.retry}`);
      const page = await context.newPage();
      const errors = collectPageErrors(page);
      await page.goto("/notifications");
      await expect(page.getByText("Kodlama Gecesi biletin hazır")).toBeVisible();

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
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
