import { createHmac, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page, Request as PlaywrightRequest } from "@playwright/test";
import { seedAuthenticatedSession } from "./auth-session";

/**
 * The security page in the browser: password, verification app and passkey
 * changes complete inside `my.` behind the real Sudo mode dialog. The BFF
 * routes under `/api/account/security/*` and `/api/account/sudo/*` are
 * answered by `page.route` in the shapes `src/server/security/routes.ts` and
 * `src/server/auth/sudo-routes.ts` produce (the handlers themselves are
 * covered by their unit tests against the sky-account fixtures); the
 * session, shell, page, dialogs, QR rendering and the WebAuthn creation
 * ceremony run for real, and no request may leave for `e.yildizskylab.com`.
 */

const baseUrl = "https://127.0.0.1:3100";
const keycloakHost = "e.yildizskylab.com";
const sessionCookieName = "__Host-sky-account";
const csrfToken = "e2e-security-csrf";
const sudoPassword = "hunter2-correct-horse-staple";
const newPassword = "correct horse battery staple";

type Row = { reference: string; label: string | null; createdAt: string | null; transports?: string[] };
type Inventory = { password: boolean; totp: Row[]; passkeys: Row[] };

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes: Buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(text: string) {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of text.replace(/=+$/, "").toUpperCase()) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error(`Not base32: ${character}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 6238 (TOTP over RFC 4226 HOTP): HMAC-SHA1 over the 30-second step, dynamic truncation, 6 digits. */
function totp(secret: Buffer, step: number, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

function currentStep(period = 30) {
  return Math.floor(Date.now() / 1_000 / period);
}

function reference(seed: string) {
  return seed.padEnd(43, "0").slice(0, 43);
}

function base64Url(value: Buffer) {
  return value.toString("base64url");
}

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

async function gotoSecurity(page: Page) {
  const refresh = page.waitForResponse((response) => response.url().endsWith("/api/auth/session/refresh"));
  await page.goto("/security");
  expect((await refresh).status()).toBe(204);
  await expect(page.getByRole("heading", { level: 1, name: "Giriş ve güvenlik" })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

/** Rejected proofs and policy errors answer 4xx on purpose; the browser logs those as resource errors. */
const expectedRejectionLog = /Failed to load resource: the server responded with a status of (?:400|401|404|409|423|428|429)/;

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

/** Sudo mode answered by the BFF mocks; the dialog itself is the real component. */
async function mockSudo(page: Page, options: { methods?: Array<"password" | "passkey" | "totp"> } = {}) {
  const proofs: unknown[] = [];
  await page.route("**/api/account/sudo/methods", (route) => route.fulfill({
    json: { methods: options.methods ?? ["password"], fallback: null, active: null, csrfToken },
  }));
  for (const method of ["password", "totp"] as const) {
    await page.route(`**/api/account/sudo/${method}`, async (route) => {
      proofs.push(route.request().postDataJSON());
      await route.fulfill({ json: { method, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() } });
    });
  }
  return proofs;
}

function securityPayload(inventory: Inventory) {
  const methods = [
    ...(inventory.password ? ["password"] : []),
    ...(inventory.passkeys.length > 0 ? ["passkey"] : []),
    ...(inventory.totp.length > 0 ? ["totp"] : []),
  ];
  return {
    ...inventory,
    sudo: { methods, fallback: methods.length === 0 ? "microsoft" : null, active: null },
    csrfToken,
  };
}

async function mockInventory(page: Page, inventory: Inventory) {
  await page.route("**/api/account/security", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: securityPayload(inventory) });
  });
}

async function completeSudoDialog(page: Page, method: "password" | "totp" = "password") {
  const dialog = page.getByRole("dialog", { name: "Kimliğini doğrula" });
  await expect(dialog).toBeVisible();
  if (method === "password") await dialog.getByRole("textbox", { name: "Parola" }).fill(sudoPassword);
  else await dialog.getByRole("textbox", { name: "Doğrulama kodu" }).fill("123456");
  await dialog.getByRole("button", { name: "Doğrula" }).click();
  await expect(dialog).toBeHidden();
}

test("password change stays on my.: sudo dialog, 428 retry, policy rejection, then success", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `security-password-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  const network = recordRequests(page);
  const inventory: Inventory = { password: true, totp: [], passkeys: [] };
  await mockInventory(page, inventory);
  const proofs = await mockSudo(page);
  const attempts: Array<{ headers: Record<string, string>; body: unknown }> = [];
  await page.route("**/api/account/security/password", async (route) => {
    attempts.push({ headers: await route.request().allHeaders(), body: route.request().postDataJSON() });
    if (attempts.length === 1) {
      await route.fulfill({ status: 428, json: { error: "sudo_required", reason: "missing", methods: ["password"], fallback: null } });
      return;
    }
    if (attempts.length === 2) {
      await route.fulfill({
        status: 400,
        json: {
          error: "password_policy",
          detail: "Geçersiz Şifre: En az 12 karakter uzunluğunda olmalı.",
          policy: "invalidPasswordMinLengthMessage",
          params: [12],
        },
      });
      return;
    }
    await route.fulfill({ status: 204 });
  });
  const responseBodies: Array<Promise<string>> = [];
  page.on("response", (response) => {
    if (new URL(response.url()).origin === baseUrl) responseBodies.push(response.text().catch(() => ""));
  });

  await gotoSecurity(page);
  await expect(page.getByText("Tanımlı", { exact: true })).toBeVisible();
  // The dialog only opens when a change is requested; the page itself never asks.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The sudo proof is remembered only after the dialog succeeds; the first mutation is deliberately answered 428.
  await page.getByRole("button", { name: "Parolayı değiştir" }).click();
  await completeSudoDialog(page);
  const form = page.getByRole("form", { name: "Parolayı değiştir" });
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Yeni parola", { exact: true })).toBeFocused();
  await expect(form.getByRole("checkbox", { name: /Diğer cihazlardaki oturumları kapat/ })).toBeChecked();
  await form.getByLabel("Yeni parola", { exact: true }).fill("short-one");
  await form.getByLabel("Yeni parola (tekrar)").fill("short-on");
  await expect(form.getByText("Parolalar birbiriyle aynı değil.")).toBeVisible();
  await expect(form.getByRole("button", { name: "Parolayı kaydet" })).toBeDisabled();
  await form.getByLabel("Yeni parola (tekrar)").fill("short-one");
  await form.getByRole("button", { name: "Parolayı kaydet" }).click();
  // 428 → the dialog opens again (the local memory is dropped) → the same body is retried → policy rejection.
  await completeSudoDialog(page);
  await expect(form.getByRole("alert")).toContainText("Geçersiz Şifre: En az 12 karakter uzunluğunda olmalı.");
  await expect(form.getByText("En az 8 karakter")).toBeVisible();
  await expect(form.getByLabel("Yeni parola", { exact: true })).toHaveValue("short-one");
  await expect(form.getByLabel("Yeni parola (tekrar)")).toHaveValue("");

  await form.getByLabel("Yeni parola", { exact: true }).fill(newPassword);
  await form.getByLabel("Yeni parola (tekrar)").fill(newPassword);
  await form.getByRole("checkbox", { name: /Diğer cihazlardaki oturumları kapat/ }).uncheck();
  await form.getByRole("button", { name: "Parolayı kaydet" }).click();
  const notice = page.getByRole("status").filter({ hasText: "İşlem tamamlandı" });
  await expect(notice).toContainText("Parolan değiştirildi.");
  await expect(notice).not.toContainText("Diğer cihazlardaki oturumlar kapatıldı.");
  await expect(notice).toBeFocused();
  await expect(form).toBeHidden();

  expect(proofs).toEqual([{ password: sudoPassword }, { password: sudoPassword }]);
  expect(attempts).toHaveLength(3);
  expect(attempts[0]?.body).toEqual({ newPassword: "short-one", logoutOtherSessions: true });
  expect(attempts[1]?.body).toEqual({ newPassword: "short-one", logoutOtherSessions: true });
  expect(attempts[2]?.body).toEqual({ newPassword, logoutOtherSessions: false });
  for (const attempt of attempts) {
    expect(attempt.headers["x-csrf-token"]).toBe(csrfToken);
    expect(attempt.headers.origin).toBe(baseUrl);
    expect(attempt.headers["content-type"]).toBe("application/json");
  }
  const exposed = [
    await page.content(),
    ...(await Promise.all(responseBodies)),
    await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), location.href])),
  ].join("\n");
  expect(exposed).not.toContain(newPassword);
  expect(exposed).not.toContain(sudoPassword);
  expect(exposed).not.toContain("short-one");
  expect(page.url()).toBe(`${baseUrl}/security`);
  expect(network.hosts().has(keycloakHost)).toBe(false);
  expect(network.urls().some((url) => url.includes("kc_action"))).toBe(false);
  expect(errors).toEqual([]);
});

