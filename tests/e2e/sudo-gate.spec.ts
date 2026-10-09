import { expect, test } from "@playwright/test";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { csrfTokenFor, seedAuthenticatedSession } from "./auth-session";

/**
 * The Sudo mode gate as the server answers it, with no `page.route` in
 * between: every Sudo-protected mutation refuses a session that holds no
 * proof with `428 sudo_required` and the person's methods, read from the
 * sky-account identity the mock realm serves (`e2e-realm-redirect.mjs`,
 * hence the `realm-` session label). The page is rendered first, so the
 * services shared on `globalThis` are built by another bundle than the
 * routes': under `next dev` that once turned the gate's error check into a
 * `500` (account-center A9). Deletion's two steps run on the erasure server
 * (`account-deletion-enforce.spec.ts`).
 */

const baseUrl = "https://127.0.0.1:3100";
const sessionCookieName = "__Host-sky-account";

/** What the identity fixture's credentials allow, in the dialog's tab order. */
const challenge = { error: "sudo_required", reason: "missing", methods: ["password", "passkey", "totp"], fallback: null };

const sudoRoutes: Array<{ method: "POST" | "DELETE"; path: string; data?: Record<string, unknown> }> = [
  { method: "POST", path: "/api/account/identity/username", data: { username: "ada.yeni" } },
  { method: "POST", path: "/api/account/identity/ytu-link" },
  { method: "POST", path: "/api/account/email/change-request", data: { email: "ada-yeni@example.invalid" } },
  { method: "POST", path: "/api/account/email/primary", data: { primary: "personal" } },
  { method: "DELETE", path: "/api/account/email/personal" },
  { method: "POST", path: "/api/account/security/password", data: { newPassword: "uzun-ve-yeni-bir-parola", logoutOtherSessions: false } },
  { method: "POST", path: "/api/account/security/totp/setup" },
  { method: "POST", path: "/api/account/security/totp/confirm", data: { setupHandle: "h", code: "123456", label: "Telefon" } },
  { method: "POST", path: "/api/account/security/passkeys/options" },
  { method: "POST", path: "/api/account/security/passkeys/register", data: { attestation: {}, label: "Anahtar" } },
  { method: "DELETE", path: `/api/account/security/credentials/${"r".repeat(43)}` },
  { method: "POST", path: "/api/account/skypass/wallet/google" },
];

/** Follows a rotated session handle the way the browser's cookie jar would. */
function sessionCookieOf(response: APIResponse, current: string) {
  const rotated = response.headersArray()
    .filter(({ name }) => name.toLowerCase() === "set-cookie")
    .map(({ value }) => new RegExp(`^${sessionCookieName}=([^;]+)`).exec(value)?.[1])
    .find(Boolean);
  return rotated ? `${sessionCookieName}=${rotated}` : current;
}

async function send(api: APIRequestContext, cookie: string, route: (typeof sudoRoutes)[number], csrfToken: string) {
  return api.fetch(route.path, {
    method: route.method,
    headers: { cookie, origin: baseUrl, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken },
    ...(route.data ? { data: route.data } : {}),
    maxRedirects: 0,
  });
}

test("every Sudo-protected mutation answers 428 from the server itself", async ({ playwright }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one assembled-server assertion is sufficient");
  const fixture = await seedAuthenticatedSession(`realm-sudo-gate-${testInfo.retry}`, { contractToken: true });
  const csrfToken = csrfTokenFor(fixture.sessionId);
  const api = await playwright.request.newContext({ baseURL: baseUrl, ignoreHTTPSErrors: true });
  let cookie = `${sessionCookieName}=${fixture.handle}`;

  try {
    const page = await api.get("/security", { headers: { cookie }, maxRedirects: 0 });
    expect(page.status()).toBe(200);
    cookie = sessionCookieOf(page, cookie);

    for (const route of sudoRoutes) {
      const response = await send(api, cookie, route, csrfToken);
      cookie = sessionCookieOf(response, cookie);
      expect(response.status(), `${route.method} ${route.path}`).toBe(428);
      expect(response.headers()["cache-control"], `${route.method} ${route.path}`).toBe("no-store");
      expect(await response.json(), `${route.method} ${route.path}`).toEqual(challenge);
    }
  } finally {
    await api.dispose();
  }
});
