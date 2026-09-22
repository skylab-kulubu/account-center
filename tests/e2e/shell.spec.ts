import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import {
  seedAuthenticatedSession,
  sessionExists,
  sessionState,
  setSubjectGateMarker,
} from "./auth-session";

const baseUrl = "https://127.0.0.1:3100";
const sessionCookieName = "__Host-sky-account";

function failOnPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

/**
 * Posts an injected form the way a native WebView would and waits for the
 * resulting address. The dev server can still reload the freshly compiled
 * page once, which discards a navigation started from the old document, so
 * the submit is repeated on the new one (every mocked answer is idempotent).
 */
async function submitInjectedForm(page: Page, action: string, expectedUrl: RegExp) {
  await expect(async () => {
    await page.evaluate((target) => {
      const form = document.createElement("form");
      form.method = "post";
      form.action = target;
      document.body.append(form);
      form.submit();
    }, action);
    await expect(page).toHaveURL(expectedUrl, { timeout: 5_000 });
  }).toPass({ timeout: 20_000 });
}

async function gotoAuthenticatedPage(page: Page, url: string) {
  const refreshResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/session/refresh"),
  );
  await page.goto(url);
  const refreshResponse = await refreshResponsePromise;
  expect(refreshResponse.status()).toBe(204);
  // The dev server may still compile and reload the route on first use; settle before scripting the page.
  await page.waitForLoadState("networkidle");
}

function monitorTokenCanaries(page: Page, canaries: string[]) {
  const responseBodies: Array<Promise<string>> = [];
  const coveredResourceTypes = new Set<string>();
  page.on("response", (response) => {
    if (new URL(response.url()).origin !== baseUrl) return;
    const resourceType = response.request().resourceType();
    if (!["document", "fetch", "xhr", "script"].includes(resourceType)) return;
    coveredResourceTypes.add(resourceType === "xhr" ? "fetch" : resourceType);
    responseBodies.push(response.body().then((body) => body.toString("utf8")).catch(() => ""));
  });

  return async () => {
    let browserSnapshot: {
      html: string;
      local: Array<[string, string]>;
      session: Array<[string, string]>;
      pathname: string;
      heading: string | null;
    } | undefined;
    await expect(async () => {
      const candidate = await page.evaluate(() => ({
        html: document.documentElement.outerHTML,
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
        pathname: window.location.pathname,
        heading: document.querySelector("h1")?.textContent?.trim() ?? null,
      }));
      expect(candidate.pathname).toBe("/security");
      expect(candidate.heading).toBe("Giriş ve güvenlik");
      browserSnapshot = candidate;
    }).toPass({ timeout: 10_000 });
    expect(browserSnapshot).toBeDefined();
    const exposed = [
      browserSnapshot!.html,
      ...(await Promise.all(responseBodies)),
      JSON.stringify({
        local: browserSnapshot!.local,
        session: browserSnapshot!.session,
      }),
    ].join("\n");
    for (const canary of canaries) expect(exposed).not.toContain(canary);
    expect([...coveredResourceTypes]).toEqual(
      expect.arrayContaining(["document", "fetch", "script"]),
    );
  };
}

/**
 * The security page reads `/api/account/security`, which needs a real user
 * token; the seeded session carries canaries, so the inventory is answered
 * here in the shape `src/server/security/routes.ts` produces.
 */
async function mockSecurityInventory(page: Page) {
  await page.route("**/api/account/security", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        password: true,
        totp: [],
        passkeys: [],
        sudo: { methods: ["password"], fallback: null, active: null },
        csrfToken: "session-bound-csrf",
      },
    });
  });
}

async function installAuthenticatedSession(
  context: BrowserContext,
  project: string,
  options: { includeRefreshToken?: boolean } = {},
) {
  const fixture = await seedAuthenticatedSession(project, options);

  await context.addCookies([
    {
      name: sessionCookieName,
      value: fixture.handle,
      url: baseUrl,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      expires: Math.floor(Date.now() / 1_000) + 8 * 60 * 60,
    },
  ]);

  const cookie = (await context.cookies(baseUrl)).find(
    (candidate) => candidate.name === sessionCookieName,
  );
  expect(cookie).toMatchObject({
    value: fixture.handle,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });
  return fixture;
}