test("verification app setup draws the QR on the page and accepts an RFC 6238 code computed from the shown secret", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `security-totp-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  const network = recordRequests(page);
  const inventory: Inventory = { password: true, totp: [], passkeys: [] };
  await mockInventory(page, inventory);
  await mockSudo(page);
  const secretBytes = randomBytes(20);
  const secret = base32Encode(secretBytes);
  const setupHandle = base64Url(randomBytes(32));
  const otpauthUri = `otpauth://totp/SKY%20LAB:e2e?secret=${secret}&digits=6&algorithm=SHA1&issuer=SKY%20LAB&period=30`;
  let setups = 0;
  await page.route("**/api/account/security/totp/setup", async (route) => {
    setups += 1;
    await route.fulfill({
      json: {
        setupHandle,
        secret,
        otpauthUri,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        policy: { type: "totp", algorithm: "SHA1", digits: 6, period: 30 },
      },
    });
  });
  const confirmations: Array<{ setupHandle: string; code: string; label: string }> = [];
  await page.route("**/api/account/security/totp/confirm", async (route) => {
    const body = route.request().postDataJSON() as { setupHandle: string; code: string; label: string };
    confirmations.push(body);
    // The mock verifies like the SPI would: the code must match the secret it issued for this handle.
    const step = currentStep();
    const valid = body.setupHandle === setupHandle &&
      [step - 1, step, step + 1].some((candidate) => totp(secretBytes, candidate) === body.code);
    if (!valid) {
      await route.fulfill({ status: 400, json: { error: "invalid_code", detail: "Kod yanlış. Uygulamandaki güncel kodu gir." } });
      return;
    }
    inventory.totp.push({ reference: reference("totp"), label: body.label, createdAt: new Date().toISOString() });
    await route.fulfill({
      status: 201,
      json: { credential: { reference: reference("totp"), label: body.label, createdAt: new Date().toISOString() } },
    });
  });

  await gotoSecurity(page);
  await expect(page.getByText("Tanımlı bir doğrulama uygulaması yok.")).toBeVisible();
  await page.getByRole("button", { name: "Doğrulama uygulaması ekle" }).click();
  await completeSudoDialog(page);

  const qr = page.getByRole("img", { name: "Doğrulama uygulaması kurulumu için QR kodu" });
  await expect(qr).toBeVisible();
  expect(await qr.evaluate((element) => element.tagName.toLowerCase())).toBe("svg");
  const modules = await qr.locator("path").getAttribute("d");
  expect((modules ?? "").split("z").filter(Boolean).length).toBeGreaterThan(200);
  const shownSecret = (await page.getByLabel("Elle giriş anahtarı").textContent())!.replace(/\s+/g, "");
  expect(shownSecret).toBe(secret);
  expect(base32Decode(shownSecret)).toEqual(secretBytes);
  expect(await page.content()).not.toContain(otpauthUri);

  const wizard = page.getByRole("region", { name: "Doğrulama uygulaması ekle" });
  await page.getByLabel("Uygulama adı").fill("Telefon");
  const code = page.getByLabel("Uygulamadaki kod");
  await code.fill("000000");
  await page.getByRole("button", { name: "Doğrula ve ekle" }).click();
  await expect(wizard.getByRole("alert")).toContainText("Kod yanlış. Uygulamandaki güncel kodu gir.");
  await expect(qr).toBeVisible();

  await code.fill(totp(base32Decode(shownSecret), currentStep()));
  await page.getByRole("button", { name: "Doğrula ve ekle" }).click();
  await expect(page.getByRole("status").filter({ hasText: "İşlem tamamlandı" })).toContainText("Doğrulama uygulaması eklendi.");
  await expect(page.getByText("Telefon", { exact: true })).toBeVisible();
  await expect(qr).toBeHidden();

  expect(setups).toBe(1);
  expect(confirmations).toHaveLength(2);
  expect(confirmations.every((body) => body.setupHandle === setupHandle && body.label === "Telefon")).toBe(true);
  expect(confirmations[1]?.code).toMatch(/^\d{6}$/);
  expect(page.url()).toBe(`${baseUrl}/security`);
  expect(network.hosts().has(keycloakHost)).toBe(false);
  expect(errors).toEqual([]);
});

