import { spawn } from "node:child_process";
import { join } from "node:path";
import { ensureE2eCertificate } from "./e2e-certificate.mjs";

const { keyFile, certificateFile } = ensureE2eCertificate();

const nextBinary = join(process.cwd(), "node_modules", ".bin", "next");
const child = spawn(
  nextBinary,
  [
    "dev",
    "--webpack",
    "--port",
    "3100",
    "--experimental-https",
    "--experimental-https-key",
    keyFile,
    "--experimental-https-cert",
    certificateFile,
  ],
  { env: process.env, stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
