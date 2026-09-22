/**
 * The browser tests' second server: the same application with
 * `ACCOUNT_ERASURE_MODE=enforce`, on its own port, its own origin and its own
 * loopback mock core. It exists because the erasure mode is read once at
 * startup, so the default server can keep proving that the production default
 * (`off`) leaves the flow inert while the deletion specs walk the enabled
 * flow end to end against a mock core.
 */
process.env.E2E_PORT = process.env.E2E_ERASURE_PORT ?? "3102";
process.env.E2E_MOCK_CORE_PORT = process.env.E2E_ERASURE_MOCK_CORE_PORT ?? "3103";
process.env.APP_URL = `https://127.0.0.1:${process.env.E2E_PORT}`;
process.env.ACCOUNT_ERASURE_MODE = "enforce";
process.env.NEXT_DIST_DIR = ".next/erasure";

await import("./start-e2e-server.mjs");
