import { spawn } from "node:child_process";
import { join } from "node:path";
import { ensureE2eCertificate } from "./e2e-certificate.mjs";
import { startMockCore } from "./e2e-mock-core.mjs";

const { keyFile, certificateFile } = ensureE2eCertificate();

/** The default browser-test server; `start-e2e-erasure-server.mjs` runs a second one beside it. */
const port = process.env.E2E_PORT ?? "3100";

/**
 * Unless the environment points at a core of its own, the browser tests run
 * against the loopback mock core on the same self-signed certificate as the
 * app. `--experimental-https-ca` makes the dev server worker trust that
 * certificate for its outbound core calls (Next sets NODE_EXTRA_CA_CERTS for
 * the worker from it), and the mock's picture URLs point at the app origin
 * so the page's Content Security Policy stays exactly what production ships.
 */
const mockCore = process.env.CORE_API_URL
  ? null
  : await startMockCore({
      port: Number(process.env.E2E_MOCK_CORE_PORT ?? "3101"),
      keyFile,
      certificateFile,
      pictureBase: process.env.APP_URL ?? `https://127.0.0.1:${port}`,
    });

const env = mockCore ? { ...process.env, CORE_API_URL: mockCore.origin } : process.env;

const nextBinary = join(process.cwd(), "node_modules", ".bin", "next");
const child = spawn(
  nextBinary,
  [
    "dev",
    "--webpack",
    "--port",
    port,
    "--experimental-https",
    "--experimental-https-key",
    keyFile,
    "--experimental-https-cert",
    certificateFile,
    "--experimental-https-ca",
    certificateFile,
  ],
  { env, stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  void mockCore?.close().finally(() => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
});
