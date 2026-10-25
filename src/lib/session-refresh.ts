let refreshInFlight: Promise<Response> | undefined;

/**
 * The browser's session refresh (`POST /api/auth/session/refresh`), one at a time: callers that ask
 * while one is on its way share it. It is the one request that rotates the session handle on its
 * own schedule; a page that mutates on mount (Bildirimlerim's seen-all) waits for it first, so the
 * two never present the same old handle at once (iletişim-servisi 07 review).
 */
export function refreshBrowserSession(csrfToken: string) {
  refreshInFlight ??= fetch("/api/auth/session/refresh", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "x-csrf-token": csrfToken },
  }).finally(() => {
    refreshInFlight = undefined;
  });
  return refreshInFlight;
}