test("desktop protected pages require OIDC login without a session", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  const errors = failOnPageErrors(page);
  await page.goto("/");

  await expect(page).toHaveURL(/\/login\?returnTo=%2F$/);
  await expect(page.getByRole("heading", { name: "Hesap Merkezi’ne giriş yap" })).toBeVisible();
  await expect(page.getByRole("link", { name: "SKY LAB ile giriş yap" })).toHaveAttribute(
    "href",
    "/api/auth/login?returnTo=%2F",
  );
  expect(errors).toEqual([]);
});

test("account deletion remains visibly inert while the production rollout flag is off", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `delete-off-${testInfo.retry}`);

  await gotoAuthenticatedPage(page, "/delete-account");

  await expect(page.getByRole("heading", { name: "Hesabı sil" })).toBeVisible();
  await expect(page.getByText("Silme akışı henüz etkin değil")).toBeVisible();
  await expect(page.getByRole("button", { name: "Kimliğimi yeniden doğrula" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Hesabımı kalıcı olarak sil" })).toHaveCount(0);
});

test("public deletion status works without a session and never renders its receipt", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  const receipt = `adr_${"r".repeat(43)}`;
  await context.addCookies([{
    name: "__Host-sky-account-delete-receipt",
    value: receipt,
    url: baseUrl,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  }]);
  await page.route("**/api/account/deletion/status", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      status: "processing",
      partial: true,
      updatedAt: "2026-09-20T12:00:02.000Z",
      completedAt: null,
      csrfToken: "c".repeat(43),
    }),
  }));

  await page.goto("/account-deletion");

  await expect(page).toHaveURL(`${baseUrl}/account-deletion`);
  await expect(page.getByRole("heading", { name: "Hesabın siliniyor" })).toBeVisible();
  await expect(page.getByText(/sayfayı kapatabilirsin/i)).toBeVisible();
  const browserSurface = await page.evaluate(() => [
    document.documentElement.outerHTML,
    JSON.stringify(Object.entries(localStorage)),
    JSON.stringify(Object.entries(sessionStorage)),
    window.location.href,
  ].join("\n"));
  expect(browserSurface).not.toContain(receipt);
});

test("uncertain native deletion submit navigates to sessionless recovery without losing its receipt", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only navigation regression");
  const localReceipt = "l".repeat(43);
  await context.addCookies([{
    name: "__Host-sky-account-delete-receipt",
    value: localReceipt,
    url: baseUrl,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  }]);
  await page.route("**/api/account/deletion/status", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "unavailable" }),
  }));
  await page.route("**/api/account/deletion", (route) => route.fulfill({
    status: 303,
    headers: {
      location: "/account-deletion?recovery=1",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
    body: "",
  }));
  await page.goto("/account-deletion");
  await page.waitForLoadState("networkidle");
  await submitInjectedForm(page, "/api/account/deletion", new RegExp(
    `^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/account-deletion(?:\\?recovery=1)?$`,
  ));
  await expect(page.getByRole("heading", { name: "Durum alınamadı" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Yeniden kontrol et" })).toBeVisible();
  expect(await page.content()).not.toContain(localReceipt);
  expect((await context.cookies()).find(
    (cookie) => cookie.name === "__Host-sky-account-delete-receipt",
  )?.value).toBe(localReceipt);
});

test("native deletion errors return to branded actionable recovery UI", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only navigation regression");
  await installAuthenticatedSession(context, `delete-errors-${testInfo.retry}`);
  await page.route("**/api/account/deletion/reauthenticate", (route) => route.fulfill({
    status: 303,
    headers: {
      location: "/delete-account?deletionError=reauth_unavailable",
      "cache-control": "no-store",
    },
    body: "",
  }));
  await gotoAuthenticatedPage(page, "/delete-account");
  await submitInjectedForm(page, "/api/account/deletion/reauthenticate", /\/delete-account\?deletionError=reauth_unavailable$/);
  await expect(page.getByRole("status")).toContainText("Yeniden doğrulama başlatılamadı");

  await page.route("**/api/account/deletion", (route) => route.fulfill({
    status: 303,
    headers: {
      location: "/delete-account?deletionError=proof_expired",
      "cache-control": "no-store",
    },
    body: "",
  }));
  await submitInjectedForm(page, "/api/account/deletion", /\/delete-account\?deletionError=proof_expired$/);
  await expect(page.getByRole("status")).toContainText("Doğrulama süren doldu");
  expect(await page.content()).not.toContain("provider unavailable");
});

test("mobile protected pages preserve the safe return path without a session", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only assertion");
  await page.goto("/sessions");

  await expect(page).toHaveURL(/\/login\?returnTo=%2Fsessions$/);
  await expect(page.getByRole("link", { name: "SKY LAB ile giriş yap" })).toHaveAttribute(
    "href",
    "/api/auth/login?returnTo=%2Fsessions",
  );
});

