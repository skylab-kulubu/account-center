// @vitest-environment node

import { describe, expect, it } from "vitest";
import { KeycloakAccountContractError } from "@/server/keycloak-account/schema";
import { toAccountProblem } from "@/server/keycloak-account/problem";

describe("Account REST safe problems", () => {
  it("maps schema drift to a visible response without raw upstream material", () => {
    const error = new KeycloakAccountContractError("credentials") as Error & { upstream?: unknown };
    error.upstream = {
      email: "private@example.invalid",
      token: "server-token",
      ipAddress: "203.0.113.42",
    };
    const problem = toAccountProblem(error);
    expect(problem).toMatchObject({ status: 502, title: "Kimlik bilgileri güvenle durduruldu" });
    const serialized = JSON.stringify(problem);
    expect(serialized).not.toContain("private@example.invalid");
    expect(serialized).not.toContain("server-token");
    expect(serialized).not.toContain("203.0.113.42");
    expect(serialized).not.toContain("credentials");
  });
});
