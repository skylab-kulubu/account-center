import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { seedAuthenticatedSession, seedSudoProof, sessionState } from "./auth-session";

/**
 * The enabled deletion flow, on the second browser-test server
 * (`ACCOUNT_ERASURE_MODE=enforce`, `CORE_API_URL` pointing at the loopback
 * mock core). The page, the BFF routes, PostgreSQL and the core round trip
 * are real; Sudo mode's own endpoints are answered by `page.route` in the
 * shapes `src/server/auth/sudo-routes.ts` produces, while the proof the BFF
 * gate reads is seeded on the session record — so a dialog that succeeded in
 * the browser can never stand in for a proof the server does not hold.
 */

const baseUrl = "https://127.0.0.1:3102";
const sessionCookieName = "__Host-sky-account";
const csrfToken = "e2e-sudo-csrf";

function failOnPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

/** The dialog closes on its own when the server reports an active proof. */
async function mockActiveSudo(page: Page) {
  await page.route("**/api/account/sudo/methods", (route) => route.fulfill({
    json: {
      methods: ["password"],
      fallback: null,
      active: { method: "reauth", expiresAt: new Date(Date.now() + 4 * 60_000).toISOString() },
      csrfToken,
    },
  }));
}

async function installSession(
  context: BrowserContext,
  label: string,
  options: { idTokenAuthenticatedAt?: Date } = {},
) {
  const fixture = await seedAuthenticatedSession(label, { contractToken: true, ...options });
  await seedSudoProof(fixture.sessionId);
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

async function gotoDeletePage(page: Page) {
  const refresh = page.waitForResponse((response) => response.url().endsWith("/api/auth/session/refresh"));
  await page.goto("/delete-account");
  expect((await refresh).status()).toBe(204);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Hesabı sil" })).toBeVisible();
}

test("confirms the intent, takes Sudo mode, then deletes without a Keycloak hop", async ({ context, page }, testInfo) => {
  const fixture = await installSession(context, `deletion-enforce-${testInfo.retry}`, {
    idTokenAuthenticatedAt: new Date(),
  });
  const errors = failOnPageErrors(page);
  await mockActiveSudo(page);
  const responseBodies: Array<Promise<string>> = [];
  page.on("response", (response) => {
    if (new URL(response.url()).origin === baseUrl) responseBodies.push(response.text().catch(() => ""));
  });

  await gotoDeletePage(page);
  // The confirmation text is unreachable before the intent and Sudo mode.
  await expect(page.getByLabel("Onay metni")).toHaveCount(0);

  const prepare = page.waitForResponse((response) => response.url().endsWith("/api/account/deletion/prepare"));
  await page.getByRole("button", { name: "Hesabımı silmek istiyorum" }).click();
  expect((await prepare).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Keycloak ile doğrula" })).toHaveCount(0);

  const confirmation = page.getByLabel("Onay metni");
  await expect(confirmation).toBeVisible();
  const submit = page.getByRole("button", { name: "Hesabımı kalıcı olarak sil" });
  await expect(submit).toBeDisabled();
  await confirmation.fill("hesabımı sil");
  await expect(submit).toBeDisabled();
  await confirmation.fill("HESABIMI SİL");
  await expect(submit).toBeEnabled();

  await submit.click();
  await expect(page).toHaveURL(/\/account-deletion$/);
  await expect(page.getByRole("heading", { name: "Silme isteğin sırada" })).toBeVisible();

  // Core accepted the intake, so every local session of this subject is gone.
  await expect.poll(async () => (await sessionState(fixture.sessionId))?.revoked_at !== null).toBe(true);
  const exposed = [
    await page.content(),
    ...(await Promise.all(responseBodies)),
    await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), location.href])),
    ...fixture.tokenCanaries,
  ].join("\n");
  expect(exposed).not.toContain("adr_");
  expect(errors).toEqual([]);
});

test("asks for the Keycloak step when the session proves no recent authentication", async ({ context, page }, testInfo) => {
  await installSession(context, `deletion-hop-${testInfo.retry}`, {
    idTokenAuthenticatedAt: new Date(Date.now() - 60 * 60_000),
  });
  const errors = failOnPageErrors(page);
  await mockActiveSudo(page);

  await gotoDeletePage(page);
  const prepare = page.waitForResponse((response) => response.url().endsWith("/api/account/deletion/prepare"));
  await page.getByRole("button", { name: "Hesabımı silmek istiyorum" }).click();
  expect((await prepare).status()).toBe(200);

  await expect(page.getByText("Hesap silme için Keycloak üzerinden ek doğrulama gerekiyor", { exact: false }))
    .toBeVisible();
  const hop = page.getByRole("button", { name: "Keycloak ile doğrula" });
  await expect(hop).toBeVisible();
  await expect(page.getByLabel("Onay metni")).toHaveCount(0);
  expect(errors).toEqual([]);
});
