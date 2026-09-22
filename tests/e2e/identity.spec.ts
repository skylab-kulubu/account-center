import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test } from "@playwright/test";
import type { BrowserContext, Page, Request as PlaywrightRequest } from "@playwright/test";
import { seedAuthenticatedSession } from "./auth-session";

/**
 * The identity page in the browser: the Verified YTÜ lock, the name change
 * with its core mirror, the username change behind the confirmation dialog
 * and the real Sudo mode dialog, and the YTÜ link's round trip. The BFF
 * routes under `/api/account/identity*` and `/api/account/sudo/*` are
 * answered by `page.route` in the shapes `src/server/identity/routes.ts`,
 * `src/server/identity/ytu-link.ts` and `src/server/auth/sudo-routes.ts`
 * produce (the handlers themselves, including the core mirror, its soft
 * failure and the link's callback, are covered by their unit tests against
 * the sky-account fixtures); the session, shell, page, forms and dialogs run
 * for real. No request may leave for `e.yildizskylab.com` except the link's
 * own navigation, which a stand-in authorization endpoint answers in-browser.
 */

const baseUrl = "https://127.0.0.1:3100";
const keycloakHost = "e.yildizskylab.com";
const sessionCookieName = "__Host-sky-account";
const csrfToken = "e2e-identity-csrf";
const sudoPassword = "hunter2-correct-horse-staple";

type Identity = {
  firstName: string | null;
  lastName: string | null;
  nameLocked: boolean;
  username: string;
  usernameChangeAvailableAt: string | null;
  verifiedYtu: boolean;
  schoolEmail: string | null;
  email: string | null;
  emailVerified: boolean;
};

const verified: Identity = {
  firstName: "Ada",
  lastName: "Lovelace",
  nameLocked: true,
  username: "ada.lovelace",
  usernameChangeAvailableAt: null,
  verifiedYtu: true,
  schoolEmail: "ada@std.yildiz.edu.tr",
  email: "ada@std.yildiz.edu.tr",
  emailVerified: true,
};

const unverified: Identity = {
  ...verified,
  nameLocked: false,
  verifiedYtu: false,
  schoolEmail: null,
  email: "ada@example.invalid",
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

async function gotoIdentity(page: Page, path = "/identity") {
  const refresh = page.waitForResponse((response) => response.url().endsWith("/api/auth/session/refresh"));
  const response = await page.goto(path);
  expect((await refresh).status()).toBe(204);
  await expect(page.getByRole("heading", { level: 1, name: "Kimlik" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  return response;
}

/** Refused names, taken usernames and the sudo challenge answer 4xx on purpose; the browser logs those as resource errors. */
const expectedRejectionLog = /Failed to load resource: the server responded with a status of (?:400|401|403|409|428|429)/;

function failOnPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !expectedRejectionLog.test(message.text())) errors.push(message.text());
  });
  return errors;
}

/** Records every request the page makes so the flows can prove nothing went to Keycloak. */
function recordRequests(page: Page) {
  const requests: PlaywrightRequest[] = [];
  page.on("request", (request) => requests.push(request));
  return {
    hosts: () => new Set(requests.map((request) => new URL(request.url()).hostname)),
    urls: () => requests.map((request) => request.url()),
  };
}

/** The identity read, answered from a mutable record so a re-read after a change shows the server's state. */
async function mockIdentity(page: Page, identity: Identity) {
  await page.route("**/api/account/identity", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { ...identity, csrfToken } });
  });
}

/** Sudo mode answered by the BFF mocks; the dialog itself is the real component. */
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

