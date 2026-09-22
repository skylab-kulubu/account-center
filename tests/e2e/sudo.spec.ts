import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page, Route } from "@playwright/test";
import { seedAuthenticatedSession } from "./auth-session";

/**
 * Sudo mode in the browser. The BFF routes under `/api/account/sudo/*` are
 * answered by `page.route` in the shapes `src/server/auth/sudo-routes.ts`
 * produces (the route handlers themselves are covered by
 * `src/server/auth/sudo-routes.test.ts` against the sky-account fixtures);
 * the session, shell, dialog, tabs, keyboard behaviour and the WebAuthn
 * ceremony run for real.
 */

const baseUrl = "https://127.0.0.1:3100";
const sessionCookieName = "__Host-sky-account";
const csrfToken = "e2e-sudo-csrf";
const secretPassword = "hunter2-correct-horse-staple";
const requestEvent = "account-center:sudo-request";
const resultEvent = "account-center:sudo-result";

type MethodsBody = {
  methods: Array<"password" | "passkey" | "totp">;
  fallback: "microsoft" | null;
  active: null;
  csrfToken: string;
};

async function installAuthenticatedSession(context: BrowserContext, label: string, page?: Page) {
  const fixture = await seedAuthenticatedSession(label);
  // The security page reads its inventory from the BFF; the seeded session carries canary tokens, so answer it here.
  await page?.route("**/api/account/security", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: { password: true, totp: [], passkeys: [], sudo: { methods: ["password"], fallback: null, active: null }, csrfToken },
    });
  });
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

async function gotoAuthenticatedPage(page: Page, url: string) {
  const refresh = page.waitForResponse((response) => response.url().endsWith("/api/auth/session/refresh"));
  await page.goto(url);
  expect((await refresh).status()).toBe(204);
  // The dev server may still compile and reload the route on first use; settle before scripting the page.
  await page.waitForLoadState("networkidle");
}

/** Rejected proofs answer 401/423/429 on purpose; the browser logs those as resource errors. */
const expectedRejectionLog = /Failed to load resource: the server responded with a status of (?:401|423|429)/;

function failOnPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !expectedRejectionLog.test(message.text())) errors.push(message.text());
  });
  return errors;
}

/** Asks the provider for sudo like a non-React caller would and resolves with the result event. */
function requestSudo(page: Page) {
  return page.evaluate(([request, result]) => new Promise<{ verified: boolean; expiresAt: string | null }>((resolve) => {
    window.addEventListener(result, (event) => resolve((event as CustomEvent).detail), { once: true });
    window.dispatchEvent(new CustomEvent(request));
  }), [requestEvent, resultEvent] as const);
}

/**
 * Opens the dialog through the request event. The dev server can still
 * reload the freshly compiled route once, which drops the event listener
 * with the old document, so the request is repeated on the new one.
 */
async function openSudoDialog(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Kimliğini doğrula" });
  for (let attempt = 0; ; attempt += 1) {
    await page.evaluate((request) => window.dispatchEvent(new CustomEvent(request)), requestEvent).catch(() => undefined);
    try {
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      return dialog;
    } catch (error) {
      if (attempt >= 2) throw error;
      await page.waitForLoadState("networkidle");
    }
  }
}

/** Resolves with the provider's result event once the open dialog settles. */
function awaitSudoResult(page: Page) {
  return page.evaluate((result) => new Promise<{ verified: boolean; expiresAt: string | null }>((resolve) => {
    window.addEventListener(result, (event) => resolve((event as CustomEvent).detail), { once: true });
  }), resultEvent);
}

async function mockMethods(page: Page, body: MethodsBody) {
  await page.route("**/api/account/sudo/methods", (route) => route.fulfill({ json: body }));
}

function base64Url(value: Buffer) {
  return value.toString("base64url");
}

