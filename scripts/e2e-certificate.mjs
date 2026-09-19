import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function ensureE2eCertificate() {
  const directory = join(process.cwd(), ".e2e-certificates");
  const keyFile = join(directory, "localhost-key.pem");
  const certificateFile = join(directory, "localhost.pem");
  mkdirSync(directory, { recursive: true });

  if (!existsSync(keyFile) || !existsSync(certificateFile)) {
    const certificate = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-days",
        "30",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
        "-keyout",
        keyFile,
        "-out",
        certificateFile,
      ],
      { stdio: "ignore" },
    );
    if (certificate.status !== 0) {
      throw new Error("Unable to generate the loopback E2E certificate with openssl.");
    }
    chmodSync(keyFile, 0o600);
  }

  const certificate = new X509Certificate(readFileSync(certificateFile));
  const publicKey = certificate.publicKey.export({ type: "spki", format: "der" });
  const spkiFingerprint = createHash("sha256").update(publicKey).digest("base64");
  return { keyFile, certificateFile, spkiFingerprint };
}
