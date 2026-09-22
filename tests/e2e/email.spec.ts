import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test } from "@playwright/test";
import type { BrowserContext, Page, Request as PlaywrightRequest, Route } from "@playwright/test";
import { seedAuthenticatedSession } from "./auth-session";

/**
 * The e-mail page ("E-posta ve giriş") in the browser: adding a Personal
 * e-mail behind the real Sudo mode dialog, typing the mailed six-digit code
 * into the same page, switching the Primary e-mail, removing the personal
 * address, and the wrong / exhausted / expired / rate-limited code answers.
 * The BFF routes under `/api/account/email*` and `/api/account/sudo/*` are
 * answered by `page.route` in the shapes `src/server/email/routes.ts` and
 * `src/server/auth/sudo-routes.ts` produce (the handlers themselves, their
 * SPI calls and their log redaction are covered by their unit tests against
 * the sky-account fixtures); the session, shell, page, forms and dialogs run
 * for real. The mailed code itself only exists at the Keycloak harness's
 * mail sink, so these tests stand in for it with a fixed code.
 */

const baseUrl = "https://127.0.0.1:3100";
const keycloakHost = "e.yildizskylab.com";
const sessionCookieName = "__Host-sky-account";
const csrfToken = "e2e-email-csrf";
const sudoPassword = "hunter2-correct-horse-staple";
const mailedCode = "482913";
const schoolEmail = "ada@std.yildiz.edu.tr";
const personalEmail = "ada.lovelace@example.com";

type EmailState = {
  email: string | null;
  emailVerified: boolean;
  primary: "school" | "personal" | "none";
  schoolEmail: string | null;
  verifiedYtu: boolean;
  personalEmail: string | null;
  personalEmailVerified: boolean;
};

const verifiedSchoolOnly: EmailState = {
  email: schoolEmail,
  emailVerified: true,
  primary: "school",
  schoolEmail,
  verifiedYtu: true,
  personalEmail: null,
  personalEmailVerified: false,
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
  return fixture;
}

async function gotoEmail(page: Page) {
  const refresh = page.waitForResponse((response) => response.url().endsWith("/api/auth/session/refresh"));
  const response = await page.goto("/email");
  expect((await refresh).status()).toBe(204);
  await expect(page.getByRole("heading", { level: 1, name: "E-posta ve giriş" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Okul e-postası" })).toBeVisible();
  return response;
}

/** Wrong codes, refusals and the sudo challenge answer 4xx on purpose; the browser logs those as resource errors. */
const expectedRejectionLog = /Failed to load resource: the server responded with a status of (?:400|404|409|428|429)/;

function failOnPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !expectedRejectionLog.test(message.text())) errors.push(message.text());
  });
  return errors;
}

function recordRequests(page: Page) {
  const requests: PlaywrightRequest[] = [];
  page.on("request", (request) => requests.push(request));
  return {
    hosts: () => new Set(requests.map((request) => new URL(request.url()).hostname)),
    urls: () => requests.map((request) => request.url()),
  };
}

/** The e-mail read, answered from a mutable record so a re-read after a change shows the server's state. */
async function mockEmail(page: Page, state: EmailState) {
  await page.route("**/api/account/email", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { ...state, csrfToken } });
  });
}

/** The identity read of the same person, so the identity page's summary can be checked against the same record. */
async function mockIdentity(page: Page, state: EmailState) {
  await page.route("**/api/account/identity", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        firstName: "Ada",
        lastName: "Lovelace",
        nameLocked: state.verifiedYtu,
        username: "ada.lovelace",
        usernameChangeAvailableAt: null,
        verifiedYtu: state.verifiedYtu,
        schoolEmail: state.schoolEmail,
        email: state.email,
        emailVerified: state.emailVerified,
        csrfToken,
      },
    });
  });
}

async function mockSudo(page: Page) {
  const proofs: unknown[] = [];
  await page.route("**/api/account/sudo/methods", (route) => route.fulfill({
    json: { methods: ["password"], fallback: null, active: null, csrfToken },
  }));
  await page.route("**/api/account/sudo/password", async (route) => {
    proofs.push(route.request().postDataJSON());
    await route.fulfill({ json: { method: "password", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() } });
  });
  return proofs;
}

async function completeSudoDialog(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Kimliğini doğrula" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Parola" }).fill(sudoPassword);
  await dialog.getByRole("button", { name: "Doğrula" }).click();
  await expect(dialog).toBeHidden();
}

