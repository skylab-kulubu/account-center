// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  deletionIdTokenAuthenticationTime,
  planDeletionReauthentication,
} from "@/server/account-deletion/reauthentication";

const issuer = new URL("https://e.yildizskylab.com/realms/e-skylab");
const expected = { issuer, clientId: "account-center", subject: "person-subject" };
const now = new Date("2026-09-22T12:00:00.000Z");
const seconds = (value: Date) => Math.floor(value.getTime() / 1_000);

function idToken(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return [
    part({ alg: "RS256", typ: "JWT", ...header }),
    part({
      iss: "https://e.yildizskylab.com/realms/e-skylab",
      sub: "person-subject",
      aud: "account-center",
      sid: "keycloak-session",
      auth_time: seconds(now) - 60,
      exp: seconds(now) + 300,
      ...claims,
    }),
    "signature-fixture",
  ].join(".");
}

describe("deletionIdTokenAuthenticationTime", () => {
  it("accepts the contract core verifies and returns the signed authentication time", () => {
    expect(deletionIdTokenAuthenticationTime(idToken(), expected, now))
      .toEqual(new Date(now.getTime() - 60_000));
    // The window is five minutes and tolerates five seconds of future skew.
    expect(deletionIdTokenAuthenticationTime(
      idToken({ auth_time: seconds(now) - 299 }),
      expected,
      now,
    )).toEqual(new Date((seconds(now) - 299) * 1_000));
    expect(deletionIdTokenAuthenticationTime(
      idToken({ auth_time: seconds(now) + 3 }),
      expected,
      now,
    )).toEqual(new Date((seconds(now) + 3) * 1_000));
  });

  it("refuses every token core would reject", () => {
    const refused: Array<[string, string]> = [
      ["stale authentication", idToken({ auth_time: seconds(now) - 301 })],
      ["authentication in the future", idToken({ auth_time: seconds(now) + 30 })],
      ["missing auth_time", idToken({ auth_time: undefined })],
      ["non-integer auth_time", idToken({ auth_time: 1_758_542_400.5 })],
      ["expired token", idToken({ exp: seconds(now) - 1 })],
      ["missing exp", idToken({ exp: undefined })],
      ["another subject", idToken({ sub: "someone-else" })],
      ["another issuer", idToken({ iss: "https://evil.invalid/realms/e-skylab" })],
      ["another audience", idToken({ aud: "account" })],
      ["audience as an array", idToken({ aud: ["account-center"] })],
      ["empty sid", idToken({ sid: "  " })],
      ["missing sid", idToken({ sid: undefined })],
      ["unsigned alg", idToken({}, { alg: "none" })],
      ["another token type", idToken({}, { typ: "Refresh" })],
      ["opaque material", "not-a-json-web-token"],
      ["empty value", ""],
    ];
    for (const [label, token] of refused) {
      expect(deletionIdTokenAuthenticationTime(token, expected, now), label).toBeNull();
    }
  });
});

describe("planDeletionReauthentication", () => {
  it("uses the stored ID token when the session was authenticated inside the window", () => {
    const token = idToken();
    expect(planDeletionReauthentication(token, expected, now)).toEqual({
      kind: "session_id_token",
      idToken: token,
      authenticatedAt: new Date(now.getTime() - 60_000),
    });
  });

  it("keeps the Keycloak hop when the session holds no fresh enough ID token", () => {
    expect(planDeletionReauthentication(idToken({ auth_time: seconds(now) - 600 }), expected, now))
      .toEqual({ kind: "keycloak_reauthentication" });
    expect(planDeletionReauthentication(undefined, expected, now))
      .toEqual({ kind: "keycloak_reauthentication" });
    expect(planDeletionReauthentication("", expected, now))
      .toEqual({ kind: "keycloak_reauthentication" });
  });
});
