import { describe, expect, it } from "vitest";
import type { AuthorizationServer } from "oauth4webapi";
import { validateOidcMetadataContract } from "@/server/auth/oidc-protocol";
import fixtureJson from "../../../tests/fixtures/keycloak-26.7.4-discovery.json";

const fixture = fixtureJson as AuthorizationServer;
const config = { issuer: new URL("https://e.yildizskylab.com/realms/e-skylab") };

describe("Keycloak 26.7.4 discovery contract", () => {
  it("accepts the pinned contract fixture", () => {
    expect(() => validateOidcMetadataContract(fixture, config)).not.toThrow();
  });

  it("rejects a provider without PAR or S256", () => {
    expect(() =>
      validateOidcMetadataContract(
        { ...fixture, pushed_authorization_request_endpoint: undefined },
        config,
      ),
    ).toThrow(/pushed_authorization_request_endpoint/);
    expect(() =>
      validateOidcMetadataContract({ ...fixture, code_challenge_methods_supported: ["plain"] }, config),
    ).toThrow(/S256/);
  });

  it("rejects endpoints moved outside the configured realm", () => {
    expect(() =>
      validateOidcMetadataContract(
        { ...fixture, token_endpoint: "https://attacker.invalid/token" },
        config,
      ),
    ).toThrow(/outside/);
  });
});
