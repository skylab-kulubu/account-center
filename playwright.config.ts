import { defineConfig, devices } from "@playwright/test";
import { ensureE2eCertificate } from "./scripts/e2e-certificate.mjs";

const { spkiFingerprint } = ensureE2eCertificate();

const appUrl = "https://127.0.0.1:3100";
/** The second server, started with `ACCOUNT_ERASURE_MODE=enforce`; see `scripts/start-e2e-erasure-server.mjs`. */
const erasureAppUrl = "https://127.0.0.1:3102";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: appUrl,
    launchOptions: {
      args: [
        "--allow-insecure-localhost",
        `--ignore-certificate-errors-spki-list=${spkiFingerprint}`,
      ],
    },
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "desktop",
      testIgnore: /(?:account-ui|club-profile|account-deletion-enforce)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      testIgnore: /(?:account-ui|club-profile|account-deletion-enforce)\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "reduced-motion",
      testIgnore: /(?:account-ui|club-profile|account-deletion-enforce)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], reducedMotion: "reduce" },
    },
    {
      // The account erasure flow only exists on the second server, which runs
      // with `ACCOUNT_ERASURE_MODE=enforce`; every other project keeps the
      // production default and sees the inert page.
      name: "account-deletion-enforce",
      testMatch: /account-deletion-enforce\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: erasureAppUrl },
    },
    {
      // Runs once every route has been compiled by the projects above, so the
      // stateful club-profile flow is not interrupted by a dev-server reload.
      name: "account-ui-matrix",
      dependencies: ["desktop", "mobile", "reduced-motion"],
      testMatch: /(?:account-ui|club-profile)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "pnpm test:e2e:server",
      url: `${appUrl}/api/health`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "pnpm test:e2e:server:erasure",
      url: `${erasureAppUrl}/api/health`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
