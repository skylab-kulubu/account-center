// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import credentialsFixture from "../../../tests/fixtures/keycloak-26.7.4-account-credentials.json";
import devicesFixture from "../../../tests/fixtures/keycloak-26.7.4-account-devices.json";
import profileFixture from "../../../tests/fixtures/keycloak-26.7.4-account-profile.json";
import sessionsFixture from "../../../tests/fixtures/keycloak-26.7.4-account-sessions.json";
import {
  Keycloak26AccountReadAdapter,
  KeycloakAccountForbiddenError,
  KeycloakAccountUnavailableError,
  KeycloakAccountUnauthorizedError,
} from "@/server/keycloak-account/adapter";
import { KeycloakAccountContractError } from "@/server/keycloak-account/schema";

const issuer = new URL("https://e.yildizskylab.com/realms/e-skylab");

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

afterEach(() => vi.restoreAllMocks());

describe("Keycloak26AccountReadAdapter", () => {
  it("calls only the user Account REST endpoints and returns normalized data", async () => {
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).not.toContain("/admin/");
      expect(init?.headers).toMatchObject({ authorization: "Bearer server-held-user-token" });
      if (url.pathname.endsWith("/account/")) return json(profileFixture);
      if (url.pathname.endsWith("/account/credentials")) return json(credentialsFixture);
      if (url.pathname.endsWith("/account/sessions/devices")) return json(devicesFixture);
      if (url.pathname.endsWith("/account/sessions")) return json(sessionsFixture);
      return new Response(null, { status: 404 });
    });
    const snapshot = await new Keycloak26AccountReadAdapter(issuer, request).snapshot(
      "server-held-user-token",
    );
    expect(snapshot.profile.firstName).toBe("Ada");
    expect(snapshot.authentication.passkeyCount).toBe(1);
    expect(snapshot.sessions).toHaveLength(2);
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [
      "school_email",
      "SKY-0000042",
      "203.0.113.42",
      "credential-passkey-one",
      "credentialData",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("keeps canonical sessions when optional device activity is absent", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
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

    const drifted = new Keycloak26AccountReadAdapter(
      issuer,
      vi.fn().mockResolvedValue(json({ ...profileFixture, futureField: "private-value" })),
    );
    await expect(drifted.profile("token-secret")).rejects.toBeInstanceOf(
      KeycloakAccountContractError,
    );
    await expect(drifted.profile("token-secret")).rejects.not.toThrow(/private-value/);
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
});
