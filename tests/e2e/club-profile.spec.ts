import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test } from "@playwright/test";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { seedAuthenticatedSession } from "./auth-session";

const baseUrl = "https://127.0.0.1:3100";
const mockCoreUrl = `https://127.0.0.1:${process.env.E2E_MOCK_CORE_PORT ?? "3101"}`;
const sessionCookieName = "__Host-sky-account";

/** A minimal but well-formed 1x1 PNG so both the browser and the mock core sniff it as PNG. */
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>', "utf8");

type MockCoreState = {
  profile: Record<string, unknown>;
  requests: Array<{ method: string; path: string; body?: Record<string, unknown>; fields?: string[]; byteLength?: number }>;
  pictures: Array<{ id: string; contentType: string; byteLength: number; base64: string }>;
};

function collectPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
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

async function mockCoreState(request: APIRequestContext, subject: string): Promise<MockCoreState> {
  const response = await request.get(`${mockCoreUrl}/__e2e/users/${encodeURIComponent(subject)}`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<MockCoreState>;
}

async function gotoClubProfile(page: Page) {
  const refreshResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/session/refresh"));
  await page.goto("/club-profile");
  expect((await refreshResponse).status()).toBe(204);
  await expect(page.getByRole("heading", { level: 1, name: "Kulüp profili" })).toBeVisible();
}

test("club profile fields and picture round-trip through the mock core", async ({ context, page, playwright }, testInfo) => {
  test.skip(testInfo.project.name !== "account-ui-matrix", "one browser-backed round trip is sufficient");
  test.setTimeout(90_000);
  const fixture = await installSession(context, `club-profile-${testInfo.retry}`);
  const inspector = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  const errors = collectPageErrors(page);

  try {
    await gotoClubProfile(page);
    await expect(page.getByText("Ada Lovelace")).toBeVisible();
    await expect(page.getByText("SKY-0000042")).toBeVisible();
    await expect(page.getByText("Öğrenci kartı bağlı", { exact: true })).toBeVisible();
    await expect(page.getByText(/\+905551112233/)).toBeVisible();
    await expect(page.getByText(/Yönetim ekibi günceller/)).toBeVisible();
    await expect(page.getByLabel("Fakülte")).toHaveValue("Elektrik-Elektronik Fakültesi");
    await expect(page.getByRole("img", { name: "Mevcut profil fotoğrafın" })).toBeVisible();
    await expect(page.locator("input[name='firstName'], input[name='phone'], input[name='skyNumber']")).toHaveCount(0);
    const initialState = await mockCoreState(inspector, fixture.subject);
    expect(initialState.requests.map(({ method, path }) => `${method} ${path}`)).toEqual(["GET /v1/users/me"]);

    await test.step("edit and save only the changed fields", async () => {
      await page.getByLabel("Fakülte").fill(" Makine Fakültesi ");
      await page.getByLabel("LinkedIn bağlantısı").fill("https://www.linkedin.com/in/ada-lovelace-2026");
      const patchResponse = page.waitForResponse((response) =>
        response.url().endsWith("/api/account/club-profile") && response.request().method() === "PATCH");
      await page.getByRole("button", { name: "Kaydet" }).click();
      expect((await patchResponse).status()).toBe(200);
      const saved = page.getByRole("status");
      await expect(saved).toContainText("Kulüp bilgilerin kaydedildi.");
      await expect(saved).toBeFocused();
      await expect(page.getByLabel("Fakülte")).toHaveValue("Makine Fakültesi");

      const state = await mockCoreState(inspector, fixture.subject);
      const patch = state.requests.find(({ method }) => method === "PATCH");
      expect(patch?.body).toEqual({ faculty: "Makine Fakültesi", linkedin: "https://www.linkedin.com/in/ada-lovelace-2026" });
      expect(state.profile.faculty).toBe("Makine Fakültesi");
      expect(state.profile.university).toBe("Yıldız Teknik Üniversitesi");

      await page.reload();
      await expect(page.getByLabel("Fakülte")).toHaveValue("Makine Fakültesi");
      await expect(page.getByLabel("LinkedIn bağlantısı")).toHaveValue("https://www.linkedin.com/in/ada-lovelace-2026");
    });

    await test.step("reject a wrong type in the browser before any request", async () => {
      await page.getByLabel("Profil fotoğrafı dosyası").setInputFiles({ name: "vector.svg", mimeType: "image/svg+xml", buffer: svgBytes });
      await expect(page.getByRole("alert").filter({ hasText: "Bu dosya türü desteklenmiyor" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Fotoğrafı yükle" })).toHaveCount(0);
      const state = await mockCoreState(inspector, fixture.subject);
      expect(state.requests.filter(({ method }) => method === "POST")).toHaveLength(0);
    });

    await test.step("preview, upload and replace the picture", async () => {
      await page.getByLabel("Profil fotoğrafı dosyası").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: pngBytes });
      const preview = page.getByRole("img", { name: "Seçtiğin fotoğrafın önizlemesi" });
      await expect(preview).toBeVisible();
      await expect(preview).toHaveAttribute("src", /^blob:/);
      await expect(page.getByText("Önizleme, henüz yüklenmedi")).toBeVisible();
      const state = await mockCoreState(inspector, fixture.subject);
      expect(state.requests.filter(({ method }) => method === "POST")).toHaveLength(0);

      const uploadResponse = page.waitForResponse((response) =>
        response.url().endsWith("/api/account/club-profile/picture") && response.request().method() === "POST");
      await page.getByRole("button", { name: "Fotoğrafı yükle" }).click();
      expect((await uploadResponse).status()).toBe(200);
      await expect(page.getByRole("status")).toContainText("Profil fotoğrafın güncellendi.");
      const current = page.getByRole("img", { name: "Mevcut profil fotoğrafın" });
      await expect(current).toBeVisible();

      const uploaded = await mockCoreState(inspector, fixture.subject);
      expect(uploaded.pictures).toHaveLength(1);
      expect(uploaded.pictures[0]).toMatchObject({ contentType: "image/png", byteLength: pngBytes.length, base64: pngBytes.toString("base64") });
      const post = uploaded.requests.find(({ method }) => method === "POST");
      expect(post).toMatchObject({ fields: ["file"], byteLength: pngBytes.length });
      expect(uploaded.profile.profilePictureUrl).toContain(`picture=${uploaded.pictures[0]!.id}`);
      await expect(current).toHaveAttribute("src", new RegExp(`picture=${uploaded.pictures[0]!.id}`));
    });

    await test.step("remove the picture after confirmation", async () => {
      const trigger = page.getByRole("button", { name: "Fotoğrafı kaldır" });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Profil fotoğrafını kaldır" });
      await expect(dialog).toBeVisible();
      await expect.poll(() => dialog.evaluate((element) => element.matches(":modal"))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      expect((await mockCoreState(inspector, fixture.subject)).requests.filter(({ method }) => method === "DELETE")).toHaveLength(0);

      await trigger.click();
      const deleteResponse = page.waitForResponse((response) =>
        response.url().endsWith("/api/account/club-profile/picture") && response.request().method() === "DELETE");
      await dialog.getByRole("button", { name: "Fotoğrafı kaldır" }).click();
      expect((await deleteResponse).status()).toBe(200);
      await expect(page.getByRole("status")).toContainText("Profil fotoğrafın kaldırıldı.");
      await expect(page.getByText("Henüz fotoğraf yok")).toBeVisible();
      await expect(page.getByRole("img", { name: "Mevcut profil fotoğrafın" })).toHaveCount(0);
      const removed = await mockCoreState(inspector, fixture.subject);
      expect(removed.profile.profilePictureUrl).toBeNull();
      expect(removed.requests.filter(({ method }) => method === "DELETE")).toHaveLength(1);
    });

    expect(errors).toEqual([]);
  } finally {
    await inspector.dispose();
  }
});

test("a YTÜ-linked person sees university, faculty and department from the YTÜ account", async ({ context, page, playwright }, testInfo) => {
  test.skip(testInfo.project.name !== "account-ui-matrix", "one browser-backed pass is sufficient");
  test.setTimeout(90_000);
  const fixture = await installSession(context, `club-profile-ytu-${testInfo.retry}`);
  const inspector = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  const api = await playwright.request.newContext({
    baseURL: baseUrl,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { cookie: `${sessionCookieName}=${fixture.handle}` },
  });
  const errors = collectPageErrors(page);

  try {
    const seeded = await inspector.put(`${mockCoreUrl}/__e2e/users/${encodeURIComponent(fixture.subject)}`, {
      data: { ytuLinked: true, faculty: "Bilgisayar ve Bilişim Bilimleri Fakültesi", department: "Bilgisayar Mühendisliği" },
    });
    expect(seeded.status()).toBe(200);

    await test.step("the BFF refuses a YTÜ field change before core sees it", async () => {
      const read = await api.get("/api/account/club-profile");
      expect(read.status()).toBe(200);
      const { csrfToken, profile } = await read.json() as { csrfToken: string; profile: Record<string, unknown> };
      expect(profile.ytuLinked).toBe(true);
      const refused = await api.patch("/api/account/club-profile", {
        headers: { origin: baseUrl, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, "content-type": "application/json" },
        data: JSON.stringify({ department: "Fizik" }),
      });
      expect(refused.status()).toBe(409);
      expect(await refused.json()).toMatchObject({ status: 409, field: "department", title: "Bu bilgi YTÜ hesabından gelir" });
      const state = await mockCoreState(inspector, fixture.subject);
      expect(state.requests.filter(({ method }) => method === "PATCH")).toHaveLength(0);
      expect(state.profile.department).toBe("Bilgisayar Mühendisliği");
    });

    await test.step("the page shows the three fields read-only and saves LinkedIn alone", async () => {
      await gotoClubProfile(page);
      const fromYtu = page.getByRole("group", { name: "YTÜ hesabından gelen bilgiler" });
      await expect(fromYtu).toContainText("Yıldız Teknik Üniversitesi");
      await expect(fromYtu).toContainText("Bilgisayar ve Bilişim Bilimleri Fakültesi");
      await expect(fromYtu).toContainText("Bilgisayar Mühendisliği");
      await expect(fromYtu.getByText("YTÜ hesabından gelir")).toHaveCount(3);
      await expect(page.locator("input[name='university'], input[name='faculty'], input[name='department']")).toHaveCount(0);

      const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(accessibility.violations, JSON.stringify(accessibility.violations, null, 2)).toEqual([]);

      await page.getByLabel("LinkedIn bağlantısı").fill("https://www.linkedin.com/in/ada-ytu");
      const patchResponse = page.waitForResponse((response) =>
        response.url().endsWith("/api/account/club-profile") && response.request().method() === "PATCH");
      await page.getByRole("button", { name: "Kaydet" }).click();
      expect((await patchResponse).status()).toBe(200);
      await expect(page.getByRole("status")).toContainText("Kulüp bilgilerin kaydedildi.");
      const state = await mockCoreState(inspector, fixture.subject);
      expect(state.requests.find(({ method }) => method === "PATCH")?.body).toEqual({ linkedin: "https://www.linkedin.com/in/ada-ytu" });
    });

    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
    await inspector.dispose();
  }
});

test("the editable club profile passes axe and fits a 320px WebView", async ({ browser }, testInfo) => {
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
      await installSession(context, `club-profile-axe-${viewport.width}-${testInfo.retry}`);
      const page = await context.newPage();
      const errors = collectPageErrors(page);
      await gotoClubProfile(page);
      await expect(page.getByRole("button", { name: "Kaydet" })).toBeVisible();
      await page.getByLabel("Profil fotoğrafı dosyası").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: pngBytes });
      await expect(page.getByRole("button", { name: "Fotoğrafı yükle" })).toBeVisible();

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

test("the BFF re-validates picture bytes and origin before anything reaches core", async ({ context, playwright }, testInfo) => {
  test.skip(testInfo.project.name !== "account-ui-matrix", "one server-side assertion is sufficient");
  const fixture = await installSession(context, `club-profile-api-${testInfo.retry}`);
  const cookie = `${sessionCookieName}=${fixture.handle}`;
  const inspector = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  const api = await playwright.request.newContext({
    baseURL: baseUrl,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { cookie },
  });

  try {
    const read = await api.get("/api/account/club-profile");
    expect(read.status()).toBe(200);
    const { csrfToken, profile } = await read.json() as { csrfToken: string; profile: Record<string, unknown> };
    expect(profile.skyNumber).toBe("SKY-0000042");
    expect(JSON.stringify(profile)).not.toContain(fixture.subject);

    const mutationHeaders = { origin: baseUrl, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken };
    const disguised = await api.post("/api/account/club-profile/picture", {
      headers: mutationHeaders,
      multipart: { file: { name: "me.png", mimeType: "image/png", buffer: svgBytes } },
    });
    expect(disguised.status()).toBe(415);
    expect(disguised.headers()["cache-control"]).toBe("no-store");
    expect(await disguised.json()).toMatchObject({ title: "Dosya türü desteklenmiyor" });

    const foreignOrigin = await api.post("/api/account/club-profile/picture", {
      headers: { ...mutationHeaders, origin: "https://attacker.invalid" },
      multipart: { file: { name: "me.png", mimeType: "image/png", buffer: pngBytes } },
    });
    expect(foreignOrigin.status()).toBe(403);

    const forgedProof = await api.patch("/api/account/club-profile", {
      headers: { ...mutationHeaders, "x-csrf-token": "forged", "content-type": "application/json" },
      data: JSON.stringify({ faculty: "Sahte Fakülte" }),
    });
    expect(forgedProof.status()).toBe(403);

    const namesLocked = await api.patch("/api/account/club-profile", {
      headers: { ...mutationHeaders, "content-type": "application/json" },
      data: JSON.stringify({ firstName: "Mallory" }),
    });
    expect(namesLocked.status()).toBe(400);

    const state = await mockCoreState(inspector, fixture.subject);
    expect(state.requests.map(({ method }) => method)).toEqual(["GET"]);
    expect(state.profile.firstName).toBe("Ada");
    expect(state.pictures).toHaveLength(0);
  } finally {
    await api.dispose();
    await inspector.dispose();
  }
});
