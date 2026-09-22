// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import credentialsFixture from "../../../tests/fixtures/keycloak-26.7.4-account-credentials.json";
import devicesFixture from "../../../tests/fixtures/keycloak-26.7.4-account-devices.json";
import groupsFixture from "../../../tests/fixtures/keycloak-26.7.4-account-groups.json";
import linkedAccountUriFixture from "../../../tests/fixtures/keycloak-26.7.4-account-linked-account-uri.json";
import linkedAccountsFixture from "../../../tests/fixtures/keycloak-26.7.4-account-linked-accounts.json";
import profileFixture from "../../../tests/fixtures/keycloak-26.7.4-account-profile.json";
import sessionsFixture from "../../../tests/fixtures/keycloak-26.7.4-account-sessions.json";
import {
  Keycloak26AccountReadAdapter,
  KeycloakAccountForbiddenError,
  KeycloakAccountLinkingDisabledError,
  KeycloakAccountUnavailableError,
  KeycloakAccountUnauthorizedError,
} from "@/server/keycloak-account/adapter";
import { KeycloakAccountContractError } from "@/server/keycloak-account/schema";

const issuer = new URL("https://e.yildizskylab.com/realms/e-skylab");

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

function requestUrl(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : String(input));
}

function accountRest(overrides: Partial<Record<string, () => Response>> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    expect(url.pathname).not.toContain("/admin/");
    expect(init?.method).toBe("GET");
    expect(init?.headers).toMatchObject({ authorization: "Bearer server-held-user-token" });
    const route = url.pathname.replace(/^\/realms\/e-skylab\/account/, "");
    const override = overrides[route];
    if (override) return override();
    if (route === "/") {
      expect(url.searchParams.get("userProfileMetadata")).toBe("true");
      return json(profileFixture);
    }
    if (route === "/credentials") return json(credentialsFixture);
    if (route === "/sessions/devices") return json(devicesFixture);
    if (route === "/sessions") return json(sessionsFixture);
    if (route === "/groups") {
      expect(url.searchParams.get("briefRepresentation")).toBe("false");
      return json(groupsFixture);
    }
    if (route === "/linked-accounts") {
      expect([...url.searchParams.keys()]).toEqual([]);
      return json(linkedAccountsFixture);
    }
    if (route === "/linked-accounts/OBS") {
      expect(url.searchParams.get("redirectUri")).toBe("https://my.yildizskylab.com/identity");
      return json(linkedAccountUriFixture);
    }
    return new Response(null, { status: 404 });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("Keycloak26AccountReadAdapter", () => {
  it("calls only the user Account REST endpoints and returns normalized data", async () => {
    const request = accountRest();
    const snapshot = await new Keycloak26AccountReadAdapter(issuer, request).snapshot(
      "server-held-user-token",
    );
    expect(snapshot.profile).toMatchObject({
      username: "account-fixture",
      firstName: "Ada",
      attributes: { schoolEmail: "ada@std.yildiz.edu.tr", skyNumber: "SKY-0000042" },
    });
    expect(snapshot.profile.attributeMetadata.find((attribute) => attribute.name === "firstName"))
      .toMatchObject({ readOnly: true, required: true });
    expect(snapshot.authentication.passkeyCount).toBe(1);
    expect(snapshot.sessions).toHaveLength(2);
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [
      "legacy-skymail",
      "usernameChangedAt\":[",
      "11111111-1111-4111-8111-111111111111",
      "203.0.113.42",
      "credential-passkey-one",
      "credentialData",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.map(([input]) => requestUrl(input).pathname).sort()).toEqual([
      "/realms/e-skylab/account/",
      "/realms/e-skylab/account/credentials",
      "/realms/e-skylab/account/sessions",
      "/realms/e-skylab/account/sessions/devices",
    ]);
  });

  it("reads group memberships with full representations in one request", async () => {
    const request = accountRest();
    const groups = await new Keycloak26AccountReadAdapter(issuer, request).groups("server-held-user-token");
    expect(groups.map((group) => group.path)).toEqual(["/UYELER", "/ARGE/WEBLAB", "/ARGE/WEBLAB/LIDERLER"]);
    expect(groups[1]?.attributes).toEqual({ display_name_tr: ["WebLab"], team_slug: ["weblab"] });
    expect(JSON.stringify(groups)).not.toContain("private-");
    expect(request).toHaveBeenCalledTimes(1);
    expect(requestUrl(request.mock.calls[0]![0]).href).toBe(
      "https://e.yildizskylab.com/realms/e-skylab/account/groups?briefRepresentation=false",
    );
  });

  it("reads linked identity providers in one request", async () => {
    const request = accountRest();
    const accounts = await new Keycloak26AccountReadAdapter(issuer, request).linkedAccounts(
      "server-held-user-token",
    );
    expect(accounts).toEqual([
      expect.objectContaining({ providerAlias: "OBS", connected: true, linkedUsername: "ada@std.yildiz.edu.tr" }),
      expect.objectContaining({ providerAlias: "github", connected: false, linkedUsername: null }),
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(requestUrl(request.mock.calls[0]![0]).href).toBe(
      "https://e.yildizskylab.com/realms/e-skylab/account/linked-accounts",
    );
  });

  it("builds a link URI only on demand and only for a realm broker link", async () => {
    const request = accountRest();
    const adapter = new Keycloak26AccountReadAdapter(issuer, request);
    const uri = await adapter.linkedAccountUri(
      "server-held-user-token",
      "OBS",
      new URL("https://my.yildizskylab.com/identity"),
    );
    expect(uri.href).toBe(linkedAccountUriFixture.accountLinkUri);
    expect(request).toHaveBeenCalledTimes(1);
    expect(requestUrl(request.mock.calls[0]![0]).href).toBe(
      "https://e.yildizskylab.com/realms/e-skylab/account/linked-accounts/OBS?redirectUri=https%3A%2F%2Fmy.yildizskylab.com%2Fidentity",
    );

    await expect(adapter.linkedAccountUri("server-held-user-token", "../admin", new URL("https://my.yildizskylab.com/")))
      .rejects.toBeInstanceOf(KeycloakAccountContractError);
    await expect(adapter.linkedAccountUri("server-held-user-token", "OBS", new URL("http://my.yildizskylab.com/")))
      .rejects.toBeInstanceOf(KeycloakAccountContractError);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reports the deprecated link endpoint as disabled when Keycloak answers 404", async () => {
    const request = accountRest({
      "/linked-accounts/OBS": () => json({ error: "Legacy client-initiated account linking is disabled." }, 404),
    });
    const rejection = new Keycloak26AccountReadAdapter(issuer, request).linkedAccountUri(
      "server-held-user-token",
      "OBS",
      new URL("https://my.yildizskylab.com/identity"),
    );
    await expect(rejection).rejects.toBeInstanceOf(KeycloakAccountLinkingDisabledError);
    await expect(rejection).rejects.not.toThrow(/Legacy/);
  });

  it("keeps canonical sessions when optional device activity is absent", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      return path.endsWith("/devices") ? new Response(null, { status: 404 }) : json(sessionsFixture);
    });
    const sessions = await new Keycloak26AccountReadAdapter(issuer, request).sessions("token");
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.device === null)).toBe(true);
  });

  it("fails safely for authorization rejection or schema drift without echoing upstream data", async () => {
    const unauthorized = new Keycloak26AccountReadAdapter(
      issuer,
      vi.fn().mockResolvedValue(json({ error: "token-secret" }, 401)),
    );
    await expect(unauthorized.profile("token-secret")).rejects.toBeInstanceOf(
      KeycloakAccountUnauthorizedError,
    );
    await expect(unauthorized.profile("token-secret")).rejects.not.toThrow(/token-secret/);

    const forbidden = new Keycloak26AccountReadAdapter(
      issuer,
      vi.fn().mockResolvedValue(json({ error: "role-secret" }, 403)),
    );
    await expect(forbidden.profile("token-secret")).rejects.toBeInstanceOf(
      KeycloakAccountForbiddenError,
    );
    await expect(forbidden.groups("token-secret")).rejects.toBeInstanceOf(
      KeycloakAccountForbiddenError,
    );

    const drifted = new Keycloak26AccountReadAdapter(
      issuer,
      vi.fn().mockResolvedValue(json({ ...profileFixture, futureField: "private-value" })),
    );
    await expect(drifted.profile("token-secret")).rejects.toBeInstanceOf(
      KeycloakAccountContractError,
    );
    await expect(drifted.profile("token-secret")).rejects.not.toThrow(/private-value/);

    const missingGroups = new Keycloak26AccountReadAdapter(
      issuer,
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );
    await expect(missingGroups.groups("token")).rejects.toBeInstanceOf(KeycloakAccountUnavailableError);
    await expect(missingGroups.linkedAccounts("token")).rejects.toBeInstanceOf(
      KeycloakAccountUnavailableError,
    );
  });

  it("rejects oversized Account REST responses before parsing", async () => {
    const huge = JSON.stringify({ firstName: "x".repeat(600 * 1_024) });
    const adapter = new Keycloak26AccountReadAdapter(
      issuer,
      vi.fn().mockResolvedValue(new Response(huge, {
        headers: { "content-type": "application/json" },
      })),
    );
    await expect(adapter.profile("token")).rejects.toBeInstanceOf(KeycloakAccountContractError);
  });

  it("revokes one user-owned session and all other sessions through Account REST", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const adapter = new Keycloak26AccountReadAdapter(issuer, request);

    await expect(adapter.revokeSession("user-token", "session/with spaces")).resolves.toBeUndefined();
    await expect(adapter.revokeOtherSessions("user-token")).resolves.toBeUndefined();

    expect(request).toHaveBeenNthCalledWith(
      1,
      new URL(
        "https://e.yildizskylab.com/realms/e-skylab/account/sessions/session%2Fwith%20spaces",
      ),
      expect.objectContaining({
        method: "DELETE",
        credentials: "omit",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: "Bearer user-token",
        },
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      new URL("https://e.yildizskylab.com/realms/e-skylab/account/sessions"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("fails closed when an Account REST revoke does not match the pinned 204 contract", async () => {
    const unauthorized = new Keycloak26AccountReadAdapter(
      issuer,
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );
    await expect(unauthorized.revokeOtherSessions("token")).rejects.toBeInstanceOf(
      KeycloakAccountUnauthorizedError,
    );

    const forbidden = new Keycloak26AccountReadAdapter(
      issuer,
      vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
    );
    await expect(forbidden.revokeSession("token", "session")).rejects.toBeInstanceOf(
      KeycloakAccountForbiddenError,
    );

    const drifted = new Keycloak26AccountReadAdapter(
      issuer,
      vi.fn().mockResolvedValue(Response.json({ status: "removed" })),
    );
    await expect(drifted.revokeSession("token", "session")).rejects.toBeInstanceOf(
      KeycloakAccountUnavailableError,
    );
  });

  it("never issues a POST to Account REST", () => {
    const adapter = new Keycloak26AccountReadAdapter(issuer, vi.fn());
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter)).filter((name) => name !== "constructor");
    expect(methods.sort()).toEqual([
      "authentication",
      "credentialInventory",
      "groups",
      "linkedAccountUri",
      "linkedAccounts",
      "profile",
      "revokeOtherSessions",
      "revokeSession",
      "sessions",
      "snapshot",
    ]);
  });
});
