import { expect, test } from "@playwright/test";
import { seedAuthenticatedSession } from "./auth-session";

/**
 * Account deletion under the production default, `ACCOUNT_ERASURE_MODE=off`:
 * the page offers no control at all and every deletion endpoint — the new
 * `prepare` step included — answers `503` before it looks at the session, a
 * Sudo mode proof or any cookie. The enabled flow runs on the second
 * browser-test server (`account-deletion-enforce.spec.ts`).
 */

const baseUrl = "https://127.0.0.1:3100";
const sessionCookieName = "__Host-sky-account";

test("keeps every deletion endpoint inert while account erasure is off", async ({ playwright }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one assembled-server assertion is sufficient");
  const fixture = await seedAuthenticatedSession(`deletion-inert-${testInfo.retry}`);
  const api = await playwright.request.newContext({
    baseURL: baseUrl,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { cookie: `${sessionCookieName}=${fixture.handle}` },
  });

  try {
    const page = await api.get("/delete-account");
    expect(page.status()).toBe(200);
    const html = await page.text();
    expect(html).toContain("Silme akışı henüz etkin değil");
    expect(html).not.toContain("Hesabımı silmek istiyorum");
    expect(html).not.toContain("Onay metni");

    for (const path of [
      "/api/account/deletion/prepare",
      "/api/account/deletion",
    ]) {
      const response = await api.post(path, {
        headers: { origin: baseUrl, "sec-fetch-site": "same-origin" },
        form: { csrfToken: "unused" },
        maxRedirects: 0,
      });
      expect(response.status(), path).toBe(503);
      expect(await response.json(), path).toEqual({ error: "unavailable" });
    }

    // The Keycloak re-authentication hop is retired: Sudo mode is the only proof.
    const retiredHop = await api.post("/api/account/deletion/reauthenticate", {
      headers: { origin: baseUrl, "sec-fetch-site": "same-origin" },
      form: { csrfToken: "unused" },
      maxRedirects: 0,
    });
    expect(retiredHop.status()).toBe(404);
  } finally {
    await api.dispose();
  }
});
