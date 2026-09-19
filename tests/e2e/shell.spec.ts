import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { seedAuthenticatedSession, sessionExists } from "./auth-session";

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
    await page.waitForLoadState("networkidle");
    const browserStorage = await page.evaluate(() => ({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    }));
    const exposed = [
      await page.content(),
      ...(await Promise.all(responseBodies)),
      JSON.stringify(browserStorage),
    ].join("\n");
    for (const canary of canaries) expect(exposed).not.toContain(canary);
    expect([...coveredResourceTypes]).toEqual(
      expect.arrayContaining(["document", "fetch", "script"]),
    );
  };
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

test("mobile protected pages preserve the safe return path without a session", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only assertion");
  await page.goto("/sessions");

  await expect(page).toHaveURL(/\/login\?returnTo=%2Fsessions$/);
  await expect(page.getByRole("link", { name: "SKY LAB ile giriş yap" })).toHaveAttribute(
    "href",
    "/api/auth/login?returnTo=%2Fsessions",
  );
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
  let refreshRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/auth/session/refresh")) refreshRequests += 1;
  });
  await page.clock.install();
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Hesabın, tek ve güvenli bir merkezde." })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Hesap ayarları" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "İçeriğe geç" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

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
  await page.clock.fastForward(5 * 60 * 1_000);
  await expect.poll(() => refreshRequests).toBeGreaterThan(requestsBeforeInterval);

  await page.getByRole("link", { name: "Giriş ve güvenlik" }).first().click();
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
  await page.goto("/");
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
