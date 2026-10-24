import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { seedAuthenticatedSession } from "./auth-session";

const baseUrl = "https://127.0.0.1:3100";
const mockCoreUrl = `https://127.0.0.1:${process.env.E2E_MOCK_CORE_PORT ?? "3101"}`;
const sessionCookieName = "__Host-sky-account";

/** The mock core's team tree (`scripts/e2e-mock-core.mjs`, `tests/fixtures/core-communication-preferences.json`). */
const teams = {
  back: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d03",
  airlab: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d04",
  robolab: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d07",
};

type PreferenceState = {
  off: boolean;
  choices: Record<string, boolean>;
  tracking: boolean | null;
  puts: Array<{ items?: unknown[]; tracking?: unknown }>;
};

const trackingLabel = "Postalarımın açılmasını ve tıklamalarımı izleme";
const promotionalBox = "SKY LAB'dan tanıtım içerikli e-postalar (indirim kodu, şirket iş ilanı, çekiliş gibi) almak istiyorum.";

function collectPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

/**
 * Records every Content Security Policy violation on the page, from the first
 * byte of the HTML on: the switches and the follow picker are server-rendered,
 * and their hidden form inputs carry a style attribute (`style-src-attr`).
 */
async function collectCspViolations(page: Page) {
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.assign(window, { __cspViolations: violations });
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.effectiveDirective} ${event.blockedURI || "inline"} ${event.sample}`);
    });
  });
  return () => page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
}

async function installSession(context: BrowserContext, label: string) {
  const fixture = await seedAuthenticatedSession(label, { contractToken: true });
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

async function preferenceState(request: APIRequestContext, subject: string): Promise<PreferenceState> {
  const response = await request.get(`${mockCoreUrl}/__e2e/communication-preferences/${encodeURIComponent(subject)}`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<PreferenceState>;
}

async function savePreference(page: Page, action: () => Promise<void>) {
  const response = page.waitForResponse((candidate) =>
    candidate.url().endsWith("/api/account/communication-preferences") && candidate.request().method() === "PUT");
  await action();
  expect((await response).status()).toBe(200);
}

test("the preferences screen writes each switch to core under its own category", async ({ context, page, playwright }, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await installSession(context, `preferences-${testInfo.project.name}-${testInfo.retry}`);
  const inspector = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  const errors = collectPageErrors(page);
  const cspViolations = await collectCspViolations(page);

  try {
    await page.goto("/communication-preferences");
    await expect(page.getByRole("heading", { level: 1, name: "İletişim tercihleri" })).toBeVisible();
    await expect(page.getByText("Giriş kodu, bilet, sertifika gibi hesap postaların bu ayarlardan etkilenmez.")).toBeVisible();
    await expect(page.getByText(/Postalar birincil adresine gider/)).toBeVisible();
    const table = page.getByRole("table", { name: "Duyuru ve haber postası tercihlerin, kaynak kaynak" });
    await expect(table).toBeVisible();
    const back = page.getByRole("switch", { name: "BACK · Duyurular" });
    await expect(back).toBeChecked();
    await expect(back).toHaveAccessibleDescription("üst ekipten: WEBLAB");
    // The row header names the team only; its action sits in a column of its own.
    await expect(page.getByRole("rowheader", { name: "BACK Backend", exact: true })).toBeVisible();
    // Each load starts a fresh list: this one covers the first, the end of the test the reload.
    expect(await cspViolations()).toEqual([]);

    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(accessibility.violations, JSON.stringify(accessibility.violations, null, 2)).toEqual([]);

    await test.step("a sub-team turned off on its own", async () => {
      await savePreference(page, () => back.click());
      await expect(back).not.toBeChecked();
      await expect(page.getByText("BACK · Duyurular kapatıldı.")).toBeVisible();
      const state = await preferenceState(inspector, fixture.subject);
      expect(state.choices[`team:${teams.back}:duyuru`]).toBe(false);
      expect(state.puts.at(-1)).toEqual({ items: [{ category: `team:${teams.back}:duyuru`, channel: "email", enabled: false }] });
      // The team above keeps its value: only the sub-team changed.
      await expect(page.getByRole("switch", { name: "WEBLAB · Duyurular" })).toBeChecked();
    });

    await test.step("the master switch closes everything and gives every choice back", async () => {
      const master = page.getByRole("switch", { name: "Duyuru ve haber postaları" });
      await expect(master).toHaveAccessibleDescription(/^Açık:/);
      await savePreference(page, () => master.click());
      await expect(page.getByText(/Ana anahtar kapalı/)).toBeVisible();
      await expect(master).toHaveAccessibleDescription("Kapalı: hiçbir duyuru ve haber postası gelmez.");
      await expect(page.getByRole("status").filter({ hasText: "Duyuru ve haber postaları kapatıldı." })).toBeVisible();
      await savePreference(page, () => master.click());
      await expect(page.getByText(/Ana anahtar kapalı/)).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole("switch", { name: "BACK · Duyurular" })).not.toBeChecked();
      await expect(page.getByRole("switch", { name: "Kulüp geneli · Duyurular" })).toBeChecked();
    });

    await test.step("unfollow a team and follow another", async () => {
      await savePreference(page, () => page.getByRole("button", { name: "Takibi bırak: AIRLAB" }).click());
      await expect(page.getByRole("switch", { name: "AIRLAB · Duyurular" })).toHaveCount(0);

      await page.getByRole("combobox", { name: "Takip edilecek ekip" }).fill("ROBO");
      await page.getByRole("option", { name: /ROBOLAB/ }).click();
      await savePreference(page, () => page.getByRole("button", { name: "Takip et" }).click());
      await expect(page.getByRole("switch", { name: "ROBOLAB · Duyurular" })).toBeChecked();
      const state = await preferenceState(inspector, fixture.subject);
      expect(state.choices[`team:${teams.robolab}:duyuru`]).toBe(true);
      expect(state.choices[`team:${teams.robolab}:haber`]).toBe(true);
      expect(Object.keys(state.choices).some((key) => key.includes(teams.airlab))).toBe(false);
    });

    await test.step("checking the tracking switch turns tracking off", async () => {
      const tracking = page.getByRole("switch", { name: trackingLabel });
      await expect(tracking).not.toBeChecked();
      await expect(page.getByRole("region", { name: "Postalarımın açılma ve tıklama bilgisi" })
        .getByRole("link", { name: "KVKK aydınlatma metni" }))
        .toHaveAttribute("href", "https://yildizskylab.com/kvkk-metni.pdf");
      await savePreference(page, () => tracking.click());
      await expect(tracking).toBeChecked();
      await expect(page.getByRole("status").filter({ hasText: "Açılma ve tıklama izlemesi kapatıldı." })).toBeVisible();
      const state = await preferenceState(inspector, fixture.subject);
      expect(state.tracking).toBe(false);
      expect(state.puts.at(-1)).toEqual({ tracking: { enabled: false } });
      await page.reload();
      await expect(page.getByRole("switch", { name: trackingLabel })).toBeChecked();
    });

    expect(errors).toEqual([]);
    expect(await cspViolations()).toEqual([]);
  } finally {
    await inspector.dispose();
  }
});

test("a mail's link opens the screen on its row, through the root address core links to", async ({ context, page }, testInfo) => {
  await installSession(context, `preferences-link-${testInfo.project.name}-${testInfo.retry}`);

  await page.goto(`/?kanal=email&kategori=team%3A${teams.airlab}%3Aduyuru`);

  await expect(page).toHaveURL(`${baseUrl}/communication-preferences?kanal=email&kategori=team%3A${teams.airlab}%3Aduyuru`);
  await expect(page.getByText("“AIRLAB · Duyurular” satırı aşağıda vurgulandı.", { exact: false })).toBeVisible();
  await expect(page.locator("tr[data-focused]")).toContainText("AIRLAB");
});

test("the screen says the preferences are not on yet while core has no key", async ({ context, page, playwright }, testInfo) => {
  const fixture = await installSession(context, `preferences-off-${testInfo.project.name}-${testInfo.retry}`);
  const inspector = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  try {
    const response = await inspector.put(
      `${mockCoreUrl}/__e2e/communication-preferences/${encodeURIComponent(fixture.subject)}`,
      { data: { off: true } },
    );
    expect(response.status()).toBe(200);

    await page.goto("/communication-preferences");

    await expect(page.getByText("İletişim tercihleri şu an kullanılamıyor")).toBeVisible();
    // Only the promotional box is left: it is core's consent record, not the preferences.
    await expect(page.getByRole("switch")).toHaveCount(1);
    await expect(page.getByRole("switch", { name: promotionalBox })).toBeVisible();
    await expect(page.getByRole("link", { name: "E-posta ayarları" })).toBeVisible();
  } finally {
    await inspector.dispose();
  }
});

type ConsentState = {
  off: boolean;
  items: Array<{ purpose: string; status: string; source: string; textVersion: string }>;
  requests: Array<{ method: string; body?: unknown; purpose?: string }>;
};

async function consentState(request: APIRequestContext, subject: string): Promise<ConsentState> {
  const response = await request.get(`${mockCoreUrl}/__e2e/consents/${encodeURIComponent(subject)}`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<ConsentState>;
}

async function saveConsent(page: Page, method: "POST" | "DELETE", action: () => Promise<void>) {
  const response = page.waitForResponse((candidate) =>
    candidate.url().endsWith("/api/account/promotional-consent") && candidate.request().method() === method);
  await action();
  expect((await response).status()).toBe(200);
}

test("the promotional box on the preferences grants and withdraws through core", async ({ context, page, playwright }, testInfo) => {
  const fixture = await installSession(context, `promotional-${testInfo.project.name}-${testInfo.retry}`);
  const inspector = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  try {
    await page.goto("/communication-preferences");
    await expect(page.getByRole("heading", { level: 2, name: "Tanıtım içerikleri" })).toBeVisible();
    const box = page.getByRole("switch", { name: promotionalBox });
    await expect(box).not.toBeChecked();
    expect((await consentState(inspector, fixture.subject)).requests).toEqual([]);

    await saveConsent(page, "POST", () => box.click());
    await expect(box).toBeChecked();
    let state = await consentState(inspector, fixture.subject);
    expect(state.requests.at(-1)).toEqual({
      method: "POST",
      body: { purpose: "promotional", textVersion: "tanitim-v1", source: "self" },
    });
    await page.reload();
    await expect(page.getByRole("switch", { name: promotionalBox })).toBeChecked();

    await saveConsent(page, "DELETE", () => page.getByRole("switch", { name: promotionalBox }).click());
    await expect(page.getByRole("switch", { name: promotionalBox })).not.toBeChecked();
    state = await consentState(inspector, fixture.subject);
    expect(state.requests.at(-1)).toEqual({ method: "DELETE", purpose: "promotional" });
    expect(state.items.map((item) => item.status)).toEqual(["withdrawn"]);
  } finally {
    await inspector.dispose();
  }
});

test("the promotional box is left out while core records no consents", async ({ context, page, playwright }, testInfo) => {
  const fixture = await installSession(context, `promotional-off-${testInfo.project.name}-${testInfo.retry}`);
  const inspector = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  try {
    const off = await inspector.put(`${mockCoreUrl}/__e2e/consents/${encodeURIComponent(fixture.subject)}`, { data: { off: true } });
    expect(off.status()).toBe(200);

    await page.goto("/communication-preferences");

    await expect(page.getByRole("table", { name: "Duyuru ve haber postası tercihlerin, kaynak kaynak" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tanıtım içerikleri" })).toHaveCount(0);
    await expect(page.getByRole("switch", { name: promotionalBox })).toHaveCount(0);
  } finally {
    await inspector.dispose();
  }
});

test("the first screen after signup offers the box once a new account has no grant", async ({ context, page, playwright }, testInfo) => {
  const fixture = await installSession(context, `promotional-signup-${testInfo.project.name}-${testInfo.retry}`);
  const inspector = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  try {
    const opened = await inspector.put(
      `${mockCoreUrl}/__e2e/users/${encodeURIComponent(fixture.subject)}`,
      { data: { createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") } },
    );
    expect(opened.status()).toBe(200);

    // The first project to reach the route compiles it; wait for the answer, not the default five seconds.
    const offer = page.waitForResponse((candidate) => candidate.url().endsWith("/api/account/promotional-consent/signup-offer"));
    await page.goto("/");
    await expect((await offer).json()).resolves.toMatchObject({ offer: true });
    const box = page.getByRole("switch", { name: promotionalBox });
    await expect(box).toBeVisible();
    await expect(box).not.toBeChecked();
    // Unticked records nothing.
    expect((await consentState(inspector, fixture.subject)).requests).toEqual([]);

    await saveConsent(page, "POST", () => box.click());
    await expect(box).toBeChecked();
    expect((await consentState(inspector, fixture.subject)).requests.at(-1)).toEqual({
      method: "POST",
      body: { purpose: "promotional", textVersion: "tanitim-v1", source: "signup" },
    });

    // Given once, the overview does not ask again.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("switch", { name: promotionalBox })).toHaveCount(0);
  } finally {
    await inspector.dispose();
  }
});

test("an older account sees no promotional box on the overview", async ({ context, page }, testInfo) => {
  await installSession(context, `promotional-old-${testInfo.project.name}-${testInfo.retry}`);
  const offer = page.waitForResponse((candidate) => candidate.url().endsWith("/api/account/promotional-consent/signup-offer"));

  await page.goto("/");

  await expect((await offer).json()).resolves.toEqual({ offer: false });
  await expect(page.getByRole("switch", { name: promotionalBox })).toHaveCount(0);
});
