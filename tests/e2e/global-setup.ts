import { request } from "@playwright/test";
import type { FullConfig } from "@playwright/test";
import { seedAuthenticatedSession } from "./auth-session";

/**
 * Compiles every route of the dev server before the first test opens a page.
 * `next dev` builds routes on demand and a compilation that lands while a
 * browser test is mid-flow can trigger a full reload of the open page, which
 * would break multi-step flows such as the security page's ceremonies. It
 * also holds the server (and, on a two-core CI runner, the browsers) for
 * seconds, long enough to push a page that a test is waiting for past its
 * assertion timeout. The responses themselves do not matter (most answer a
 * redirect or 401 without a session); only the compilation does.
 */
const pages = [
  "/",
  "/login",
  "/identity",
  "/email",
  "/security",
  "/sessions",
  "/permissions",
  "/club-profile",
  "/communication-preferences",
  "/notifications",
  "/delete-account",
  "/account-deletion",
  "/.well-known/assetlinks.json",
  "/.well-known/apple-app-site-association",
  "/api/health",
  "/api/ready",
  "/api/auth/login",
  "/api/auth/callback",
  "/api/auth/unavailable",
  "/api/account/identity",
  "/api/account/email",
  "/api/account/email/pending",
  "/api/account/email/nudge",
  "/api/account/email/nudge/dismiss",
  "/api/account/sessions",
  "/api/account/security",
  "/api/account/club-profile",
  "/api/account/communication-preferences",
  "/api/account/inbox",
  "/api/account/inbox/counts",
  "/api/account/skypass/wallet/google",
  "/api/account/sudo/methods",
  "/api/account/deletion/status",
];

const mutations = [
  "/api/auth/session/refresh",
  "/api/auth/session/end",
  "/api/auth/logout",
  "/api/auth/backchannel-logout",
  "/api/account/sudo/password",
  "/api/account/sudo/totp",
  "/api/account/sudo/webauthn/options",
  "/api/account/sudo/webauthn/verify",
  "/api/account/sudo/reauthenticate",
  "/api/account/identity/username",
  "/api/account/identity/ytu-link",
  "/api/account/email/change-request",
  "/api/account/email/confirm",
  "/api/account/email/primary",
  "/api/account/security/password",
  "/api/account/security/totp/setup",
  "/api/account/security/totp/confirm",
  "/api/account/security/passkeys/options",
  "/api/account/security/passkeys/register",
  "/api/account/deletion",
  "/api/account/deletion/prepare",
  "/api/account/club-profile/picture",
  "/api/account/club-profile/student-card",
  "/api/account/inbox/seen-all",
  "/api/account/inbox/read-all",
  "/api/account/inbox/items/e2e-warm-up/read",
];

/**
 * Without a session the proxy answers the account pages with a redirect to
 * `/login` before Next looks at the route, so the requests above never
 * compile them. These are requested again with a seeded session; the unknown
 * path renders the 404 page, which the tests reach through retired routes.
 */
const authenticatedPages = [
  "/",
  "/identity",
  "/email",
  "/security",
  "/sessions",
  "/permissions",
  "/club-profile",
  "/communication-preferences",
  "/notifications",
  "/delete-account",
  "/e2e-warm-up-not-found",
];

async function warmAuthenticatedPages(baseURL: string, paths: string[]) {
  const fixture = await seedAuthenticatedSession("warm-up");
  const context = await request.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { cookie: `__Host-sky-account=${fixture.handle}` },
  });
  try {
    for (const path of paths) {
      await context.get(path, { maxRedirects: 0, timeout: 120_000 }).catch(() => undefined);
    }
  } finally {
    await context.dispose();
  }
}

/** The erasure-mode server compiles the same routes again; only the deletion flow runs there. */
const erasurePages = ["/delete-account", "/account-deletion", "/api/account/deletion/status"];
const erasureMutations = [
  "/api/account/deletion",
  "/api/account/deletion/prepare",
  "/api/account/sudo/methods",
];

async function warmErasureServer(config: FullConfig) {
  const baseURL = config.projects
    .find(({ name }) => name === "account-deletion-enforce")?.use.baseURL;
  if (!baseURL) return;
  const context = await request.newContext({ baseURL, ignoreHTTPSErrors: true });
  try {
    for (const path of erasurePages) {
      await context.get(path, { maxRedirects: 0, timeout: 120_000 }).catch(() => undefined);
    }
    for (const path of erasureMutations) {
      await context.post(path, { maxRedirects: 0, timeout: 120_000 }).catch(() => undefined);
    }
  } finally {
    await context.dispose();
  }
  await warmAuthenticatedPages(baseURL, ["/delete-account"]);
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL ?? "https://127.0.0.1:3100";
  const context = await request.newContext({ baseURL, ignoreHTTPSErrors: true });
  try {
    for (const path of pages) {
      await context.get(path, { maxRedirects: 0, timeout: 120_000 }).catch(() => undefined);
    }
    for (const path of mutations) {
      await context.post(path, { maxRedirects: 0, timeout: 120_000 }).catch(() => undefined);
    }
    await context.patch("/api/account/identity/name", { maxRedirects: 0, timeout: 120_000 }).catch(() => undefined);
    await context.delete("/api/account/security/credentials/warm-up", { maxRedirects: 0, timeout: 120_000 }).catch(() => undefined);
    await context.delete("/api/account/email/personal", { maxRedirects: 0, timeout: 120_000 }).catch(() => undefined);
    await context.delete(`/api/account/sessions/${"w".repeat(43)}`, { maxRedirects: 0, timeout: 120_000 }).catch(() => undefined);
  } finally {
    await context.dispose();
  }
  await warmAuthenticatedPages(baseURL, authenticatedPages);
  await warmErasureServer(config);
}