test("handoff responses keep the final assembled no-referrer policy", async ({ playwright }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one assembled-server assertion is sufficient");
  const request = await playwright.request.newContext({
    baseURL: baseUrl,
    ignoreHTTPSErrors: true,
  });

  try {
    const response = await request.get("/handoff?code=short", { maxRedirects: 0 });

    expect(response.status()).toBe(303);
    expect(response.headers()["referrer-policy"]).toBe("no-referrer");
    expect(response.headers()["cache-control"]).toContain("no-store");

    const health = await request.get("/api/health");
    expect(health.status()).toBe(200);
    expect(health.headers()["referrer-policy"]).toBe("same-origin");
  } finally {
    await request.dispose();
  }
});

test("desktop account shell keeps navigation, skip link, and rotates its secure session", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  const { handle: originalHandle, tokenCanaries } = await installAuthenticatedSession(
    context,
    `${testInfo.project.name}-${testInfo.retry}`,
    { includeRefreshToken: true },
  );
  const assertTokensStayedServerSide = monitorTokenCanaries(page, tokenCanaries);
  const errors = failOnPageErrors(page);
  await mockSecurityInventory(page);
  let refreshRequests = 0;
  let refreshResponses = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/auth/session/refresh")) refreshRequests += 1;
  });
  page.on("response", (response) => {
    if (response.url().endsWith("/api/auth/session/refresh")) refreshResponses += 1;
  });
  await page.clock.install();
  await gotoAuthenticatedPage(page, "/");

  await expect(page.getByRole("heading", { name: "Hesabın, tek ve güvenli bir merkezde." })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Hesap ayarları" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "İçeriğe geç" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(page).toHaveURL(/\/#main-content$/);

  await expect.poll(async () => {
    const cookie = (await context.cookies(baseUrl)).find(
      (candidate) => candidate.name === sessionCookieName,
    );
    return cookie?.value;
  }).not.toBe(originalHandle);
  const rotatedCookie = (await context.cookies(baseUrl)).find(
    (candidate) => candidate.name === sessionCookieName,
  );
  expect(rotatedCookie).toMatchObject({
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });

  await expect.poll(() => refreshRequests).toBeGreaterThanOrEqual(1);
  const requestsBeforeInterval = refreshRequests;
  const responsesBeforeInterval = refreshResponses;
  await page.clock.fastForward(5 * 60 * 1_000);
  await expect.poll(() => refreshRequests).toBeGreaterThan(requestsBeforeInterval);
  await expect.poll(() => refreshResponses).toBeGreaterThan(responsesBeforeInterval);

  await page.getByRole("navigation", { name: "Hesap ayarları" })
    .getByRole("link", { name: "Giriş ve güvenlik" })
    .click();
  await expect(page).toHaveURL(/\/security$/);
  await expect(page.getByRole("heading", { name: "Giriş ve güvenlik" })).toBeVisible();
  await assertTokensStayedServerSide();
  expect(errors).toEqual([]);
});

