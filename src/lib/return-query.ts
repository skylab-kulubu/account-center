import { COMMUNICATION_CHANNEL, isPreferenceCategory } from "@/lib/communication-preferences";
import { PRIMARY_EMAIL_NUDGES } from "@/lib/primary-email-nudge";

/** The values a kept parameter may take: a closed list, or a check for an open but well-formed set. */
type AllowedValues = readonly string[] | ((value: string) => boolean);

/**
 * The only query a login or a Sudo mode re-authentication may carry back to
 * an account page, per page: parameter name → the values it may take.
 * - `/email?intent=…`: the e-mail page's K4c nudge (also linked from the
 *   welcome mail), so a signed-out click still opens the nudge's flow.
 * - `/communication-preferences?kanal=email&kategori=…`: the row a News
 *   mail's "tercihlerini yönet" link, or core's unsubscribe page, asks the
 *   screen to show first (bilet 09). It names a category only, never a token.
 * Anything else is dropped, never echoed.
 */
const allowedReturnQueries: ReadonlyMap<string, ReadonlyMap<string, AllowedValues>> = new Map([
  ["/email", new Map([["intent", PRIMARY_EMAIL_NUDGES]])],
  [
    "/communication-preferences",
    new Map<string, AllowedValues>([
      ["kanal", [COMMUNICATION_CHANNEL]],
      ["kategori", isPreferenceCategory],
    ]),
  ],
]);

function allows(values: AllowedValues, value: string) {
  return typeof values === "function" ? values(value) : values.includes(value);
}

/**
 * The allow-listed part of `searchParams` for `pathname`, as `?name=value`,
 * or `""`. A parameter given more than once is dropped. Safe for the edge
 * proxy: no server-only imports.
 */
export function allowedReturnQuery(pathname: string, searchParams: URLSearchParams) {
  const allowed = allowedReturnQueries.get(pathname);
  if (!allowed) return "";
  const kept = new URLSearchParams();
  for (const [name, values] of allowed) {
    const given = searchParams.getAll(name);
    const value = given.length === 1 ? given[0] : undefined;
    if (value !== undefined && allows(values, value)) kept.set(name, value);
  }
  const query = kept.toString();
  return query ? `?${query}` : "";
}

/**
 * Account pages a login or a Sudo mode re-authentication may return to; a
 * stored transaction must hold a value `normalizeReturnTo` leaves unchanged
 * (`oidc-transactions.ts`). The only query kept is `allowedReturnQuery`'s.
 * Pure like the rest of this file, so the proxy's `/login` redirect uses the
 * same check as the login route (`oidc-flow.ts` re-exports it).
 */
const allowedReturnPaths = new Set([
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
]);

export function normalizeReturnTo(value: string | null | undefined) {
  if (!value) return "/";
  try {
    const url = new URL(value, "https://account-center.invalid");
    if (url.origin !== "https://account-center.invalid" || !allowedReturnPaths.has(url.pathname)) return "/";
    return url.pathname + allowedReturnQuery(url.pathname, url.searchParams);
  } catch {
    return "/";
  }
}