test("passkey registration converts the relayed options for navigator.credentials.create and posts the attestation", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  // Chromium refuses WebAuthn on an IP-literal origin, so the platform call is
  // stubbed with a fake that records what the page hands to `create()` and
  // answers like an authenticator would; the real ceremony against Keycloak
  // is a production-clone release gate.
  await installAuthenticatedSession(context, `security-passkey-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  const network = recordRequests(page);
  const credentialId = randomBytes(32);
  const challenge = randomBytes(32);
  const userId = Buffer.from("11111111-1111-4111-8111-111111111111", "utf8");
  const existingId = randomBytes(16);
  await page.addInitScript(({ id }) => {
    const toBase64Url = (buffer: ArrayBuffer) =>
      btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const fromBase64Url = (value: string) =>
      Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));
    const seen: unknown[] = [];
    (window as unknown as { __webauthnCreateCalls: unknown[] }).__webauthnCreateCalls = seen;
    navigator.credentials.create = async (options?: CredentialCreationOptions) => {
      const publicKey = options?.publicKey;
      if (!publicKey) throw new TypeError("publicKey options are required");
      seen.push({
        challengeIsBuffer: publicKey.challenge instanceof ArrayBuffer,
        challenge: toBase64Url(publicKey.challenge as ArrayBuffer),
        rp: publicKey.rp,
        userIdIsBuffer: publicKey.user.id instanceof ArrayBuffer,
        userId: toBase64Url(publicKey.user.id as ArrayBuffer),
        userName: publicKey.user.name,
        displayName: publicKey.user.displayName,
        pubKeyCredParams: publicKey.pubKeyCredParams,
        excludeCredentials: (publicKey.excludeCredentials ?? []).map((credential) => ({
          type: credential.type,
          idIsBuffer: credential.id instanceof ArrayBuffer,
          id: toBase64Url(credential.id as ArrayBuffer),
          transports: credential.transports,
        })),
        authenticatorSelection: publicKey.authenticatorSelection,
        attestation: publicKey.attestation,
        timeout: publicKey.timeout,
        extensions: publicKey.extensions,
      });
      const clientData = new TextEncoder().encode(JSON.stringify({
        type: "webauthn.create",
        challenge: toBase64Url(publicKey.challenge as ArrayBuffer),
        origin: location.origin,
        crossOrigin: false,
      })).buffer;
      const credential = Object.create(PublicKeyCredential.prototype) as Record<string, unknown>;
      Object.defineProperties(credential, {
        id: { value: id },
        rawId: { value: fromBase64Url(id).buffer },
        type: { value: "public-key" },
        authenticatorAttachment: { value: "platform" },
        response: {
          value: {
            clientDataJSON: clientData,
            attestationObject: new Uint8Array(64).fill(9).buffer,
            getTransports: () => ["internal"],
          },
        },
        getClientExtensionResults: { value: () => ({ credProps: { rk: true } }) },
      });
      return credential as unknown as Credential;
    };
  }, { id: base64Url(credentialId) });

  const inventory: Inventory = {
    password: false,
    totp: [],
    passkeys: [{ reference: reference("mac"), label: "MacBook", createdAt: "2026-09-01T08:00:00.000Z", transports: ["internal"] }],
  };
  await mockInventory(page, inventory);
  // Sudo with the passkey tab would need an assertion ceremony too; the password tab drives the same gate.
  await mockSudo(page);
  const optionRequests: Array<Record<string, string>> = [];
  await page.route("**/api/account/security/passkeys/options", async (route) => {
    optionRequests.push(await route.request().allHeaders());
    await route.fulfill({
      json: {
        rp: { id: "yildizskylab.com", name: "SKY LAB" },
        user: { id: base64Url(userId), name: "e2e", displayName: "E2E Person" },
        challenge: base64Url(challenge),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        timeout: 90_000,
        excludeCredentials: [{ type: "public-key", id: base64Url(existingId), transports: ["internal"] }],
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        attestation: "none",
        extensions: { credProps: true },
      },
    });
  });
  const registrations: Array<Record<string, unknown>> = [];
  await page.route("**/api/account/security/passkeys/register", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    registrations.push(body);
    inventory.passkeys.push({ reference: reference("iphone"), label: String(body.label), createdAt: new Date().toISOString(), transports: ["internal"] });
    await route.fulfill({
      status: 201,
      json: { credential: { reference: reference("iphone"), label: body.label, createdAt: new Date().toISOString(), transports: ["internal"] } },
    });
  });

  await gotoSecurity(page);
  await expect(page.getByText("MacBook", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Passkey ekle" }).click();
  const dialog = page.getByRole("dialog", { name: "Passkey ekle" });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((element) => element.matches(":modal"))).toBe(true);
  await dialog.getByLabel("Passkey adı").fill("MacBook");
  await dialog.getByRole("button", { name: "Passkey oluştur" }).click();
  await expect(dialog.getByText("Aynı adda bir passkey zaten var. Başka bir ad seç.")).toBeVisible();
  await dialog.getByLabel("Passkey adı").fill("iPhone");
  await dialog.getByRole("button", { name: "Passkey oluştur" }).click();
  await completeSudoDialog(page);
  await expect(page.getByRole("status").filter({ hasText: "İşlem tamamlandı" })).toContainText("Passkey eklendi.");
  await expect(dialog).toBeHidden();
  await expect(page.getByText("iPhone", { exact: true })).toBeVisible();

  expect(optionRequests[0]?.["x-csrf-token"]).toBe(csrfToken);
  expect(optionRequests[0]?.origin).toBe(baseUrl);
  const calls = await page.evaluate(() => (window as unknown as { __webauthnCreateCalls: unknown[] }).__webauthnCreateCalls);
  expect(calls).toEqual([{
    challengeIsBuffer: true,
    challenge: base64Url(challenge),
    rp: { id: "yildizskylab.com", name: "SKY LAB" },
    userIdIsBuffer: true,
    userId: base64Url(userId),
    userName: "e2e",
    displayName: "E2E Person",
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    excludeCredentials: [{ type: "public-key", idIsBuffer: true, id: base64Url(existingId), transports: ["internal"] }],
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    attestation: "none",
    timeout: 90_000,
    extensions: { credProps: true },
  }]);
  expect(registrations).toHaveLength(1);
  expect(Object.keys(registrations[0]!).sort()).toEqual(["attestation", "label"]);
  const attestation = registrations[0]!.attestation as {
    id: string;
    rawId: string;
    type: string;
    response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
    authenticatorAttachment?: string;
  };
  expect(attestation).toEqual({
    id: base64Url(credentialId),
    rawId: base64Url(credentialId),
    type: "public-key",
    response: {
      clientDataJSON: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      attestationObject: base64Url(Buffer.alloc(64, 9)),
      transports: ["internal"],
    },
    authenticatorAttachment: "platform",
  });
  expect(Object.keys(attestation)).toEqual(["id", "rawId", "type", "response", "authenticatorAttachment"]);
  expect(JSON.stringify(registrations[0])).not.toContain("credProps");
  const clientData = JSON.parse(Buffer.from(attestation.response.clientDataJSON, "base64url").toString("utf8"));
  expect(clientData).toEqual({ type: "webauthn.create", challenge: base64Url(challenge), origin: baseUrl, crossOrigin: false });
  expect(page.url()).toBe(`${baseUrl}/security`);
  expect(network.hosts().has(keycloakHost)).toBe(false);
  expect(errors).toEqual([]);
});

test("removing credentials confirms first, warns about the last passkey without a password, and deletes by opaque reference", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  await installAuthenticatedSession(context, `security-remove-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  const network = recordRequests(page);
  const inventory: Inventory = {
    password: false,
    totp: [{ reference: reference("totp"), label: "Telefon", createdAt: "2026-09-21T13:10:41.130Z" }],
    passkeys: [{ reference: reference("mac"), label: "MacBook", createdAt: "2026-09-01T08:00:00.000Z", transports: ["internal", "hybrid"] }],
  };
  await mockInventory(page, inventory);
  await mockSudo(page, { methods: ["totp"] });
  const deletions: Array<{ path: string; headers: Record<string, string> }> = [];
  let challenged = 0;
  await page.route(/\/api\/account\/security\/credentials\/[^/?]+$/, async (route) => {
    const request = route.request();
    if (request.method() !== "DELETE") {
      await route.abort();
      return;
    }
    const path = new URL(request.url()).pathname;
    // Removal has no pre-flight: the first attempt meets the server's 428 and the real dialog opens.
    if (challenged === 0) {
      challenged += 1;
      await route.fulfill({ status: 428, json: { error: "sudo_required", reason: "missing", methods: ["totp"], fallback: null } });
      return;
    }
    deletions.push({ path, headers: await request.allHeaders() });
    const target = path.split("/").pop()!;
    inventory.totp = inventory.totp.filter((row) => row.reference !== target);
    inventory.passkeys = inventory.passkeys.filter((row) => row.reference !== target);
    await route.fulfill({ status: 204 });
  });

  await gotoSecurity(page);
  expect(await page.locator("body").textContent()).not.toContain(reference("mac"));
  await expect(page.getByText(/Eklendi: 1 Eylül 2026 · Bu cihaz · Telefon \/ QR/)).toBeVisible();

  const removeTotp = page.getByRole("button", { name: "Telefon — Kaldır" });
  await removeTotp.click();
  const totpDialog = page.getByRole("dialog", { name: "Doğrulama uygulaması kaldırılsın mı?" });
  await expect(totpDialog).toBeVisible();
  await expect(totpDialog.getByRole("note")).toHaveCount(0);
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Tab");
    expect(await totpDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(totpDialog).toBeHidden();
  await expect(removeTotp).toBeFocused();

  await removeTotp.click();
  await totpDialog.getByRole("button", { name: "Kaldır" }).click();
  // The first mutation needs a proof: the real dialog opens with the verification-code tab.
  await completeSudoDialog(page, "totp");
  await expect(page.getByRole("status").filter({ hasText: "İşlem tamamlandı" })).toContainText("Doğrulama uygulaması kaldırıldı.");
  await expect(page.getByText("Tanımlı bir doğrulama uygulaması yok.")).toBeVisible();

  await page.getByRole("button", { name: "MacBook — Kaldır" }).click();
  const passkeyDialog = page.getByRole("dialog", { name: "Passkey kaldırılsın mı?" });
  await expect(passkeyDialog.getByRole("note")).toContainText("Bu, hesabındaki son passkey.");
  await expect(passkeyDialog.getByRole("button", { name: "Kaldır" })).toBeEnabled();
  await passkeyDialog.getByRole("button", { name: "Kaldır" }).click();
  await expect(page.getByRole("dialog", { name: "Kimliğini doğrula" })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "İşlem tamamlandı" })).toContainText("Passkey kaldırıldı.");
  await expect(page.getByText("Kayıtlı bir passkey yok.")).toBeVisible();

  expect(challenged).toBe(1);
  expect(deletions.map(({ path }) => path)).toEqual([
    `/api/account/security/credentials/${reference("totp")}`,
    `/api/account/security/credentials/${reference("mac")}`,
  ]);
  for (const deletion of deletions) {
    expect(deletion.headers["x-csrf-token"]).toBe(csrfToken);
    expect(deletion.headers.origin).toBe(baseUrl);
  }
  expect(page.url()).toBe(`${baseUrl}/security`);
  expect(network.hosts().has(keycloakHost)).toBe(false);
  expect(errors).toEqual([]);
});

