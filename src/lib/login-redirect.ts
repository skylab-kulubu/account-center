import { normalizeReturnTo } from "@/lib/return-query";

/**
 * Set on the proxy's automatic `/login` → `/api/auth/login` hop. While it
 * lives, `/login` renders its "SKY LAB ile giriş yap" page instead of hopping
 * again, so a round trip that comes back to `/login` (a session that cannot
 * be read right after the callback, a stale cookie the layout rejects) stops
 * after one automatic attempt instead of bouncing through Keycloak's SSO
 * session. A real sign-in takes longer than this anyway; only a loop returns
 * this fast.
 */
export const LOGIN_REDIRECT_COOKIE = "__Host-sky-account-login-hop";
export const LOGIN_REDIRECT_COOKIE_SECONDS = 30;

/**
 * The `/login` states that exist to tell the person something: a failed
 * sign-in (`error`), a finished sign-out (`loggedOut=1`) or a session the
 * account gate ended (`sessionEnded=1`). These keep the page; sending them
 * straight back to Keycloak would hide the notice and, after a sign-out,
 * sign the person in again.
 */
export function loginPageHasNotice(searchParams: URLSearchParams) {
  return (
    searchParams.has("error") ||
    searchParams.get("loggedOut") === "1" ||
    searchParams.get("sessionEnded") === "1"
  );
}

/**
 * Where a request for `/login` goes without stopping on the page: the login
 * route with the same allow-listed `returnTo` the page's button would carry,
 * or `null` when the page should render (a notice to show, or an automatic
 * hop just happened).
 */
export function automaticLoginTarget(searchParams: URLSearchParams, recentlyRedirected: boolean) {
  if (recentlyRedirected || loginPageHasNotice(searchParams)) return null;
  const given = searchParams.getAll("returnTo");
  const returnTo = normalizeReturnTo(given.length === 1 ? given[0] : undefined);
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}