test("password sudo shows the server's Turkish rejection, then verifies and keeps the secret server-side", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `sudo-password-${testInfo.retry}`, page);
  const errors = failOnPageErrors(page);
  await mockMethods(page, { methods: ["password", "totp"], fallback: null, active: null, csrfToken });
  const attempts: Array<{ headers: Record<string, string>; body: unknown }> = [];
  await page.route("**/api/account/sudo/password", async (route) => {
    attempts.push({ headers: await route.request().allHeaders(), body: route.request().postDataJSON() });
    if (attempts.length === 1) {
      await route.fulfill({
        status: 401,
        json: { error: "invalid_credentials", detail: "Parola veya doğrulama kodu yanlış." },
      });
      return;
    }
    await route.fulfill({ json: { method: "password", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() } });
  });
  const responseBodies: Array<Promise<string>> = [];
  page.on("response", (response) => {
    if (new URL(response.url()).origin === baseUrl) {
      responseBodies.push(response.text().catch(() => ""));
    }
  });

  await gotoAuthenticatedPage(page, "/security");
  await expect(page.getByRole("heading", { name: "Giriş ve güvenlik" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const dialog = await openSudoDialog(page);
  const outcome = awaitSudoResult(page);
  await expect.poll(() => dialog.evaluate((element) => element.matches(":modal"))).toBe(true);
  await expect(dialog.getByRole("tab")).toHaveText(["Parola", "Doğrulama kodu"]);
  await expect(dialog.getByRole("tab", { name: "Parola" })).toHaveAttribute("aria-selected", "true");
  const password = dialog.getByRole("textbox", { name: "Parola" });
  await expect(password).toBeFocused();
  await expect(password).toHaveAttribute("type", "password");

  await password.fill("wrong-password");
  await dialog.getByRole("button", { name: "Doğrula" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Parola veya doğrulama kodu yanlış.");
  await expect(dialog).toBeVisible();
  await expect(password).toHaveValue("");

  await password.fill(secretPassword);
  await password.press("Enter");
  await expect(dialog).toBeHidden();
  expect(await outcome).toMatchObject({ verified: true });

  expect(attempts).toHaveLength(2);
  expect(attempts[1]?.body).toEqual({ password: secretPassword });
  expect(attempts[1]?.headers["x-csrf-token"]).toBe(csrfToken);
  expect(attempts[1]?.headers.origin).toBe(baseUrl);
  expect(attempts[1]?.headers["content-type"]).toBe("application/json");
  const exposed = [
    await page.content(),
    ...(await Promise.all(responseBodies)),
    await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), location.href])),
  ].join("\n");
  expect(exposed).not.toContain(secretPassword);
  expect(exposed).not.toContain("wrong-password");

  // A second sensitive action inside the window does not prompt again.
  expect(await requestSudo(page)).toMatchObject({ verified: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("verification-code sudo switches tabs by keyboard, posts the digits only, and dismisses on Escape", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `sudo-totp-${testInfo.retry}`, page);
  const errors = failOnPageErrors(page);
  await mockMethods(page, { methods: ["password", "passkey", "totp"], fallback: null, active: null, csrfToken });
  const codes: unknown[] = [];
  await page.route("**/api/account/sudo/totp", async (route) => {
    codes.push(route.request().postDataJSON());
    await route.fulfill({ json: { method: "totp", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() } });
  });

  await gotoAuthenticatedPage(page, "/security");
  const dialog = await openSudoDialog(page);
  // Escape only cancels the dialog once its first control holds focus.
  await expect(dialog.getByRole("textbox", { name: "Parola" })).toBeFocused();
  const dismissed = awaitSudoResult(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await dismissed).toMatchObject({ verified: false });

  await openSudoDialog(page);
  const outcome = awaitSudoResult(page);
  await expect(dialog.getByRole("tab")).toHaveText(["Parola", "Passkey", "Doğrulama kodu"]);
  await dialog.getByRole("tab", { name: "Parola" }).focus();
  await page.keyboard.press("End");
  const totpTab = dialog.getByRole("tab", { name: "Doğrulama kodu" });
  await expect(totpTab).toHaveAttribute("aria-selected", "true");
  await expect(totpTab).toBeFocused();
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  const code = dialog.getByRole("textbox", { name: "Doğrulama kodu" });
  await expect(code).toHaveAttribute("inputmode", "numeric");
  await expect(code).toHaveAttribute("autocomplete", "one-time-code");
  await code.fill("123 456");
  await dialog.getByRole("button", { name: "Doğrula" }).click();
  await expect(dialog).toBeHidden();
  expect(await outcome).toMatchObject({ verified: true });
  expect(codes).toEqual([{ code: "123456" }]);
  expect(errors).toEqual([]);
});

test("lockout and Microsoft fallback states render the Turkish copy and the allowlisted return form", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `sudo-states-${testInfo.retry}`, page);
  await mockMethods(page, { methods: ["password"], fallback: null, active: null, csrfToken });
  await page.route("**/api/account/sudo/password", (route) => route.fulfill({
    status: 423,
    headers: { "retry-after": "180" },
    json: { error: "locked", detail: "Çok fazla hatalı deneme yapıldı. Hesabın geçici olarak kilitlendi.", retryAfter: 180 },
  }));
  await gotoAuthenticatedPage(page, "/security");

  const dialog = await openSudoDialog(page);
  const outcome = awaitSudoResult(page);
  await dialog.getByRole("textbox", { name: "Parola" }).fill("wrong-password");
  await dialog.getByRole("button", { name: "Doğrula" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Hesabın geçici olarak kilitlendi.");
  await expect(dialog.getByRole("alert")).toContainText("Yeniden denemek için bekle: 3 dakika.");
  await expect(dialog.getByRole("button", { name: "Doğrula" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Pencereyi kapat" }).click();
  expect(await outcome).toMatchObject({ verified: false });

  await page.unroute("**/api/account/sudo/methods");
  await mockMethods(page, { methods: [], fallback: "microsoft", active: null, csrfToken });
  await openSudoDialog(page);
  const fallback = awaitSudoResult(page);
  await expect(dialog.getByRole("tab")).toHaveCount(0);
  await expect(dialog.getByText("Hesabında parola, passkey ya da doğrulama uygulaması tanımlı değil.")).toBeVisible();
  const form = dialog.locator("form");
  await expect(form).toHaveAttribute("action", "/api/account/sudo/reauthenticate");
  await expect(form).toHaveAttribute("method", "post");
  await expect(form.locator("input[name='csrfToken']")).toHaveValue(csrfToken);
  await expect(form.locator("input[name='returnTo']")).toHaveValue("/security");
  await expect(dialog.getByRole("button", { name: "Microsoft ile yeniden doğrula" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await fallback).toMatchObject({ verified: false });
});

test("the Microsoft re-authentication return is announced, stripped from the address, and proven by the server", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `sudo-return-${testInfo.retry}`, page);
  const expiresAt = new Date(Date.now() + 4 * 60_000).toISOString();
  let methodsRequests = 0;
  await page.route("**/api/account/sudo/methods", (route) => {
    methodsRequests += 1;
    return route.fulfill({ json: { methods: [], fallback: "microsoft", active: { method: "reauth", expiresAt }, csrfToken } });
  });
  await gotoAuthenticatedPage(page, "/security?sudo=confirmed");
  await expect(page.getByRole("status").filter({ hasText: "Kimliğin doğrulandı" })).toBeVisible();
  await expect(page).toHaveURL(`${baseUrl}/security`);
  // The address parameter proves nothing by itself: the dialog asks the server and closes on its active proof.
  expect(await requestSudo(page)).toMatchObject({ verified: true, expiresAt });
  expect(methodsRequests).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await gotoAuthenticatedPage(page, "/security?sudo=method_available");
  await expect(page.getByRole("status").filter({ hasText: "Microsoft ile doğrulama gerekmiyor" })).toBeVisible();
  await expect(page).toHaveURL(`${baseUrl}/security`);
});

test("passkey sudo converts the relayed options for the platform API and posts the serialized assertion", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  // Chromium refuses WebAuthn on an IP-literal origin ("This is an invalid
  // domain."), so the harness cannot drive a virtual authenticator here. The
  // platform call is stubbed with a fake that checks what the page hands to
  // `navigator.credentials.get()` and answers like an authenticator would;
  // the real ceremony against Keycloak is a production-clone release gate.
  await installAuthenticatedSession(context, `sudo-passkey-${testInfo.retry}`, page);
  const errors = failOnPageErrors(page);
  const credentialId = randomBytes(32);
  const challenge = randomBytes(32);
  const userHandle = Buffer.from("11111111-1111-4111-8111-111111111111", "utf8");
  await page.addInitScript(({ id, handle }) => {
    const toBase64Url = (buffer: ArrayBuffer) =>
      btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const fromBase64Url = (value: string) =>
      Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));
    const seen: unknown[] = [];
    (window as unknown as { __webauthnCalls: unknown[] }).__webauthnCalls = seen;
    navigator.credentials.get = async (options?: CredentialRequestOptions) => {
      const publicKey = options?.publicKey;
      if (!publicKey) throw new TypeError("publicKey options are required");
      const allowed = publicKey.allowCredentials ?? [];
      seen.push({
        challengeIsBuffer: publicKey.challenge instanceof ArrayBuffer,
        challenge: toBase64Url(publicKey.challenge as ArrayBuffer),
        rpId: publicKey.rpId,
        userVerification: publicKey.userVerification,
        timeout: publicKey.timeout,
        allowCredentials: allowed.map((credential) => ({
          type: credential.type,
          idIsBuffer: credential.id instanceof ArrayBuffer,
          id: toBase64Url(credential.id as ArrayBuffer),
          transports: credential.transports,
        })),
      });
      const rawId = fromBase64Url(id).buffer;
      const clientData = new TextEncoder().encode(JSON.stringify({
        type: "webauthn.get",
        challenge: toBase64Url(publicKey.challenge as ArrayBuffer),
        origin: location.origin,
        crossOrigin: false,
      })).buffer;
      const credential = Object.create(PublicKeyCredential.prototype) as Record<string, unknown>;
      Object.defineProperties(credential, {
        id: { value: id },
        rawId: { value: rawId },
        type: { value: "public-key" },
        authenticatorAttachment: { value: "platform" },
        response: {
          value: {
            clientDataJSON: clientData,
            authenticatorData: new Uint8Array(37).fill(7).buffer,
            signature: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer,
            userHandle: fromBase64Url(handle).buffer,
          },
        },
        getClientExtensionResults: { value: () => ({}) },
      });
      return credential as unknown as Credential;
    };
  }, { id: base64Url(credentialId), handle: base64Url(userHandle) });

  await mockMethods(page, { methods: ["passkey"], fallback: null, active: null, csrfToken });
  const optionHeaders: Array<Record<string, string>> = [];
  await page.route("**/api/account/sudo/webauthn/options", async (route: Route) => {
    optionHeaders.push(await route.request().allHeaders());
    await route.fulfill({
      json: {
        challenge: base64Url(challenge),
        rpId: "yildizskylab.com",
        allowCredentials: [{ type: "public-key", id: base64Url(credentialId), transports: ["internal", "hybrid"] }],
        userVerification: "required",
        timeout: 90_000,
      },
    });
  });
  const assertions: Array<Record<string, unknown>> = [];
  await page.route("**/api/account/sudo/webauthn/verify", async (route) => {
    assertions.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ json: { method: "passkey", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() } });
  });

  await gotoAuthenticatedPage(page, "/security");
  const dialog = await openSudoDialog(page);
  const outcome = awaitSudoResult(page);
  await expect(dialog.getByRole("tab")).toHaveText(["Passkey"]);
  await dialog.getByRole("button", { name: "Passkey ile doğrula" }).click();
  await expect(dialog).toBeHidden();
  expect(await outcome).toMatchObject({ verified: true });

  expect(optionHeaders[0]?.["x-csrf-token"]).toBe(csrfToken);
  expect(optionHeaders[0]?.origin).toBe(baseUrl);
  const calls = await page.evaluate(() => (window as unknown as { __webauthnCalls: unknown[] }).__webauthnCalls);
  expect(calls).toEqual([{
    challengeIsBuffer: true,
    challenge: base64Url(challenge),
    rpId: "yildizskylab.com",
    userVerification: "required",
    timeout: 90_000,
    allowCredentials: [{ type: "public-key", idIsBuffer: true, id: base64Url(credentialId), transports: ["internal", "hybrid"] }],
  }]);
  expect(assertions).toHaveLength(1);
  expect(Object.keys(assertions[0]!)).toEqual(["assertion"]);
  const assertion = assertions[0]!.assertion as {
    id: string;
    rawId: string;
    type: string;
    response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
  };
  expect(assertion).toEqual({
    id: base64Url(credentialId),
    rawId: base64Url(credentialId),
    type: "public-key",
    response: {
      clientDataJSON: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      authenticatorData: base64Url(Buffer.alloc(37, 7)),
      signature: base64Url(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])),
      userHandle: base64Url(userHandle),
    },
  });
  expect(Object.keys(assertion)).toEqual(["id", "rawId", "type", "response"]);
  const clientData = JSON.parse(Buffer.from(assertion.response.clientDataJSON, "base64url").toString("utf8"));
  expect(clientData).toEqual({ type: "webauthn.get", challenge: base64Url(challenge), origin: baseUrl, crossOrigin: false });
  expect(errors).toEqual([]);
});

test("mobile dialog stays inside the viewport with stacked tabs and a full-width action", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only assertion");
  await installAuthenticatedSession(context, `sudo-mobile-${testInfo.retry}`, page);
  await mockMethods(page, { methods: ["password", "passkey", "totp"], fallback: null, active: null, csrfToken });
  await gotoAuthenticatedPage(page, "/security");

  const dialog = await openSudoDialog(page);
  const outcome = awaitSudoResult(page);
  const viewport = page.viewportSize()!;
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const tabs = await dialog.getByRole("tab").all();
  const boxes = await Promise.all(tabs.map((tab) => tab.boundingBox()));
  expect(new Set(boxes.map((candidate) => Math.round(candidate!.x))).size).toBe(1);
  const submit = dialog.getByRole("button", { name: "Doğrula" });
  const submitBox = (await submit.boundingBox())!;
  const panelBox = (await dialog.getByRole("tabpanel").boundingBox())!;
  expect(Math.abs(submitBox.width - panelBox.width)).toBeLessThanOrEqual(2);
  await page.keyboard.press("Escape");
  expect(await outcome).toMatchObject({ verified: false });
});
