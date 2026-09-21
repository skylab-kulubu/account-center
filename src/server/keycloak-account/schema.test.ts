// @vitest-environment node

import { describe, expect, it } from "vitest";
import credentialsFixture from "../../../tests/fixtures/keycloak-26.7.4-account-credentials.json";
import devicesFixture from "../../../tests/fixtures/keycloak-26.7.4-account-devices.json";
import groupsFixture from "../../../tests/fixtures/keycloak-26.7.4-account-groups.json";
import linkedAccountUriFixture from "../../../tests/fixtures/keycloak-26.7.4-account-linked-account-uri.json";
import linkedAccountsFixture from "../../../tests/fixtures/keycloak-26.7.4-account-linked-accounts.json";
import profileFixture from "../../../tests/fixtures/keycloak-26.7.4-account-profile.json";
import sessionsFixture from "../../../tests/fixtures/keycloak-26.7.4-account-sessions.json";
import {
  KeycloakAccountContractError,
  parseAuthenticationSummary,
  parseCredentialInventory,
  parseDeviceHints,
  parseGroups,
  parseLinkedAccountUri,
  parseLinkedAccounts,
  parseProfile,
  parseSessions,
} from "@/server/keycloak-account/schema";

const issuer = new URL("https://e.yildizskylab.com/realms/e-skylab");

