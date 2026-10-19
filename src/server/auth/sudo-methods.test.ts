// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import identityFixture from "../../../tests/fixtures/sky-account-v1-identity.json";
import { resolveSudoMethods, sudoMethodAvailability } from "@/server/auth/sudo-methods";
import type { SkyAccountIdentity } from "@/server/sky-account/types";

const credentials = identityFixture.credentials as SkyAccountIdentity["credentials"];

describe("sudo method availability", () => {
  it("lists the methods in tab order and never a Microsoft fallback when one exists", () => {
    expect(sudoMethodAvailability({ ...identityFixture, sudoEmailCodeAvailable: false, credentials })).toEqual({
      methods: ["password", "passkey", "totp"],
      fallback: null,
    });
    expect(sudoMethodAvailability({ ...identityFixture, sudoEmailCodeAvailable: false, credentials: { ...credentials, password: false } })).toEqual({
      methods: ["passkey", "totp"],
      fallback: null,
    });
    expect(sudoMethodAvailability({ ...identityFixture, sudoEmailCodeAvailable: false, credentials: { ...credentials, totp: [] } })).toEqual({
      methods: ["password", "passkey"],
      fallback: null,
    });
  });

  it("offers the Microsoft re-authentication only when no in-product method exists", () => {
    expect(sudoMethodAvailability({ credentials: { password: false, totp: [], passkeys: [] }, verifiedYtu: true, sudoEmailCodeAvailable: false })).toEqual({
      methods: [],
      fallback: "microsoft",
    });
  });

  it("resolves the availability from the person's identity with the session bearer", async () => {
    const session = { id: "11111111-1111-4111-8111-111111111111", subject: identityFixture.sub };
    const accessToken = vi.fn(async () => "server-held-user-token");
    const identity = vi.fn(async () => identityFixture as SkyAccountIdentity);
    await expect(resolveSudoMethods(
      { account: { accessToken }, skyAccount: { identity } },
      session,
    )).resolves.toEqual({ methods: ["password", "passkey", "totp"], fallback: null });
    expect(accessToken).toHaveBeenCalledWith(session);
    expect(identity).toHaveBeenCalledWith({ accessToken: "server-held-user-token" });
  });
});


describe("e-mail sudo capability", () => {
  it("offers mail for a passwordless identity and Microsoft only for its YTÜ link", () => {
    const identity = { credentials: { password: false, totp: [], passkeys: [] }, sudoEmailCodeAvailable: true, verifiedYtu: false };
    expect(sudoMethodAvailability(identity)).toEqual({ methods: ["email-code"], fallback: null });
    expect(sudoMethodAvailability({ ...identity, verifiedYtu: true })).toEqual({ methods: ["email-code"], fallback: "microsoft" });
    expect(sudoMethodAvailability({ ...identity, credentials: { ...identity.credentials, password: true } })).toEqual({ methods: ["password"], fallback: null });
    expect(sudoMethodAvailability({ ...identity, sudoEmailCodeAvailable: false })).toEqual({ methods: [], fallback: null });
  });
});
