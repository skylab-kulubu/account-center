/**
 * Preloaded (`node --import`) into the browser tests' dev server only, never
 * into a build or the optimized server. The tests keep the production realm
 * issuer, which the account access gate pins in enforce mode, so the BFF's
 * sky-account calls would leave for the real realm. For subjects that start
 * with `e2e-realm-` they go to the loopback mock instead
 * (`E2E_MOCK_REALM_ORIGIN`, the mock core in `e2e-mock-core.mjs`), which
 * lets a spec drive a route that reads the person's sky-account identity,
 * such as the Sudo mode gate's `428`, without `page.route`. Every other
 * request, and every other spec, is left exactly as it was.
 */

const SUBJECT_PREFIX = "e2e-realm-";

const issuer = process.env.OIDC_ISSUER ? new URL(process.env.OIDC_ISSUER) : null;
const mockOrigin = process.env.E2E_MOCK_REALM_ORIGIN ? new URL(process.env.E2E_MOCK_REALM_ORIGIN).origin : null;
const skyAccountPrefix = issuer ? `${issuer.origin}${issuer.pathname.replace(/\/$/, "")}/sky-account/` : null;

function bearerSubject(headers) {
  if (!headers) return null;
  const authorization = new Headers(headers).get("authorization") ?? "";
  const payload = /^Bearer [A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(authorization)?.[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

if (skyAccountPrefix && mockOrigin) {
  const upstream = globalThis.fetch;
  globalThis.fetch = function fetchThroughMockRealm(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    if (url.startsWith(skyAccountPrefix) && bearerSubject(headers)?.startsWith(SUBJECT_PREFIX)) {
      const target = new URL(url.slice(issuer.origin.length), mockOrigin);
      return input instanceof Request ? upstream(new Request(target, input), init) : upstream(target, init);
    }
    return upstream(input, init);
  };
}
