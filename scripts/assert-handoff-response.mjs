import assert from "node:assert/strict";

const originValue = process.env.HANDOFF_TEST_ORIGIN?.trim();
if (!originValue) throw new Error("HANDOFF_TEST_ORIGIN is required.");

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
  throw new Error("HANDOFF_TEST_ORIGIN must be a credential-free loopback origin.");
}

const handoffUrl = new URL("/handoff?code=short", origin);
let response;
let lastError;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    response = await fetch(handoffUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(1_000),
    });
    break;
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
if (!response) throw lastError ?? new Error("Optimized server did not become ready.");

assert.equal(response.status, 303);
assert.equal(response.headers.get("referrer-policy"), "no-referrer");
assert.match(response.headers.get("cache-control") ?? "", /(?:^|,)\s*no-store(?:,|$)/i);

const health = await fetch(new URL("/api/health", origin), {
  redirect: "manual",
  signal: AbortSignal.timeout(1_000),
});
assert.equal(health.status, 200);
assert.equal(health.headers.get("referrer-policy"), "same-origin");