test("mobile authenticated detail pages keep the direct back affordance", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only assertion");
  await installAuthenticatedSession(context, `${testInfo.project.name}-${testInfo.retry}`);
  await page.goto("/sessions");

  await expect(page.getByRole("link", { name: "Hesap Merkezi özetine dön" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Oturumlar ve cihazlar" })).toBeVisible();
});

test("session management confirms a revoke and keeps the current browser signed in", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `sessions-${testInfo.retry}`);
  const reference = "s".repeat(43);
  const csrfToken = "e2e-session-bound-csrf";
  const current = {
    reference: null,
    startedAt: "2026-09-20T08:00:00.000Z",
    lastAccessAt: "2026-09-20T10:00:00.000Z",
    expiresAt: "2026-09-20T16:00:00.000Z",
    browser: "Chrome/140.0",
    current: true,
    device: { name: "MacBook", operatingSystem: "macOS", operatingSystemVersion: "15.6", mobile: false },
  };
  const other = {
    reference,
    startedAt: "2026-09-19T08:00:00.000Z",
    lastAccessAt: "2026-09-19T10:00:00.000Z",
    expiresAt: "2026-09-20T16:00:00.000Z",
    browser: "Mobile Safari/26.0",
    current: false,
    device: { name: "iPhone", operatingSystem: "iOS", operatingSystemVersion: "26.0", mobile: true },
  };
  let sessions = [current, other];
  let revokeHeaders: Record<string, string> | undefined;
  let revokeStatus: number | undefined;
  let bulkRevokeStatus: number | undefined;
  page.on("response", (response) => {
    if (
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === `/api/account/sessions/${reference}`
    ) revokeStatus = response.status();
    if (
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === "/api/account/sessions"
    ) bulkRevokeStatus = response.status();
  });
  await page.route(/\/api\/account\/sessions(?:\/[^/?]+)?(?:\?.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/account/sessions") {
      await route.fulfill({ json: { sessions, csrfToken } });
      return;
    }
    if (request.method() === "DELETE" && url.pathname === `/api/account/sessions/${reference}`) {
      revokeHeaders = await request.allHeaders();
      sessions = [current];
      await route.fulfill({ status: 204 });
      return;
    }
    if (request.method() === "DELETE" && url.pathname === "/api/account/sessions") {
      sessions = [current];
      await route.fulfill({ status: 204 });
      return;
    }
    await route.abort();
  });

  await page.goto("/sessions");
  await expect(page.getByText("MacBook · macOS · 15.6")).toBeVisible();
  await expect(page.getByText("iPhone · iOS · 26.0")).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain(reference);

  const revokeTrigger = page.getByRole("button", { name: "Oturumu kapat" });
  await revokeTrigger.click();
  const dialog = page.getByRole("dialog", { name: "Oturumu kapat" });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((element) => element.matches(":modal"))).toBe(true);
  await expect(dialog.getByRole("button", { name: "Pencereyi kapat" })).toBeFocused();
  expect(await page.evaluate(() => {
    const outside = document.querySelector<HTMLElement>(".account-sidebar a");
    outside?.focus();
    return document.activeElement === outside;
  })).toBe(false);
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(revokeTrigger).toBeFocused();

  await revokeTrigger.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Oturumu kapat" }).click();

  await expect.poll(() => revokeStatus).toBe(204);
  const singleSuccess = page.getByText("Oturum kapatıldı.");
  await expect(singleSuccess).toBeVisible();
  await expect(singleSuccess).toBeFocused();
  await expect(page.getByText("iPhone · iOS · 26.0")).toBeHidden();
  await expect(page.getByText("MacBook · macOS · 15.6")).toBeVisible();
  expect(revokeHeaders?.["x-csrf-token"]).toBe(csrfToken);
  expect(revokeHeaders?.origin).toBe(baseUrl);
  expect(
    (await context.cookies(baseUrl)).find((cookie) => cookie.name === sessionCookieName),
  ).toBeDefined();

  sessions = [current, other];
  await page.reload();
  const bulkTrigger = page.getByRole("button", { name: "Diğer tüm oturumları kapat" });
  await bulkTrigger.click();
  const bulkDialog = page.getByRole("dialog", { name: "Diğer tüm oturumları kapat" });
  await bulkDialog.getByRole("button", { name: "Diğer tüm oturumları kapat" }).click();

  await expect.poll(() => bulkRevokeStatus).toBe(204);
  await expect(page.getByText("Diğer oturumlar kapatıldı.")).toBeVisible();
  await expect(bulkTrigger).toBeFocused();
  await expect(bulkTrigger).toHaveAttribute("aria-disabled", "true");
});

