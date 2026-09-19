import { describe, expect, it } from "vitest";
import { AesGcmSecretCipher } from "@/server/auth/crypto";

describe("AesGcmSecretCipher", () => {
  it("encrypts token material with record-bound authenticated data", () => {
    const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 7));
    const encrypted = cipher.encrypt({ accessToken: "secret-access-token" }, "session:one");

    expect(encrypted).not.toContain("secret-access-token");
    expect(cipher.decrypt(encrypted, "session:one")).toEqual({ accessToken: "secret-access-token" });
    expect(() => cipher.decrypt(encrypted, "session:two")).toThrow();
  });
});
