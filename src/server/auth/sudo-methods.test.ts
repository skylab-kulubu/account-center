// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import identityFixture from "../../../tests/fixtures/sky-account-v1-identity.json";
import { resolveSudoMethods, sudoMethodAvailability } from "@/server/auth/sudo-methods";
import type { SkyAccountIdentity } from "@/server/sky-account/types";

const credentials = identityFixture.credentials as SkyAccountIdentity["credentials"];

describe("sudo method availability", () => {
  it("lists the methods in tab order and never a Microsoft fallback when one exists", () => {
    expect(sudoMethodAvailability(credentials)).toEqual({
      methods: ["password", "passkey", "totp"],
      fallback: null,
    });
    expect(sudoMethodAvailability({ ...credentials, password: false })).toEqual({
      methods: ["passkey", "totp"],
      fallback: null,
    });
    expect(sudoMethodAvailability({ ...credentials, totp: [] })).toEqual({
      methods: ["password", "passkey"],
      fallback: null,
    });
  });

  it("counts only passwordless passkeys, not legacy two-factor WebAuthn credentials", () => {
    const legacyOnly = credentials.passkeys.filter(({ type }) => type === "webauthn");
    expect(legacyOnly).toHaveLength(1);
    expect(sudoMethodAvailability({ password: false, totp: [], passkeys: legacyOnly })).toEqual({
      methods: [],
      fallback: "microsoft",
    });
  });

  it("offers the Microsoft re-authentication only when no in-product method exists", () => {
    expect(sudoMethodAvailability({ password: false, totp: [], passkeys: [] })).toEqual({
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