test("a Verified YTÜ account sees the locked name, the YTÜ link and the e-mail rows; the old path redirects", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `identity-locked-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  const network = recordRequests(page);
  await mockIdentity(page, verified);

  const landed = await gotoIdentity(page, "/personal-information");
  await expect(page).toHaveURL(`${baseUrl}/identity`);
  const redirect = landed?.request().redirectedFrom();
  expect(redirect?.url()).toBe(`${baseUrl}/personal-information`);
  const redirectResponse = await redirect?.response();
  expect(redirectResponse?.status()).toBe(308);
  expect(redirectResponse?.headers().location).toBe("/identity");
  await expect(page.getByRole("link", { name: "Kimlik" })).toHaveAttribute("aria-current", "page");

  await expect(page.getByText("Ada Lovelace")).toBeVisible();
  await expect(page.getByText("YTÜ hesabından gelir; yönetim ekibi düzeltebilir.")).toBeVisible();
  await expect(page.getByText("YTÜ kaydından", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Adı düzenle" })).toHaveCount(0);
  await expect(page.locator("input[name='firstName'], input[name='lastName']")).toHaveCount(0);

  await expect(page.getByText("ada.lovelace", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Kullanıcı adını değiştir" })).toBeEnabled();

  await expect(page.getByText("Doğrulanmış YTÜ hesabı", { exact: true })).toBeVisible();
  await expect(page.getByText(/ada@std\.yildiz\.edu\.tr adresiyle bağlı/)).toBeVisible();
  await expect(page.getByRole("button", { name: "YTÜ hesabımı bağla" })).toHaveCount(0);

  await expect(page.getByText("Birincil e-posta")).toBeVisible();
  await expect(page.getByText("Okul e-postası")).toBeVisible();
  await expect(page.getByRole("button", { name: "E-posta ayarları" })).toBeDisabled();
  await expect(page.locator("a[href='/email']")).toHaveCount(0);
  // The page itself never asks for Sudo mode.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  expect(await page.content()).not.toContain(csrfToken);
  expect(network.hosts().has(keycloakHost)).toBe(false);
  expect(errors).toEqual([]);
});

test("an unverified account edits its name in place; the core mirror's soft failure is announced", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `identity-name-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  const network = recordRequests(page);
  const identity: Identity = { ...unverified };
  await mockIdentity(page, identity);
  const attempts: Array<{ headers: Record<string, string>; body: { firstName: string; lastName: string } }> = [];
  await page.route("**/api/account/identity/name", async (route) => {
    const body = route.request().postDataJSON() as { firstName: string; lastName: string };
    attempts.push({ headers: await route.request().allHeaders(), body });
    identity.firstName = body.firstName;
    identity.lastName = body.lastName;
    // The first change reaches Keycloak but not core; the second is mirrored.
    await route.fulfill({ json: { coreSync: attempts.length === 1 ? "failed" : "synced" } });
  });

  await gotoIdentity(page);
  await expect(page.getByText("YTÜ hesabın bağlı değil")).toBeVisible();
  await expect(page.getByRole("button", { name: "YTÜ hesabımı bağla" })).toBeEnabled();
  // Only the e-mail settings are still "yakında".
  await expect(page.getByText("Yakında", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "E-posta ayarları" })).toBeDisabled();

  const trigger = page.getByRole("button", { name: "Adı düzenle" });
  await trigger.click();
  const form = page.getByRole("form", { name: "Adı düzenle" });
  await expect(form).toBeVisible();
  const first = form.getByLabel("Ad", { exact: true });
  const last = form.getByLabel("Soyad", { exact: true });
  await expect(first).toBeFocused();
  await expect(first).toHaveValue("Ada");
  await expect(last).toHaveValue("Lovelace");

  // Invisible characters are refused before any request leaves the browser.
  await first.fill("Ada​Augusta");
  await form.getByRole("button", { name: "Adı kaydet" }).click();
  await expect(form.getByRole("alert")).toContainText("Ad görünmez, biçimlendirme ya da kontrol karakteri içeremez.");
  await expect(first).toBeFocused();
  expect(attempts).toHaveLength(0);

  await first.fill("  Augusta   Ada ");
  await last.fill("King");
  await form.getByRole("button", { name: "Adı kaydet" }).click();
  const notice = page.getByRole("status").filter({ hasText: "İşlem tamamlandı" });
  await expect(notice).toContainText("Adın güncellendi.");
  await expect(notice).toContainText("Kulüp profilindeki adın daha sonra eşitlenecek.");
  await expect(notice).toBeFocused();
  await expect(form).toBeHidden();
  await expect(page.getByText("Augusta Ada King")).toBeVisible();

  await page.getByRole("button", { name: "Adı düzenle" }).click();
  await page.getByRole("form", { name: "Adı düzenle" }).getByLabel("Soyad", { exact: true }).fill("Byron");
  await page.getByRole("form", { name: "Adı düzenle" }).getByRole("button", { name: "Adı kaydet" }).click();
  const second = page.getByRole("status").filter({ hasText: "İşlem tamamlandı" });
  await expect(second).toContainText("Adın güncellendi.");
  await expect(second).not.toContainText("daha sonra eşitlenecek");
  await expect(page.getByText("Augusta Ada Byron")).toBeVisible();

  expect(attempts.map(({ body }) => body)).toEqual([
    { firstName: "Augusta Ada", lastName: "King" },
    { firstName: "Augusta Ada", lastName: "Byron" },
  ]);
  for (const attempt of attempts) {
    expect(attempt.headers["x-csrf-token"]).toBe(csrfToken);
    expect(attempt.headers.origin).toBe(baseUrl);
    expect(attempt.headers["content-type"]).toBe("application/json");
  }
  // A name change never asks for Sudo mode.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(network.urls().some((url) => url.includes("/api/account/sudo/"))).toBe(false);
  expect(network.hosts().has(keycloakHost)).toBe(false);
  expect(errors).toEqual([]);
});