const sudoChallenge = { error: "sudo_required", reason: "missing", methods: ["password"], fallback: null };

type Mutation = { method: string; path: string; headers: Record<string, string>; body: unknown };

async function recordMutation(route: Route, mutations: Mutation[]) {
  const request = route.request();
  mutations.push({
    method: request.method(),
    path: new URL(request.url()).pathname,
    headers: await request.allHeaders(),
    body: request.postData() ? request.postDataJSON() : null,
  });
}

async function openAddForm(page: Page) {
  await page.getByRole("button", { name: "Kişisel e-posta ekle" }).click();
  const form = page.getByRole("form", { name: "Kişisel e-posta ekle" });
  await expect(form).toBeVisible();
  return form;
}

async function requestCode(page: Page, address: string) {
  const form = await openAddForm(page);
  await form.getByLabel("E-posta adresi").fill(address);
  await form.getByRole("button", { name: "Kod gönder" }).click();
  return form;
}

test("add → code → confirm → primary switch → remove, with the identity summary following the primary", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `email-flow-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  const network = recordRequests(page);
  const state: EmailState = { ...verifiedSchoolOnly };
  let pendingAddress: string | null = null;
  await mockEmail(page, state);
  await mockIdentity(page, state);
  const proofs = await mockSudo(page);
  const mutations: Mutation[] = [];

  await page.route("**/api/account/email/change-request", async (route) => {
    await recordMutation(route, mutations);
    // The first request is deliberately answered 428: the real Sudo mode dialog opens, then the same body is retried.
    if (mutations.filter(({ path }) => path.endsWith("/change-request")).length === 1) {
      await route.fulfill({ status: 428, json: sudoChallenge });
      return;
    }
    pendingAddress = (route.request().postDataJSON() as { address: string }).address;
    await route.fulfill({ status: 202, json: { expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() } });
  });
  await page.route("**/api/account/email/confirm", async (route) => {
    await recordMutation(route, mutations);
    const { code } = route.request().postDataJSON() as { code: string };
    if (code !== mailedCode || pendingAddress === null) {
      await route.fulfill({ status: 400, json: { error: "invalid_code", detail: "Doğrulama kodu yanlış. 4 deneme hakkın kaldı.", attemptsLeft: 4 } });
      return;
    }
    state.personalEmail = pendingAddress;
    state.personalEmailVerified = true;
    pendingAddress = null;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/account/email/primary", async (route) => {
    await recordMutation(route, mutations);
    const { which } = route.request().postDataJSON() as { which: "school" | "personal" };
    state.primary = which;
    state.email = which === "school" ? state.schoolEmail : state.personalEmail;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/account/email/personal", async (route) => {
    await recordMutation(route, mutations);
    if (state.primary === "personal") {
      state.primary = "school";
      state.email = state.schoolEmail;
    }
    state.personalEmail = null;
    state.personalEmailVerified = false;
    await route.fulfill({ status: 204 });
  });

  // The page is reachable from the account navigation.
  await page.goto("/identity");
  await page.getByRole("navigation", { name: "Hesap ayarları" }).getByRole("link", { name: "E-posta ve giriş" }).click();
  await expect(page).toHaveURL(`${baseUrl}/email`);
  await expect(page.getByRole("heading", { level: 1, name: "E-posta ve giriş" })).toBeVisible();
  await expect(page.getByText("Kulüp postaları birincil adrese gider; iki adresle de giriş yapabilirsin.").first()).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Add: the address, Sudo mode, then the code panel in the same page.
  await requestCode(page, `  ${personalEmail.toUpperCase()} `);
  await completeSudoDialog(page);
  const codeForm = page.getByRole("form", { name: "Doğrulama kodunu gir" });
  await expect(codeForm).toBeVisible();
  await expect(codeForm).toContainText(`${personalEmail} adresine 6 haneli bir kod gönderdik.`);
  await expect(codeForm.getByRole("timer")).toHaveText(/Kalan süre: (?:10:00|9:\d{2})/);
  const codeInput = codeForm.getByLabel("Doğrulama kodu");
  await expect(codeInput).toBeFocused();
  await codeInput.fill(`${mailedCode.slice(0, 3)} ${mailedCode.slice(3)}`);
  await codeForm.getByRole("button", { name: "Doğrula" }).click();
  const added = page.getByRole("status").filter({ hasText: "İşlem tamamlandı" });
  await expect(added).toContainText(`${personalEmail} doğrulandı. Artık bu adresle de giriş yapabilirsin.`);
  await expect(added).toBeFocused();
  await expect(codeForm).toBeHidden();
  await expect(page.getByText(personalEmail, { exact: true }).first()).toBeVisible();

  // Primary: the sudo proof is still fresh, so no second dialog.
  const primary = page.getByRole("group", { name: "Birincil e-posta" });
  await expect(primary.getByRole("radio", { name: /Okul e-postası/ })).toBeChecked();
  await primary.getByRole("radio", { name: /Kişisel e-posta/ }).check();
  await page.getByRole("button", { name: "Birincil adresi kaydet" }).click();
  const switched = page.getByRole("status").filter({ hasText: "Birincil adresin güncellendi" });
  await expect(switched).toContainText(`Kulüp postaları artık ${personalEmail} adresine gider.`);
  await expect(page.getByRole("group", { name: "Birincil e-posta" }).getByRole("radio", { name: /Kişisel e-posta/ })).toBeChecked();

  // The identity summary shows the new primary.
  await page.getByRole("navigation", { name: "Hesap ayarları" }).getByRole("link", { name: "Kimlik" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Kimlik" })).toBeVisible();
  await expect(page.getByText(new RegExp(`^${personalEmail.replace(/\./g, "\\.")} · Kulüp postaları bu adrese gelir`))).toBeVisible();
  await page.getByRole("link", { name: "E-posta ayarları" }).click();
  await expect(page).toHaveURL(`${baseUrl}/email`);

  // Remove: the confirmation states that the school address takes over.
  await page.getByRole("button", { name: `${personalEmail} — Kaldır` }).click();
  const dialog = page.getByRole("dialog", { name: "Kişisel e-posta kaldırılsın mı?" });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((element) => element.matches(":modal"))).toBe(true);
  await expect(dialog).toContainText("Bu adres birincil adresin; kaldırınca kulüp postaları okul e-postana gider.");
  await dialog.getByRole("button", { name: "Kaldır" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Kişisel e-postan kaldırıldı." })).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Kişisel e-posta ekle" })).toBeEnabled();
  await expect(page.getByRole("group", { name: "Birincil e-posta" }).getByRole("radio", { name: /Okul e-postası/ })).toBeChecked();

  expect(proofs).toEqual([{ password: sudoPassword }]);
  expect(mutations.map(({ method, path, body }) => [method, path, body])).toEqual([
    ["POST", "/api/account/email/change-request", { address: personalEmail }],
    ["POST", "/api/account/email/change-request", { address: personalEmail }],
    ["POST", "/api/account/email/confirm", { code: mailedCode }],
    ["POST", "/api/account/email/primary", { which: "personal" }],
    ["DELETE", "/api/account/email/personal", null],
  ]);
  for (const mutation of mutations) {
    expect(mutation.headers["x-csrf-token"]).toBe(csrfToken);
    expect(mutation.headers.origin).toBe(baseUrl);
  }
  // Neither the address nor the code ever travels in an address bar or leaves for Keycloak.
  for (const url of network.urls()) {
    expect(url).not.toContain(mailedCode);
    expect(decodeURIComponent(url)).not.toContain(personalEmail);
  }
  expect(await page.content()).not.toContain(csrfToken);
  expect(network.hosts().has(keycloakHost)).toBe(false);
  expect(errors).toEqual([]);
});

test("wrong, exhausted, vanished and rate-limited codes each say what happened", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `email-codes-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  await mockEmail(page, { ...verifiedSchoolOnly });
  await mockSudo(page);
  const sends: unknown[] = [];
  await page.route("**/api/account/email/change-request", async (route) => {
    sends.push(route.request().postDataJSON());
    if (sends.length === 3) {
      await route.fulfill({
        status: 429,
        headers: { "retry-after": "1800" },
        json: { error: "rate_limited", detail: "Çok fazla deneme yaptın. Biraz sonra yeniden dene.", retryAfter: 1_800 },
      });
      return;
    }
    await route.fulfill({ status: 202, json: { expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() } });
  });
  const confirmations: string[] = [];
  const confirmAnswers = [
    { status: 400, json: { error: "invalid_code", detail: "Doğrulama kodu yanlış. 4 deneme hakkın kaldı.", attemptsLeft: 4 } },
    { status: 400, json: { error: "invalid_code", detail: "Doğrulama kodu yanlış ve deneme hakkın bitti. Yeni bir kod iste.", attemptsLeft: 0 } },
    { status: 404, json: { error: "no_pending_change", detail: "Bekleyen bir doğrulama kodu yok: süresi dolmuş ya da zaten kullanılmış olabilir. Yeni bir kod iste." } },
  ];
  await page.route("**/api/account/email/confirm", async (route) => {
    confirmations.push((route.request().postDataJSON() as { code: string }).code);
    await route.fulfill(confirmAnswers[confirmations.length - 1]!);
  });

  await gotoEmail(page);
  // A fresh proof is assumed here (the change request answers 202 at once); the challenge is covered above.
  await requestCode(page, personalEmail);
  const form = page.getByRole("form", { name: "Doğrulama kodunu gir" });
  const input = form.getByLabel("Doğrulama kodu");

  await input.fill("111111");
  await form.getByRole("button", { name: "Doğrula" }).click();
  await expect(form.getByRole("alert")).toHaveText("Kod yanlış. 4 deneme hakkın kaldı.");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(input).toBeFocused();

  await input.fill("222222");
  await form.getByRole("button", { name: "Doğrula" }).click();
  await expect(form.getByRole("alert")).toContainText("Kodu çok kez yanlış girdin; bu kod artık geçersiz. Yeni kod iste.");
  await expect(input).toBeDisabled();

  await form.getByRole("button", { name: "Yeni kod gönder" }).click();
  await expect(form.getByRole("status").filter({ hasText: "Yeni bir kod gönderdik. Önceki kod artık geçersiz." })).toBeVisible();
  await expect(input).toBeEnabled();

  await input.fill("333333");
  await form.getByRole("button", { name: "Doğrula" }).click();
  await expect(form.getByRole("alert")).toContainText("Bu kodun süresi dolmuş ya da kod artık geçerli değil. Yeni kod iste.");
  await expect(input).toBeDisabled();

  await form.getByRole("button", { name: "Yeni kod gönder" }).click();
  // The vanished code stays announced next to the wait, so the person knows both what happened and when to retry.
  await expect(form.getByRole("alert").filter({ hasText: "Çok fazla deneme" })).toHaveText(
    "Çok fazla deneme yaptın. Biraz sonra yeniden dene. Yeniden denemek için bekle: 30 dakika.",
  );
  await expect(form.getByRole("alert").filter({ hasText: "süresi dolmuş" })).toBeVisible();
  await expect(form.getByRole("button", { name: "Yeni kod gönder" })).toBeDisabled();

  expect(confirmations).toEqual(["111111", "222222", "333333"]);
  expect(sends).toEqual([{ address: personalEmail }, { address: personalEmail }, { address: personalEmail }]);
  expect(errors).toEqual([]);
});

