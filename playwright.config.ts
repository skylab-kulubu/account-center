import { defineConfig, devices } from "@playwright/test";
import { ensureE2eCertificate } from "./scripts/e2e-certificate.mjs";

const { spkiFingerprint } = ensureE2eCertificate();

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "https://127.0.0.1:3100",
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
      testIgnore: /(?:account-ui|club-profile)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      testIgnore: /(?:account-ui|club-profile)\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "reduced-motion",
      testIgnore: /(?:account-ui|club-profile)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], reducedMotion: "reduce" },
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
  webServer: {
    command: "pnpm test:e2e:server",
    url: "https://127.0.0.1:3100/api/health",
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