test("mobile security page stacks the setup steps and keeps every panel inside the viewport", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only assertion");
  await installAuthenticatedSession(context, `security-mobile-${testInfo.retry}`);
  const inventory: Inventory = {
    password: true,
    totp: [{ reference: reference("totp"), label: "Telefon", createdAt: "2026-09-21T13:10:41.130Z" }],
    passkeys: [],
  };
  await mockInventory(page, inventory);
  await mockSudo(page);
  await page.route("**/api/account/security/totp/setup", (route) => route.fulfill({
    json: {
      setupHandle: base64Url(randomBytes(32)),
      secret: base32Encode(randomBytes(20)),
      otpauthUri: "otpauth://totp/SKY%20LAB:e2e?secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&digits=6&algorithm=SHA1&issuer=SKY%20LAB&period=30",
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      policy: { type: "totp", algorithm: "SHA1", digits: 6, period: 30 },
    },
  }));

  await gotoSecurity(page);
  await page.getByRole("button", { name: "Doğrulama uygulaması ekle" }).click();
  await completeSudoDialog(page);
  const qr = page.getByRole("img", { name: "Doğrulama uygulaması kurulumu için QR kodu" });
  await expect(qr).toBeVisible();
  const viewport = page.viewportSize()!;
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const box = (await qr.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  const submit = page.getByRole("button", { name: "Doğrula ve ekle" });
  await submit.scrollIntoViewIfNeeded();
  const submitBox = (await submit.boundingBox())!;
  expect(submitBox.x + submitBox.width).toBeLessThanOrEqual(viewport.width + 1);
});
