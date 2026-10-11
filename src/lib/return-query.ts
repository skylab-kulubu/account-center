import { PRIMARY_EMAIL_NUDGES } from "@/lib/primary-email-nudge";

/**
 * The only query a login or a Sudo mode re-authentication may carry back to
 * an account page, per page: parameter name → the values it may take. Today
 * that is the e-mail page's K4c nudge (`/email?intent=…`, also linked from
 * the welcome mail), so a signed-out click still opens the nudge's flow.
 * Anything else is dropped, never echoed.
 */
const allowedReturnQueries: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> = new Map([
  ["/email", new Map([["intent", PRIMARY_EMAIL_NUDGES]])],
]);

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
    if (value !== undefined && values.includes(value)) kept.set(name, value);
  }
  const query = kept.toString();
  return query ? `?${query}` : "";
}