describe("Keycloak 26.7.4 Account REST contract", () => {
  it("keeps the identity fields, the pinned attributes, and the evaluated profile metadata", () => {
    const profile = parseProfile(profileFixture);
    expect(profile).toMatchObject({
      username: "account-fixture",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "account-fixture@example.invalid",
      emailVerified: true,
      attributes: {
        schoolEmail: "ada@std.yildiz.edu.tr",
        personalEmail: "ada-personal@example.invalid",
        skyNumber: "SKY-0000042",
        department: "Bilgisayar Mühendisliği",
        university: "Yıldız Teknik Üniversitesi",
      },
    });
    expect(Object.keys(profile.attributes).sort()).toEqual([
      "department",
      "personalEmail",
      "schoolEmail",
      "skyNumber",
      "university",
    ]);
    expect(profile.attributeMetadata.map((attribute) => attribute.name)).toEqual([
      "username",
      "email",
      "firstName",
      "lastName",
      "schoolEmail",
      "personalEmail",
      "skyNumber",
      "department",
      "university",
      "skyMail",
      "usernameChangedAt",
    ]);
    expect(profile.attributeMetadata.find((attribute) => attribute.name === "schoolEmail")).toEqual({
      name: "schoolEmail",
      displayName: "Okul e-postası",
      required: false,
      readOnly: true,
      validators: { email: {} },
      annotations: { inputType: "text" },
    });
    expect(profile.attributeMetadata.find((attribute) => attribute.name === "username")).toMatchObject({
      readOnly: true,
      required: true,
      validators: { length: { min: 3, max: 255 } },
      annotations: {},
    });
    const serialized = JSON.stringify(profile);
    for (const dropped of ["legacy-skymail", "usernameChangedAt\":[", "\"locale\"", "11111111-1111", "defaultValue", "\"group\""]) {
      expect(serialized).not.toContain(dropped);
    }
  });

  it("nulls missing pinned attributes and metadata without inventing values", () => {
    const profile = parseProfile({
      username: "minimal",
      emailVerified: false,
      attributes: { schoolEmail: [" ada@std.yildiz.edu.tr "], skyNumber: [] },
    });
    expect(profile).toEqual({
      username: "minimal",
      firstName: null,
      lastName: null,
      email: null,
      emailVerified: false,
      attributes: {
        schoolEmail: "ada@std.yildiz.edu.tr",
        personalEmail: null,
        skyNumber: null,
        department: null,
        university: null,
      },
      attributeMetadata: [],
    });
    expect(parseProfile({ ...profileFixture, userProfileMetadata: null }).attributeMetadata).toEqual([]);
  });

  it("fails closed on drifted profile metadata", () => {
    const metadata = () => structuredClone(profileFixture.userProfileMetadata);
    const withAttribute = (attribute: Record<string, unknown>) => ({
      ...profileFixture,
      userProfileMetadata: { ...metadata(), attributes: [attribute] },
    });
    const base = profileFixture.userProfileMetadata.attributes[4]!;
    for (const drifted of [
      { ...base, futureField: true },
      { ...base, name: "" },
      { ...base, required: "yes" },
      { ...base, readOnly: null },
      { ...base, validators: ["email"] },
      { ...base, validators: { email: "configured" } },
      { ...base, annotations: "inputType=text" },
      { ...base, annotations: { inputType: () => "text" } },
      { ...base, displayName: 42 },
    ]) {
      expect(() => parseProfile(withAttribute(drifted))).toThrow(KeycloakAccountContractError);
    }
    expect(() => parseProfile({ ...profileFixture, userProfileMetadata: { attributes: "none" } }))
      .toThrow(KeycloakAccountContractError);
    expect(() => parseProfile({ ...profileFixture, userProfileMetadata: { ...metadata(), extra: true } }))
      .toThrow(KeycloakAccountContractError);
    const duplicated = withAttribute(base);
    duplicated.userProfileMetadata.attributes.push(base);
    expect(() => parseProfile(duplicated)).toThrow(KeycloakAccountContractError);
    const oversized = {
      ...profileFixture,
      userProfileMetadata: {
        ...metadata(),
        attributes: Array.from({ length: 65 }, (_, index) => ({ ...base, name: `attribute-${index}` })),
      },
    };
    expect(() => parseProfile(oversized)).toThrow(KeycloakAccountContractError);
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

  it("keeps the owned credential inventory server-side for AIA verification", () => {
    const inventory = parseCredentialInventory(credentialsFixture);
    expect(inventory.summary.passkeyCount).toBe(1);
    expect(inventory.credentials).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "credential-passkey-one",
        type: "webauthn-passwordless",
        label: "MacBook Touch ID",
        removeable: true,
      }),
    ]));
    expect(JSON.stringify(inventory)).not.toContain("credentialData");
    expect(JSON.stringify(inventory)).not.toContain("private");
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

  it("keeps group identity, path, and attributes but drops group role mappings", () => {
    const groups = parseGroups(groupsFixture);
    expect(groups).toEqual([
      {
        id: "5b7c0f6e-0d6a-4e0e-9f2f-000000000001",
        name: "UYELER",
        path: "/UYELER",
        attributes: { display_name_tr: ["Üyeler"] },
      },
      {
        id: "5b7c0f6e-0d6a-4e0e-9f2f-000000000002",
        name: "WEBLAB",
        path: "/ARGE/WEBLAB",
        attributes: { display_name_tr: ["WebLab"], team_slug: ["weblab"] },
      },
      {
        id: "5b7c0f6e-0d6a-4e0e-9f2f-000000000003",
        name: "LIDERLER",
        path: "/ARGE/WEBLAB/LIDERLER",
        attributes: {},
      },
    ]);
    const serialized = JSON.stringify(groups);
    for (const dropped of ["private-realm-role", "private-client-role", "team.weblab", "parentId", "Web ve platform"]) {
      expect(serialized).not.toContain(dropped);
    }
    expect(parseGroups([])).toEqual([]);
  });

  it("fails closed on drifted or ambiguous group payloads", () => {
    const group = groupsFixture[0]!;
    for (const drifted of [
      [{ ...group, futureField: 1 }],
      [{ ...group, id: "" }],
      [{ ...group, path: "UYELER" }],
      [{ ...group, attributes: { display_name_tr: "Üyeler" } }],
      [{ ...group, attributes: JSON.parse('{"__proto__":["x"]}') as unknown }],
      [group, group],
      Array.from({ length: 257 }, (_, index) => ({ ...group, id: `group-${index}`, path: `/G${index}` })),
      { groups: [group] },
    ]) {
      expect(() => parseGroups(drifted)).toThrow(KeycloakAccountContractError);
    }
  });

  it("normalizes linked identity providers and their connection state", () => {
    expect(parseLinkedAccounts(linkedAccountsFixture)).toEqual([
      {
        connected: true,
        providerAlias: "OBS",
        displayName: "YTÜ Microsoft",
        linkedUsername: "ada@std.yildiz.edu.tr",
        social: false,
      },
      {
        connected: false,
        providerAlias: "github",
        displayName: "GitHub",
        linkedUsername: null,
        social: true,
      },
    ]);
    expect(JSON.stringify(parseLinkedAccounts(linkedAccountsFixture))).not.toContain("providerName");
    expect(parseLinkedAccounts([])).toEqual([]);
  });

  it("fails closed on drifted linked-account payloads", () => {
    const account = linkedAccountsFixture[0]!;
    for (const drifted of [
      [{ ...account, guiOrder: "1" }],
      [{ ...account, connected: "true" }],
      [{ ...account, providerAlias: "" }],
      [{ ...account, providerAlias: "OBS/../admin" }],
      [{ ...account, social: null }],
      [account, account],
      { accounts: [account] },
    ]) {
      expect(() => parseLinkedAccounts(drifted)).toThrow(KeycloakAccountContractError);
    }
  });

  it("accepts a link URI only on the realm broker path of the configured issuer", () => {
    const uri = parseLinkedAccountUri(linkedAccountUriFixture, issuer, "OBS");
    expect(uri.href).toBe(linkedAccountUriFixture.accountLinkUri);
    for (const drifted of [
      { ...linkedAccountUriFixture, accountLinkUri: "https://attacker.invalid/realms/e-skylab/broker/OBS/link?nonce=n&hash=h" },
      { ...linkedAccountUriFixture, accountLinkUri: "http://e.yildizskylab.com/realms/e-skylab/broker/OBS/link?nonce=n&hash=h" },
      { ...linkedAccountUriFixture, accountLinkUri: "https://e.yildizskylab.com/realms/other/broker/OBS/link?nonce=n&hash=h" },
      { ...linkedAccountUriFixture, accountLinkUri: "https://e.yildizskylab.com/realms/e-skylab/broker/github/link?nonce=n&hash=h" },
      { ...linkedAccountUriFixture, accountLinkUri: "https://e.yildizskylab.com/realms/e-skylab/admin/OBS/link" },
      { ...linkedAccountUriFixture, accountLinkUri: "not a url" },
      { ...linkedAccountUriFixture, extra: true },
      { accountLinkUri: linkedAccountUriFixture.accountLinkUri },
      { ...linkedAccountUriFixture, nonce: 12 },
    ]) {
      expect(() => parseLinkedAccountUri(drifted, issuer, "OBS")).toThrow(KeycloakAccountContractError);
    }
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
    const duplicateCurrent = structuredClone(sessionsFixture);
    duplicateCurrent[1]!.current = true;
    expect(() => parseSessions(duplicateCurrent)).toThrow(KeycloakAccountContractError);
    const missingCurrent = structuredClone(sessionsFixture);
    missingCurrent[0]!.current = false;
    expect(() => parseSessions(missingCurrent)).toThrow(KeycloakAccountContractError);
  });

  it("keeps the explicit empty-session state separate from current-session drift", () => {
    expect(parseSessions([])).toEqual([]);
  });
});