test("username change: confirmation dialog, 428 → sudo dialog → success, then taken and cooldown answers", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `identity-username-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  const network = recordRequests(page);
  const identity: Identity = { ...verified };
  await mockIdentity(page, identity);
  const proofs = await mockSudo(page);
  const attempts: Array<{ headers: Record<string, string>; body: { username: string } }> = [];
  await page.route("**/api/account/identity/username", async (route) => {
    const body = route.request().postDataJSON() as { username: string };
    attempts.push({ headers: await route.request().allHeaders(), body });
    if (attempts.length === 1) {
      await route.fulfill({ status: 428, json: { error: "sudo_required", reason: "missing", methods: ["password"], fallback: null } });
      return;
    }
    if (body.username === "taken.name") {
      await route.fulfill({ status: 409, json: { error: "username_taken", detail: "Bu kullanıcı adı kullanılıyor.", field: "username" } });
      return;
    }
    if (body.username === "too.soon") {
      await route.fulfill({
        status: 409,
        headers: { "retry-after": "604800" },
        json: {
          error: "username_cooldown",
          detail: "Kullanıcı adını 14 günde bir değiştirebilirsin.",
          retryAfter: 604_800,
          availableAt: "2099-09-28T13:10:41.000Z",
        },
      });
      return;
    }
    identity.username = body.username;
    await route.fulfill({ status: 204 });
  });
  const responseBodies: Array<Promise<string>> = [];
  page.on("response", (response) => {
    if (new URL(response.url()).origin === baseUrl) responseBodies.push(response.text().catch(() => ""));
  });

  await gotoIdentity(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "Kullanıcı adını değiştir" });
  await trigger.click();
  const form = page.getByRole("form", { name: "Kullanıcı adını değiştir" });
  await expect(form).toBeVisible();
  const input = form.getByLabel("Yeni kullanıcı adı");
  await expect(input).toBeFocused();

  await input.fill("ab");
  await form.getByRole("button", { name: "Devam et" }).click();
  await expect(form.getByRole("alert")).toContainText("Kullanıcı adı en az 3 karakter olmalı.");
  expect(attempts).toHaveLength(0);

  await input.fill("Ada.Byron");
  await expect(input).toHaveValue("ada.byron");
  await form.getByRole("button", { name: "Devam et" }).click();
  const confirmation = page.getByRole("dialog", { name: "Kullanıcı adın değişsin mi?" });
  await expect(confirmation).toBeVisible();
  await expect.poll(() => confirmation.evaluate((element) => element.matches(":modal"))).toBe(true);
  await expect(confirmation).toContainText("Yeni kullanıcı adın ada.byron olacak.");
  await expect(confirmation).toContainText("Giriş yaparken yeni adını kullanacaksın.");
  await expect(confirmation).toContainText("Eski adın boşa çıkar ve başkası alabilir.");
  await expect(confirmation).toContainText("Kullanıcı adını 14 günde bir değiştirebilirsin.");
  expect(attempts).toHaveLength(0);

  // Escape cancels: nothing was sent and the field keeps the value.
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("ada.byron");
  expect(attempts).toHaveLength(0);

  await form.getByRole("button", { name: "Devam et" }).click();
  await confirmation.getByRole("button", { name: "Onayla ve doğrula" }).click();
  // The first request is deliberately answered 428: the real Sudo mode dialog opens, then the same body is retried.
  await completeSudoDialog(page);
  const notice = page.getByRole("status").filter({ hasText: "İşlem tamamlandı" });
  await expect(notice).toContainText("Kullanıcı adın ada.byron olarak değiştirildi. Bundan sonra giriş yaparken bu adı kullan.");
  await expect(notice).toBeFocused();
  await expect(form).toBeHidden();
  await expect(page.getByText("ada.byron", { exact: true })).toBeVisible();
  expect(proofs).toEqual([{ password: sudoPassword }]);
  expect(attempts.map(({ body }) => body)).toEqual([{ username: "ada.byron" }, { username: "ada.byron" }]);

  // A taken name lands on the field; the form stays open.
  await page.getByRole("button", { name: "Kullanıcı adını değiştir" }).click();
  const retry = page.getByRole("form", { name: "Kullanıcı adını değiştir" });
  await retry.getByLabel("Yeni kullanıcı adı").fill("taken.name");
  await retry.getByRole("button", { name: "Devam et" }).click();
  await page.getByRole("dialog", { name: "Kullanıcı adın değişsin mi?" }).getByRole("button", { name: "Onayla ve doğrula" }).click();
  await expect(retry.getByRole("alert")).toContainText("Bu kullanıcı adı kullanılıyor.");
  await expect(retry.getByLabel("Yeni kullanıcı adı")).toHaveAttribute("aria-invalid", "true");
  await expect(retry).toBeVisible();

  // The cooldown answer names the next allowed moment in Turkish.
  await retry.getByLabel("Yeni kullanıcı adı").fill("too.soon");
  await retry.getByRole("button", { name: "Devam et" }).click();
  await page.getByRole("dialog", { name: "Kullanıcı adın değişsin mi?" }).getByRole("button", { name: "Onayla ve doğrula" }).click();
  await expect(retry.getByRole("alert")).toContainText("Kullanıcı adını 14 günde bir değiştirebilirsin.");
  await expect(retry.getByRole("alert")).toContainText(/en erken 28 Eylül 2099 16:10 tarihinde yeniden değiştirebilirsin \(\d+ gün sonra\)/);
  // The second sudo proof was still fresh: no further dialog was needed.
  expect(proofs).toHaveLength(1);

  for (const attempt of attempts) {
    expect(attempt.headers["x-csrf-token"]).toBe(csrfToken);
    expect(attempt.headers.origin).toBe(baseUrl);
    expect(attempt.headers["content-type"]).toBe("application/json");
  }
  const markup = await page.content();
  const exposed = [
    markup,
    ...(await Promise.all(responseBodies)),
    await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), location.href])),
  ].join("\n");
  expect(exposed).not.toContain(sudoPassword);
  // The CSRF proof travels only in the JSON answers the page fetches, never in the markup or storage.
  expect(markup).not.toContain(csrfToken);
  expect(page.url()).toBe(`${baseUrl}/identity`);
  expect(network.hosts().has(keycloakHost)).toBe(false);
  expect(network.urls().some((url) => url.includes("kc_action"))).toBe(false);
  expect(errors).toEqual([]);
});

/**
 * The Keycloak side of "YTÜ hesabımı bağla" as the browser sees it. The BFF's
 * pushed authorization request is server-to-server and is asserted in
 * `oidc-protocol.test.ts` (`kc_action=idp_link&kc_action_parameter=OBS`,
 * no `prompt`); the harness pins `OIDC_ISSUER` to the production realm and
 * makes no network call to it, so the authorization endpoint is answered here:
 * it records the navigation the page made and sends the person back the way
 * the BFF callback does after a verified link, `303` to `/identity?ytu=…`.
 */
const authorizationUrl = `https://${keycloakHost}/realms/e-skylab/protocol/openid-connect/auth?client_id=account-center&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Ae2e-ytu-link`;

async function mockKeycloakAuthorization(page: Page, onArrival: () => "linked" | "cancelled" | "error") {
  const arrivals: string[] = [];
  await page.route((url) => url.hostname === keycloakHost, async (route) => {
    arrivals.push(route.request().url());
    await route.fulfill({
      status: 303,
      headers: { location: `${baseUrl}/identity?ytu=${onArrival()}` },
    });
  });
  return arrivals;
}

async function openYtuDialog(page: Page) {
  await page.getByRole("button", { name: "YTÜ hesabımı bağla" }).click();
  const dialog = page.getByRole("dialog", { name: "YTÜ hesabın bağlansın mı?" });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((element) => element.matches(":modal"))).toBe(true);
  return dialog;
}

