import assert from "node:assert/strict";

/**
 * Runs against the optimized server: the retired native handoff endpoints
 * (ADR-0048) answer 404 without a session, so an old SkyApp build or a
 * leftover handoff link never lands on a login form inside its WebView, and
 * the global header policy still applies.
 */
const originValue = process.env.RETIRED_HANDOFF_TEST_ORIGIN?.trim();
if (!originValue) throw new Error("RETIRED_HANDOFF_TEST_ORIGIN is required.");

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
  throw new Error("RETIRED_HANDOFF_TEST_ORIGIN must be a credential-free loopback origin.");
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
assert.equal(ready.headers.get("referrer-policy"), "same-origin");

for (const [method, path] of [
  ["GET", `/handoff?code=${"p".repeat(43)}`],
  ["POST", "/v1/native-handoff"],
  ["POST", "/internal/v1/native-handoff/redeem"],
]) {
  const response = await fetch(new URL(path, origin), {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
    ...(method === "POST"
      ? {
          headers: { authorization: "Bearer a.b.c", "content-type": "application/json" },
          body: "{}",
        }
      : {}),
  });
  assert.equal(response.status, 404, `${method} ${path}`);
  assert.equal(response.headers.get("location"), null, `${method} ${path}`);
  assert.match(response.headers.get("cache-control") ?? "", /(?:^|,)\s*no-store(?:,|$)/i, `${method} ${path}`);
}
