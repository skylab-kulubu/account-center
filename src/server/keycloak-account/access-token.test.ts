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
    aud: ["account", "core"],
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
  it("accepts only a current user token with exactly the account and core audiences", () => {
    expect(validateAccountAccessToken(jwt(claims()), expected, now)).toEqual({
      expiresAt: new Date("2026-09-20T12:05:00.000Z"),
      authorization: {},
    });
  });

  it("treats the audience as an unordered set", () => {
    expect(validateAccountAccessToken(jwt(claims({ aud: ["core", "account"] })), expected, now))
      .toMatchObject({ expiresAt: new Date("2026-09-20T12:05:00.000Z") });
  });

  it.each([
    ["the pre-cutover single account audience", { aud: "account" }],
    ["the pre-cutover single account audience list", { aud: ["account"] }],
    ["a duplicated audience", { aud: ["account", "account", "core"] }],
    ["an extra audience", { aud: ["account", "core", "skyforms"] }],
    ["only the core audience", { aud: ["core"] }],
    ["a missing audience", { aud: undefined }],
    ["a malformed audience", { aud: { account: true, core: true } }],
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

  it.each([
    ["core roles", { core: { roles: ["admin"] } }],
    ["an empty core role list", { core: { roles: [] } }],
    ["a malformed core entry", { core: null }],
  ])("rejects a token that carries %s beside the account roles", (_label, core) => {
    const override = {
      resource_access: {
        account: { roles: ["manage-account", "view-profile"] },
        ...core,
      },
    };
    expect(() => validateAccountAccessToken(jwt(claims(override)), expected, now))
      .toThrow(AccountAccessTokenContractError);
  });

  it("parses the sky_authorization client-role claim into a flat read model", () => {
    const token = jwt(claims({
      sky_authorization: {
        account: { roles: ["manage-account", "view-profile", "manage-account-links"] },
        core: { roles: ["admin", "events.manage"] },
        skyforms: { roles: ["Yönetim Kurulu"] },
        "my.dotted-client": { roles: [] },
      },
    }));
    expect(validateAccountAccessToken(token, expected, now).authorization).toEqual({
      account: ["manage-account", "view-profile", "manage-account-links"],
      core: ["admin", "events.manage"],
      skyforms: ["Yönetim Kurulu"],
      "my.dotted-client": [],
    });
  });

  it("returns an empty read model when the claim is absent or null", () => {
    expect(validateAccountAccessToken(jwt(claims()), expected, now).authorization).toEqual({});
    expect(validateAccountAccessToken(jwt(claims({ sky_authorization: null })), expected, now).authorization)
      .toEqual({});
  });

  it("does not let the read model inherit prototype members", () => {
    const authorization = validateAccountAccessToken(
      jwt(claims({ sky_authorization: { core: { roles: ["viewer"] } } })),
      expected,
      now,
    ).authorization;
    expect(Object.getPrototypeOf(authorization)).toBeNull();
    expect("toString" in authorization).toBe(false);
  });

  it.each([
    ["a flat role list", { core: ["admin"] }],
    ["a scalar client entry", { core: "admin" }],
    ["a missing roles list", { core: {} }],
    ["an extra client field", { core: { roles: ["admin"], composite: true } }],
    ["a non-string role", { core: { roles: [42] } }],
    ["an empty role", { core: { roles: [""] } }],
    ["a control character in a role", { core: { roles: ["admin\u0000"] } }],
    ["an empty client id", { "": { roles: ["admin"] } }],
    ["whitespace in a client id", { "core api": { roles: ["admin"] } }],
    ["an oversized client id", { ["c".repeat(256)]: { roles: ["admin"] } }],
    ["an oversized role", { core: { roles: ["r".repeat(256)] } }],
    ["a duplicated role", { core: { roles: ["admin", "admin"] } }],
    ["a __proto__ client id", JSON.parse('{"__proto__":{"roles":["admin"]}}') as unknown],
    ["a constructor client id", { constructor: { roles: ["admin"] } }],
    ["a list instead of a map", [{ roles: ["admin"] }]],
    ["a scalar claim", "core:admin"],
  ])("rejects %s inside sky_authorization", (_label, skyAuthorization) => {
    expect(() => validateAccountAccessToken(
      jwt(claims({ sky_authorization: skyAuthorization })),
      expected,
      now,
    )).toThrow(AccountAccessTokenContractError);
  });

  it("caps the number of clients and roles in sky_authorization", () => {
    const tooManyClients = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`client-${index}`, { roles: ["viewer"] }]),
    );
    expect(() => validateAccountAccessToken(
      jwt(claims({ sky_authorization: tooManyClients })),
      expected,
      now,
    )).toThrow(AccountAccessTokenContractError);

    const tooManyRoles = { core: { roles: Array.from({ length: 257 }, (_, index) => `role-${index}`) } };
    expect(() => validateAccountAccessToken(
      jwt(claims({ sky_authorization: tooManyRoles })),
      expected,
      now,
    )).toThrow(AccountAccessTokenContractError);

    const atTheLimit = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`client-${index}`, { roles: ["viewer"] }]),
    );
    expect(Object.keys(validateAccountAccessToken(
      jwt(claims({ sky_authorization: atTheLimit })),
      expected,
      now,
    ).authorization)).toHaveLength(64);
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