/** The start route's `428` challenge, which the page answers by opening the real Sudo mode dialog. */
const sudoChallenge = { error: "sudo_required", reason: "missing", methods: ["password"], fallback: null };

test("YTÜ link: the consequences dialog, the start call, the Keycloak round trip and the linked, locked result", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `identity-ytu-link-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  const network = recordRequests(page);
  const identity: Identity = { ...unverified };
  await mockIdentity(page, identity);
  const proofs = await mockSudo(page);
  const starts: Array<{ headers: Record<string, string>; body: string | null }> = [];
  await page.route("**/api/account/identity/ytu-link", async (route) => {
    starts.push({ headers: await route.request().allHeaders(), body: route.request().postData() });
    // The first attempt is deliberately answered 428: the real Sudo mode dialog opens, then the start is retried.
    if (starts.length === 1) {
      await route.fulfill({ status: 428, json: sudoChallenge });
      return;
    }
    await route.fulfill({ json: { authorizationUrl } });
  });
  // Keycloak links the Microsoft account and the realm now reports the person as verified.
  const arrivals = await mockKeycloakAuthorization(page, () => {
    Object.assign(identity, verified);
    return "linked";
  });

  await gotoIdentity(page);
  const dialog = await openYtuDialog(page);
  await expect(dialog).toContainText("Microsoft ile YTÜ hesabına giriş yapacaksın. Devam etmeden önce şunları bil:");
  await expect(dialog).toContainText("Bağlandıktan sonra adın ve okul e-postan YTÜ kaydından gelir ve buradan değiştirilemez.");
  await expect(dialog).toContainText("Okul e-postan, giriş yaptığın YTÜ Microsoft hesabındaki adres olur.");
  await expect(dialog).toContainText("Bağlantı kalıcıdır; buradan kaldırılamaz.");
  expect(starts).toHaveLength(0);

  // Escape cancels: nothing was sent and the trigger regains focus.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "YTÜ hesabımı bağla" })).toBeFocused();
  expect(starts).toHaveLength(0);

  await openYtuDialog(page);
  await dialog.getByRole("button", { name: "Onayla ve devam et" }).click();
  await completeSudoDialog(page);
  const notice = page.getByRole("status").filter({ hasText: "YTÜ hesabın bağlandı" });
  await expect(notice).toContainText("Adın ve okul e-postan artık YTÜ kaydından gelir ve buradan değiştirilemez.");
  await expect(notice).toBeFocused();
  await expect(page).toHaveURL(`${baseUrl}/identity`);

  // Sudo mode ran between the two starts; both carried the session proof and no body.
  expect(proofs).toEqual([{ password: sudoPassword }]);
  expect(starts).toHaveLength(2);
  for (const start of starts) {
    expect(start.headers["x-csrf-token"]).toBe(csrfToken);
    expect(start.headers.origin).toBe(baseUrl);
    expect(start.body).toBeNull();
  }
  expect(arrivals).toEqual([authorizationUrl]);
  const arrival = new URL(arrivals[0]!);
  expect([...arrival.searchParams.keys()].sort()).toEqual(["client_id", "request_uri"]);
  expect(arrival.href).not.toContain("kc_action");
  expect(network.urls().filter((url) => new URL(url).hostname === keycloakHost)).toEqual([authorizationUrl]);

  // The page shows the server's identity after the link: locked name, verified badge, no link button.
  await expect(page.getByText("Doğrulanmış YTÜ hesabı", { exact: true })).toBeVisible();
  await expect(page.getByText(/ada@std\.yildiz\.edu\.tr adresiyle bağlı/)).toBeVisible();
  await expect(page.getByText("YTÜ kaydından", { exact: true })).toBeVisible();
  await expect(page.getByText("YTÜ hesabından gelir; yönetim ekibi düzeltebilir.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Adı düzenle" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "YTÜ hesabımı bağla" })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.content()).not.toContain(csrfToken);
  expect(errors).toEqual([]);
});

test("YTÜ link: a cancelled or failed round trip is announced, stripped from the address and can be retried", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `identity-ytu-cancel-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  await mockIdentity(page, unverified);
  await mockSudo(page);
  await page.route("**/api/account/identity/ytu-link", (route) => route.fulfill({ json: { authorizationUrl } }));
  const outcomes: Array<"cancelled" | "error"> = ["cancelled", "error"];
  await mockKeycloakAuthorization(page, () => outcomes.shift() ?? "error");

  await gotoIdentity(page);
  const dialog = await openYtuDialog(page);
  await dialog.getByRole("button", { name: "Onayla ve devam et" }).click();
  const cancelled = page.getByRole("status").filter({ hasText: "Bağlama tamamlanmadı" });
  await expect(cancelled).toContainText("Hesabında değişiklik yapılmadı. İstediğinde yeniden deneyebilirsin.");
  await expect(cancelled).toBeFocused();
  await expect(page).toHaveURL(`${baseUrl}/identity`);
  await expect(page.getByText("YTÜ hesabın bağlı değil")).toBeVisible();
  await expect(page.getByRole("button", { name: "Adı düzenle" })).toBeEnabled();

  // Retry: the same button, this time the IdP round trip fails. (The page has
  // just come back from a full navigation, so wait for the row, not the
  // network: `next dev` keeps its HMR socket busy and never goes idle.)
  await expect(page.getByRole("button", { name: "YTÜ hesabımı bağla" })).toBeEnabled();
  const retry = await openYtuDialog(page);
  await retry.getByRole("button", { name: "Onayla ve devam et" }).click();
  const failed = page.getByRole("status").filter({ hasText: "YTÜ hesabı bağlanamadı" });
  await expect(failed).toContainText("bu Microsoft hesabı başka bir SKY LAB hesabına bağlı");
  await expect(page).toHaveURL(`${baseUrl}/identity`);
  await expect(page.getByRole("button", { name: "YTÜ hesabımı bağla" })).toBeEnabled();

  // The BFF's own answer for a link Keycloak claimed but the identity does not show.
  await gotoIdentity(page, "/identity?ytu=unverified");
  await expect(page.getByRole("status").filter({ hasText: "Bağlantı doğrulanamadı" })).toContainText("Bu sayfa güncel durumu gösterir");
  await expect(page).toHaveURL(`${baseUrl}/identity`);

  // A crafted address cannot make the page claim a link the identity does not show.
  await gotoIdentity(page, "/identity?ytu=linked");
  await expect(page.getByText("YTÜ hesabın bağlı değil")).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page).toHaveURL(`${baseUrl}/identity`);
  expect(errors).toEqual([]);
});

