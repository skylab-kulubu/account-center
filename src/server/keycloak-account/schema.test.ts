// @vitest-environment node

import { describe, expect, it } from "vitest";
import credentialsFixture from "../../../tests/fixtures/keycloak-26.7.4-account-credentials.json";
import devicesFixture from "../../../tests/fixtures/keycloak-26.7.4-account-devices.json";
import profileFixture from "../../../tests/fixtures/keycloak-26.7.4-account-profile.json";
import sessionsFixture from "../../../tests/fixtures/keycloak-26.7.4-account-sessions.json";
import {
  KeycloakAccountContractError,
  parseAuthenticationSummary,
  parseDeviceHints,
  parseProfile,
  parseSessions,
} from "@/server/keycloak-account/schema";

describe("Keycloak 26.7.4 Account REST contract", () => {
  it("whitelists profile fields and drops private attributes", () => {
    const profile = parseProfile(profileFixture);
    expect(profile).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "account-fixture@example.invalid",
      emailVerified: true,
    });
    expect(JSON.stringify(profile)).not.toContain("school_email");
    expect(JSON.stringify(profile)).not.toContain("SKY-0000042");
  });

  it("reduces credential metadata to configuration status without IDs or data", () => {
    const summary = parseAuthenticationSummary(credentialsFixture);
    expect(summary).toEqual({
      passwordConfigured: true,
      otpConfigured: false,
      passkeyCount: 1,
    });
    expect(JSON.stringify(summary)).not.toContain("credential-");
    expect(JSON.stringify(summary)).not.toContain("credentialData");
  });

  it("uses canonical sessions and attaches optional device hints by session ID", () => {
    const sessions = parseSessions(sessionsFixture, parseDeviceHints(devicesFixture));
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      id: "session-current-id",
      browser: "Chrome/140.0",
      current: true,
      device: { operatingSystem: "macOS", mobile: false },
    });
    expect(sessions[1]).toMatchObject({
      id: "session-other-id",
      device: { name: "iPhone", mobile: true },
    });
    expect(JSON.stringify(sessions)).not.toContain("203.0.113.42");
    expect(JSON.stringify(sessions)).not.toContain("198.51.100.12");
    expect(JSON.stringify(sessions)).not.toContain("clients");
  });

  it("fails closed on unknown fields, leaked secrets, or merged-session ambiguity", () => {
    expect(() => parseProfile({ ...profileFixture, phoneNumber: "+900000000000" }))
      .toThrow(KeycloakAccountContractError);
    const credentials = structuredClone(credentialsFixture) as unknown as Array<{
      userCredentialMetadatas: Array<{ credential: Record<string, unknown> }>;
    }>;
    credentials[0]!.userCredentialMetadatas[0]!.credential.secretData = "must-never-arrive";
    expect(() => parseAuthenticationSummary(credentials)).toThrow(KeycloakAccountContractError);
    const duplicateDevices = [devicesFixture[0], devicesFixture[0]];
    expect(() => parseDeviceHints(duplicateDevices)).toThrow(KeycloakAccountContractError);
  });
});
