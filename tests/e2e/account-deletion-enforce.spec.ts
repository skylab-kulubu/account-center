import { expect, test } from "@playwright/test";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import {
  contractShapedSudoToken,
  seedAuthenticatedSession,
  seedSudoProof,
  sessionState,
} from "./auth-session";

/**
 * The enabled deletion flow, on the second browser-test server
 * (`ACCOUNT_ERASURE_MODE=enforce`, `CORE_API_URL` pointing at the loopback
 * mock core). The page, the BFF routes, PostgreSQL and the core round trip
 * are real; Sudo mode's own endpoints are answered by `page.route` in the
 * shapes `src/server/auth/sudo-routes.ts` produces, while the proof the BFF
 * gate reads — a contract-shaped sky-account sudo token — is seeded on the
 * session record, so a dialog that succeeded in the browser can never stand
 * in for a proof the server does not hold. The mock core checks that token
 * the way core's introspection does and records which proof headers arrived.
 */

// One worker, in file order: on a cold dev server a route compiled for one
// test reloads the pages another test has open (see the account-ui-matrix
// project), and these tests each hold a confirmation page open while the
// others compile the deletion routes.
test.describe.configure({ mode: "default" });

const baseUrl = "https://127.0.0.1:3102";
const mockCoreUrl = `https://127.0.0.1:${process.env.E2E_ERASURE_MOCK_CORE_PORT ?? "3103"}`;
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
      active: { method: "password", expiresAt: new Date(Date.now() + 4 * 60_000).toISOString() },
      csrfToken,
    },
  }));
}

/**
 * A session whose login is an hour old — the Keycloak hop used to demand a
 * fresh one — holding a sudo token for `sudoSid` (its own session unless a
 * test wants core to refuse the proof).
 */
async function installSession(
  context: BrowserContext,
  label: string,
  options: { sudoSid?: (keycloakSid: string) => string } = {},
) {
  const fixture = await seedAuthenticatedSession(label, {
    contractToken: true,
    idTokenAuthenticatedAt: new Date(Date.now() - 60 * 60_000),
  });
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  const sudoToken = contractShapedSudoToken(
    fixture.subject,
    options.sudoSid?.(fixture.keycloakSid) ?? fixture.keycloakSid,
    expiresAt,
  );
  await seedSudoProof(fixture.sessionId, { sudoToken, expiresAt });
  await context.addCookies([{
    name: sessionCookieName,
    value: fixture.handle,
    url: baseUrl,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    expires: Math.floor(Date.now() / 1_000) + 8 * 60 * 60,
  }]);
  return { ...fixture, sudoToken };
}

async function gotoDeletePage(page: Page) {
  const refresh = page.waitForResponse((response) => response.url().endsWith("/api/auth/session/refresh"));
  await page.goto("/delete-account");
  expect((await refresh).status()).toBe(204);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Hesabı sil" })).toBeVisible();
}

/** Walks intent → Sudo mode → typed confirmation → submit, as the person does. */
async function confirmDeletion(page: Page) {
  const prepare = page.waitForResponse((response) => response.url().endsWith("/api/account/deletion/prepare"));
  await page.getByRole("button", { name: "Hesabımı silmek istiyorum" }).click();
  expect((await prepare).status()).toBe(200);

  const confirmation = page.getByLabel("Onay metni");
  await expect(confirmation).toBeVisible();
  const submit = page.getByRole("button", { name: "Hesabımı kalıcı olarak sil" });
  await expect(submit).toBeDisabled();
  await confirmation.fill("hesabımı sil");
  await expect(submit).toBeDisabled();
  await confirmation.fill("HESABIMI SİL");
  await expect(submit).toBeEnabled();
  await submit.click();
}

type CoreIntake = { sudoProof: boolean; legacyReauthToken: boolean; outcome: "accepted" | "refused" };