test("the ten-minute countdown closes the code input when it runs out", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `email-expiry-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  await mockEmail(page, { ...verifiedSchoolOnly });
  await mockSudo(page);
  await page.route("**/api/account/email/change-request", (route) => route.fulfill({
    status: 202,
    json: { expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() },
  }));
  const confirmations: unknown[] = [];
  await page.route("**/api/account/email/confirm", async (route) => {
    confirmations.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await page.clock.install();

  await gotoEmail(page);
  await requestCode(page, personalEmail);
  const form = page.getByRole("form", { name: "Doğrulama kodunu gir" });
  await expect(form.getByRole("timer")).toBeVisible();
  await page.clock.fastForward("04:00");
  await expect(form.getByRole("timer")).toHaveText(/Kalan süre: [56]:\d{2}/);
  await page.clock.fastForward("06:05");
  await expect(form.getByRole("alert")).toContainText("Kodun süresi doldu. Yeni kod iste.");
  await expect(form.getByLabel("Doğrulama kodu")).toBeDisabled();
  await expect(form.getByRole("button", { name: "Doğrula" })).toBeDisabled();
  await expect(form.getByRole("button", { name: "Yeni kod gönder" })).toBeEnabled();
  expect(confirmations).toEqual([]);
  expect(errors).toEqual([]);
});

test("an unlinked school address cannot become primary and a primary personal address without a fallback stays", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `email-refusals-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  await mockEmail(page, {
    email: personalEmail,
    emailVerified: true,
    primary: "personal",
    schoolEmail,
    verifiedYtu: false,
    personalEmail,
    personalEmailVerified: true,
  });
  await mockSudo(page);
  const removals: string[] = [];
  await page.route("**/api/account/email/personal", async (route) => {
    removals.push(route.request().method());
    if (removals.length === 1) {
      await route.fulfill({ status: 428, json: sudoChallenge });
      return;
    }
    await route.fulfill({
      status: 409,
      json: {
        error: "no_fallback_email",
        detail: "Kişisel e-postan birincil adresin ve yerine geçebilecek doğrulanmış bir okul e-postan yok; kaldırırsan giriş yapabileceğin bir adres kalmaz. Önce YTÜ hesabını bağla ve okul e-postanı birincil yap.",
      },
    });
  });

  await gotoEmail(page);
  const schoolRow = page.locator(".settings-row").filter({ hasText: schoolEmail }).first();
  await expect(schoolRow.getByText("Doğrulandı", { exact: true })).toHaveCount(0);
  await expect(schoolRow.getByRole("link", { name: "YTÜ hesabını bağla" })).toHaveAttribute("href", "/identity");
  const group = page.getByRole("group", { name: "Birincil e-posta" });
  const schoolOption = group.getByRole("radio", { name: /Okul e-postası/ });
  await expect(schoolOption).toBeDisabled();
  await expect(group).toContainText("YTÜ hesabın bağlanmadan birincil adres yapılamaz.");
  await expect(group.getByRole("link", { name: "YTÜ hesabını bağla" })).toHaveAttribute("href", "/identity");
  await expect(page.getByRole("button", { name: "Birincil adresi kaydet" })).toBeDisabled();

  await page.getByRole("button", { name: `${personalEmail} — Kaldır` }).click();
  const dialog = page.getByRole("dialog", { name: "Kişisel e-posta kaldırılsın mı?" });
  await dialog.getByRole("button", { name: "Kaldır" }).click();
  await completeSudoDialog(page);
  await expect(dialog.getByRole("alert")).toContainText("kaldırırsan giriş yapabileceğin bir adres kalmaz");
  await expect(dialog).toBeVisible();
  expect(removals).toEqual(["DELETE", "DELETE"]);
  expect(errors).toEqual([]);
});