test("reduced motion removes ambient animation in the authenticated shell", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "reduced-motion", "reduced-motion-only assertion");
  await installAuthenticatedSession(context, `${testInfo.project.name}-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  await page.goto("/");

  const duration = await page.locator(".background__bloom").evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).animationDuration),
  );
  expect(duration).toBeLessThanOrEqual(0.001);

  await page.evaluate(() => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.classList.add("logo-loader__path");
    path.dataset.logoGroup = "1";
    document.body.append(path);
  });
  const loaderPath = page.locator(".logo-loader__path");
  const loaderStyle = await loaderPath.evaluate((element) => {
    const style = getComputedStyle(element);
    return { duration: Number.parseFloat(style.animationDuration), opacity: style.opacity };
  });
  expect(loaderStyle.duration).toBeLessThanOrEqual(0.001);
  expect(loaderStyle.opacity).toBe("1");
  expect(errors).toEqual([]);
});

test("browser logout validates the form proof, clears the cookie, and hard-deletes the session", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  const { sessionId } = await installAuthenticatedSession(
    context,
    `logout-${testInfo.retry}`,
  );
  await gotoAuthenticatedPage(page, "/");
  await expect(page.getByRole("heading", { name: "Hesabın, tek ve güvenli bir merkezde." })).toBeVisible();

  const logoutRequestPromise = page.waitForRequest((request) =>
    request.url().endsWith("/api/auth/logout"),
  );
  const logoutResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/logout"),
  );
  await page.getByRole("button", { name: "Çıkış yap" }).first().click();
  const logoutRequest = await logoutRequestPromise;
  const logoutResponse = await logoutResponsePromise;
  const logoutHeaders = await logoutRequest.allHeaders();

  expect(logoutHeaders["origin"]).toBe(baseUrl);
  expect(logoutHeaders["sec-fetch-site"]).toBe("same-origin");
  expect(logoutResponse.status()).toBe(303);

  await expect(page).toHaveURL(/\/login\?loggedOut=1$/);
  await expect(page.getByText("Bu cihazdaki Hesap Merkezi oturumu kapatıldı.")).toBeVisible();
  expect(
    (await context.cookies(baseUrl)).find((cookie) => cookie.name === sessionCookieName),
  ).toBeUndefined();
  await expect.poll(() => sessionExists(sessionId)).toBe(false);
});

test("blocked session is revoked and clears its stale cookie without a redirect loop", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  const fixture = await installAuthenticatedSession(
    context,
    `blocked-${testInfo.retry}`,
  );
  await setSubjectGateMarker(fixture.subject, "1");
  let cleanupRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/auth/session/end")) cleanupRequests += 1;
  });

  await page.goto("/");

  await expect(page).toHaveURL(/\/login\?sessionEnded=1$/);
  await expect(page.getByRole("heading", { name: "Hesap Merkezi’ne giriş yap" })).toBeVisible();
  expect(cleanupRequests).toBe(1);
  expect(
    (await context.cookies(baseUrl)).find((cookie) => cookie.name === sessionCookieName),
  ).toBeUndefined();
  await expect.poll(async () => (await sessionState(fixture.sessionId))?.revoked_at !== null).toBe(true);
});

test("malformed gate state returns retryable 503 without touching the session", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  const fixture = await installAuthenticatedSession(
    context,
    `unavailable-${testInfo.retry}`,
  );
  const before = await sessionState(fixture.sessionId);
  await setSubjectGateMarker(fixture.subject, "unexpected");

  const unavailableResponse = page.waitForResponse((candidate) =>
    candidate.url().endsWith("/api/auth/unavailable"),
  );
  await page.goto("/");
  const response = await unavailableResponse;

  await expect(page).toHaveURL(/\/api\/auth\/unavailable$/);
  await expect(page.getByRole("heading", { name: "Hesap Merkezi şu anda kullanılamıyor" })).toBeVisible();
  expect(response?.status()).toBe(503);
  expect(response?.headers()["cache-control"]).toBe("no-store");
  expect(response?.headers()["retry-after"]).toBe("3");
  const after = await sessionState(fixture.sessionId);
  expect(after?.last_seen_at).toEqual(before?.last_seen_at);
  expect(after?.idle_expires_at).toEqual(before?.idle_expires_at);
  expect(after?.revoked_at).toBeNull();
});