/** Which proof headers the mock core saw on each intake call for `subject` (never their values). */
async function coreIntakes(request: APIRequestContext, subject: string): Promise<CoreIntake[]> {
  const response = await request.get(`${mockCoreUrl}/__e2e/account-deletion-intakes/${encodeURIComponent(subject)}`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<CoreIntake[]>;
}

test("deletes with the Sudo mode proof alone, without a Keycloak step", async ({ context, page, playwright }, testInfo) => {
  const fixture = await installSession(context, `deletion-enforce-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  await mockActiveSudo(page);
  const responseBodies: Array<Promise<string>> = [];
  page.on("response", (response) => {
    if (new URL(response.url()).origin === baseUrl) responseBodies.push(response.text().catch(() => ""));
  });

  await gotoDeletePage(page);
  // The confirmation text is unreachable before the intent and Sudo mode.
  await expect(page.getByLabel("Onay metni")).toHaveCount(0);

  await confirmDeletion(page);
  await expect(page).toHaveURL(/\/account-deletion$/);
  await expect(page.getByRole("heading", { name: "Silme isteğin sırada" })).toBeVisible();
  await expect(page.getByRole("button", { name: /keycloak/i })).toHaveCount(0);

  // Core accepted the intake on the sudo token alone; the ID-token proof is gone.
  const inspector = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  try {
    expect(await coreIntakes(inspector, fixture.subject)).toEqual([
      { sudoProof: true, legacyReauthToken: false, outcome: "accepted" },
    ]);
  } finally {
    await inspector.dispose();
  }
  // Core accepted the intake, so every local session of this subject is gone.
  await expect.poll(async () => (await sessionState(fixture.sessionId))?.revoked_at !== null).toBe(true);
  const browserVisible = [
    await page.content(),
    ...(await Promise.all(responseBodies)),
    await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), location.href])),
  ].join("\n");
  expect([browserVisible, ...fixture.tokenCanaries].join("\n")).not.toContain("adr_");
  // The sudo token travels from the session record to core and nowhere else.
  expect(browserVisible).not.toContain(fixture.sudoToken);
  expect(errors).toEqual([]);
});

// A7d: `prepare` gives the browser the local receipt before the typed
// confirmation (a lost submit answer must stay recoverable). Neither a
// same-site read of the status endpoint nor a cross-site link to it may turn
// that receipt into a deletion; only the typed confirmation does.
test("the receipt from prepare never starts a deletion before the typed confirmation", async ({ context, page, playwright }, testInfo) => {
  const fixture = await installSession(context, `deletion-unconfirmed-${testInfo.retry}`);
  const errors = failOnPageErrors(page);
  await mockActiveSudo(page);
  // Load the public status page (and its endpoint) first, before the delete
  // page opens, so a cold dev server never rebuilds under the flow.
  const sameSite = await context.newPage();
  await sameSite.goto("/account-deletion");
  await expect(sameSite.getByRole("heading", { name: "Silme isteği bulunamadı" })).toBeVisible();
  await gotoDeletePage(page);

  const prepare = page.waitForResponse((response) => response.url().endsWith("/api/account/deletion/prepare"));
  await page.getByRole("button", { name: "Hesabımı silmek istiyorum" }).click();
  expect((await prepare).status()).toBe(200);
  await expect(page.getByLabel("Onay metni")).toBeVisible();

  // Same site, now holding the receipt: the public status page, and a
  // direct read of its endpoint.
  const statusRead = sameSite.waitForResponse((response) => response.url().endsWith("/api/account/deletion/status"));
  await sameSite.reload();
  expect((await statusRead).status()).toBe(404);
  await expect(sameSite.getByRole("heading", { name: "Silme isteği bulunamadı" })).toBeVisible();
  expect(await sameSite.evaluate(async () => (
    await fetch("/api/account/deletion/status", { cache: "no-store", credentials: "same-origin" })
  ).status)).toBe(404);
  await sameSite.close();

  // Cross site: a link on another site opens the status endpoint. The
  // receipt cookie is SameSite=Strict, so it does not even travel.
  const attacker = await context.newPage();
  await attacker.route("https://attacker.example/**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><a id="go" href="${baseUrl}/api/account/deletion/status">devam</a>`,
  }));
  await attacker.goto("https://attacker.example/");
  const crossSite = attacker.waitForResponse((response) => response.url() === `${baseUrl}/api/account/deletion/status`);
  await attacker.click("#go");
  const crossSiteResponse = await crossSite;
  expect(crossSiteResponse.status()).toBe(404);
  expect((await crossSiteResponse.request().allHeaders()).cookie ?? "")
    .not.toContain("__Host-sky-account-delete-receipt");
  await attacker.close();

  const inspector = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  try {
    expect(await coreIntakes(inspector, fixture.subject)).toEqual([]);

    // The probes left the pending confirmation intact: typing it still deletes.
    const confirmation = page.getByLabel("Onay metni");
    const submit = page.getByRole("button", { name: "Hesabımı kalıcı olarak sil" });
    await expect(async () => {
      await confirmation.fill("HESABIMI SİL");
      await expect(submit).toBeEnabled({ timeout: 1_000 });
    }).toPass();
    await submit.click();
    await expect(page).toHaveURL(/\/account-deletion$/);
    await expect(page.getByRole("heading", { name: "Silme isteğin sırada" })).toBeVisible();
    expect(await coreIntakes(inspector, fixture.subject)).toEqual([
      { sudoProof: true, legacyReauthToken: false, outcome: "accepted" },
    ]);
  } finally {
    await inspector.dispose();
  }
  expect(errors).toEqual([]);
});

test("asks for Sudo mode again when core refuses the proof, and changes nothing", async ({ context, page, playwright }, testInfo) => {
  // A sudo token minted for another Keycloak session: core's `sid` rule refuses it.
  const fixture = await installSession(context, `deletion-refused-${testInfo.retry}`, {
    sudoSid: (keycloakSid) => `${keycloakSid}-elsewhere`,
  });
  const errors = failOnPageErrors(page);
  await mockActiveSudo(page);

  await gotoDeletePage(page);
  await confirmDeletion(page);

  await expect(page).toHaveURL(/\/delete-account\?deletionError=sudo_rejected$/);
  await expect(page.getByRole("status")).toContainText("kimlik doğrulaman kabul edilmedi ya da süresi doldu");
  await expect(page.getByRole("status")).toContainText("Hesabında hiçbir değişiklik yapılmadı");
  // Back at the start: the next attempt goes through Sudo mode before any confirmation.
  await expect(page.getByRole("button", { name: "Hesabımı silmek istiyorum" })).toBeVisible();
  await expect(page.getByLabel("Onay metni")).toHaveCount(0);

  const inspector = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  try {
    expect(await coreIntakes(inspector, fixture.subject)).toEqual([
      { sudoProof: true, legacyReauthToken: false, outcome: "refused" },
    ]);
  } finally {
    await inspector.dispose();
  }
  const state = await sessionState(fixture.sessionId);
  // The session survives; the refused proof does not.
  expect(state?.revoked_at).toBeNull();
  expect(state?.sudo_expires_at).toBeNull();
  expect(errors).toEqual([]);
});