test("the e-mail page with its forms and dialog passes axe and fits a 320px WebView", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one accessibility pass of every state is sufficient");
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
      await installAuthenticatedSession(context, `email-axe-${viewport.width}-${testInfo.retry}`);
      const page = await context.newPage();
      const errors = failOnPageErrors(page);
      const state: EmailState = {
        email: personalEmail,
        emailVerified: true,
        primary: "personal",
        schoolEmail: "ada.lovelace.with.a.rather.long.local.part@std.yildiz.edu.tr",
        verifiedYtu: false,
        personalEmail,
        personalEmailVerified: true,
      };
      await mockEmail(page, state);
      await mockSudo(page);
      await page.route("**/api/account/email/change-request", (route) => route.fulfill({
        status: 202,
        json: { expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() },
      }));
      await gotoEmail(page);

      const analyze = async (label: string) => {
        const overflow = await page.evaluate(() => ({
          body: document.body.scrollWidth - document.body.clientWidth,
          document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        }));
        expect(overflow.body, `${label}: body must not overflow horizontally`).toBeLessThanOrEqual(1);
        expect(overflow.document, `${label}: document must not overflow horizontally`).toBeLessThanOrEqual(1);
        const accessibility = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        expect(accessibility.violations, `${label}: ${JSON.stringify(accessibility.violations, null, 2)}`).toEqual([]);
      };

      await analyze("read view");

      await page.getByRole("button", { name: `${personalEmail} — Kaldır` }).click();
      const dialog = page.getByRole("dialog", { name: "Kişisel e-posta kaldırılsın mı?" });
      await expect(dialog).toBeVisible();
      await analyze("remove dialog");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();

      // Without a personal address the add form and the code panel appear.
      state.personalEmail = null;
      state.personalEmailVerified = false;
      state.primary = "none";
      await gotoEmail(page);
      await openAddForm(page);
      await analyze("add form");
      await page.getByRole("form", { name: "Kişisel e-posta ekle" }).getByLabel("E-posta adresi").fill("ada.new@example.com");
      await page.getByRole("form", { name: "Kişisel e-posta ekle" }).getByRole("button", { name: "Kod gönder" }).click();
      await expect(page.getByRole("form", { name: "Doğrulama kodunu gir" })).toBeVisible();
      await analyze("code panel");

      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
