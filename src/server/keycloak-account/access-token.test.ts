// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  AccountAccessTokenContractError,
  AccountAccessTokenExpiredError,
  validateAccountAccessToken,
} from "@/server/keycloak-account/access-token";

const expected = {
  issuer: new URL("https://e.yildizskylab.com/realms/e-skylab"),
  clientId: "account-center",
  subject: "user-id",
};
const now = new Date("2026-09-20T12:00:00Z");

function jwt(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", typ: "JWT" }) {
  return [header, claims, "signature"]
    .map((part) => Buffer.from(typeof part === "string" ? part : JSON.stringify(part)).toString("base64url"))
    .join(".");
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: expected.issuer.href,
    sub: expected.subject,
    azp: expected.clientId,
    aud: "account",
    scope: "openid",
    resource_access: {
      account: {
        roles: ["manage-account", "view-profile"],
      },
    },
    exp: Math.floor(now.getTime() / 1_000) + 300,
    ...overrides,
  };
}

describe("Account REST access token contract", () => {
  it("accepts only a current minimal account audience user token", () => {
    expect(validateAccountAccessToken(jwt(claims()), expected, now)).toEqual({
      expiresAt: new Date("2026-09-20T12:05:00.000Z"),
    });
  });

  it.each([
    ["an extra audience", { aud: ["account", "core"] }],
    ["another client", { azp: "service-account-client" }],
    ["another subject", { sub: "other-user" }],
    ["profile scope", { scope: "openid profile" }],
    ["another issuer", { iss: "https://attacker.invalid/realms/fake" }],
  ])("rejects %s", (_label, override) => {
    expect(() => validateAccountAccessToken(jwt(claims(override)), expected, now))
      .toThrow(AccountAccessTokenContractError);
  });

  it.each([
    ["missing account roles", { resource_access: undefined }],
    ["only profile access", { resource_access: { account: { roles: ["view-profile"] } } }],
    ["only account management", { resource_access: { account: { roles: ["manage-account"] } } }],
    ["a malformed role claim", { resource_access: { account: { roles: "manage-account" } } }],
  ])("rejects %s", (_label, override) => {
    expect(() => validateAccountAccessToken(jwt(claims(override)), expected, now))
      .toThrow(AccountAccessTokenContractError);
  });

  it("distinguishes expiry so the server can refresh without weakening the contract", () => {
    expect(() => validateAccountAccessToken(jwt(claims({ exp: 1_789_900_000 })), expected, now))
      .toThrow(AccountAccessTokenExpiredError);
  });

  it("rejects expiry timestamps outside the JavaScript date range", () => {
    expect(() => validateAccountAccessToken(
      jwt(claims({ exp: Number.MAX_SAFE_INTEGER })),
      expected,
      now,
    )).toThrow(AccountAccessTokenContractError);
  });
});