test("a running cooldown disables the username change and says when it reopens", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `identity-cooldown-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  const availableAt = new Date(Date.now() + 5 * 24 * 60 * 60_000).toISOString();
  await mockIdentity(page, { ...verified, usernameChangeAvailableAt: availableAt });

  await gotoIdentity(page);
  const button = page.getByRole("button", { name: "Kullanıcı adını değiştir" });
  await expect(button).toBeDisabled();
  await expect(page.getByText(/Kullanıcı adını en erken .+ tarihinde yeniden değiştirebilirsin \(5 gün sonra\)\./)).toBeVisible();
  await expect(page.getByRole("form")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the identity page with its forms and dialog passes axe and fits a 320px WebView", async ({ browser }, testInfo) => {
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
      await installAuthenticatedSession(context, `identity-axe-${viewport.width}-${testInfo.retry}`);
      const page = await context.newPage();
      const errors = failOnPageErrors(page);
      await mockIdentity(page, unverified);
      await gotoIdentity(page);

      const overflowOf = () => page.evaluate(() => ({
        body: document.body.scrollWidth - document.body.clientWidth,
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      const analyze = async (state: string) => {
        const overflow = await overflowOf();
        expect(overflow.body, `${state}: body must not overflow horizontally`).toBeLessThanOrEqual(1);
        expect(overflow.document, `${state}: document must not overflow horizontally`).toBeLessThanOrEqual(1);
        const accessibility = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        expect(accessibility.violations, `${state}: ${JSON.stringify(accessibility.violations, null, 2)}`).toEqual([]);
      };

      await analyze("read view");

      await page.getByRole("button", { name: "Adı düzenle" }).click();
      await expect(page.getByRole("form", { name: "Adı düzenle" })).toBeVisible();
      await analyze("name form");
      await page.getByRole("form", { name: "Adı düzenle" }).getByRole("button", { name: "Vazgeç" }).click();

      await page.getByRole("button", { name: "Kullanıcı adını değiştir" }).click();
      const form = page.getByRole("form", { name: "Kullanıcı adını değiştir" });
      await form.getByLabel("Yeni kullanıcı adı").fill("ada.byron");
      await form.getByRole("button", { name: "Devam et" }).click();
      await expect(page.getByRole("dialog", { name: "Kullanıcı adın değişsin mi?" })).toBeVisible();
      await analyze("confirmation dialog");
      await page.keyboard.press("Escape");
      await form.getByRole("button", { name: "Vazgeç" }).click();

      const ytuDialog = await openYtuDialog(page);
      await analyze("YTÜ link dialog");
      await page.keyboard.press("Escape");
      await expect(ytuDialog).toBeHidden();

      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
