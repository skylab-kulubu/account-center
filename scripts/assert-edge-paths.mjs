import assert from "node:assert/strict";

/**
 * Runs against the optimized server, started with the Android
 * app-association pair set and the Apple pair unset, so both answers of the
 * `/.well-known` routes are exercised with the headers production ships:
 *
 * - `/internal/*` answers a bare, uncached 404 without a session, whether or
 *   not the request carries the forwarding headers Traefik adds;
 * - `/.well-known/assetlinks.json` is briefly cacheable JSON, never a
 *   redirect to the login page;
 * - an unconfigured `/.well-known/apple-app-site-association` is a 404, not
 *   a redirect.
 */
const originValue = process.env.EDGE_PATHS_TEST_ORIGIN?.trim();
if (!originValue) throw new Error("EDGE_PATHS_TEST_ORIGIN is required.");

const origin = new URL(originValue);
if (
  !["127.0.0.1", "localhost", "::1"].includes(origin.hostname) ||
  !["http:", "https:"].includes(origin.protocol) ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
) {
  throw new Error("EDGE_PATHS_TEST_ORIGIN must be a credential-free loopback origin.");
}

const health = new URL("/api/health", origin);
let ready;
let lastError;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    ready = await fetch(health, { redirect: "manual", signal: AbortSignal.timeout(1_000) });
    break;
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
if (!ready) throw lastError ?? new Error("Optimized server did not become ready.");
assert.equal(ready.status, 200);

function request(method, path, headers = {}) {
  return fetch(new URL(path, origin), {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
    headers,
  });
}

const edgeHeaders = {
  "x-forwarded-for": "203.0.113.7",
  "x-forwarded-host": "my.yildizskylab.com",
  "x-forwarded-proto": "https",
  "x-real-ip": "203.0.113.7",
  forwarded: "for=203.0.113.7;proto=https",
};

for (const [method, path, headers] of [
  ["GET", "/internal/v1/x", {}],
  ["GET", "/internal/v1/x", edgeHeaders],
  ["GET", "/internal/v1/x", { ...edgeHeaders, purpose: "prefetch" }],
  ["POST", "/internal/v1/native-handoff/redeem", edgeHeaders],
  ["GET", "/internal", { cookie: "__Host-sky-account=opaque-session" }],
]) {
  const label = `${method} ${path} ${Object.keys(headers).join(",")}`;
  const response = await request(method, path, headers);
  assert.equal(response.status, 404, label);
  assert.equal(response.headers.get("location"), null, label);
  assert.match(response.headers.get("cache-control") ?? "", /(?:^|,)\s*no-store(?:,|$)/i, label);
  assert.equal(await response.text(), "", label);
}

const assetLinks = await request("GET", "/.well-known/assetlinks.json");
assert.equal(assetLinks.status, 200, "assetlinks.json");
assert.equal(assetLinks.headers.get("location"), null, "assetlinks.json");
assert.match(assetLinks.headers.get("content-type") ?? "", /^application\/json(?:;|$)/, "assetlinks.json");
assert.equal(assetLinks.headers.get("cache-control"), "public, max-age=300", "assetlinks.json");
const statements = await assetLinks.json();
assert.deepEqual(statements[0]?.relation, ["delegate_permission/common.get_login_creds"]);
assert.equal(statements[0]?.target?.namespace, "android_app");

for (const path of ["/.well-known/apple-app-site-association", "/.well-known/unknown"]) {
  const response = await request("GET", path);
  assert.equal(response.status, 404, path);
  assert.equal(response.headers.get("location"), null, path);
}
