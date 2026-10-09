import { describe, expect, it, vi } from "vitest";
import { brandCrossBundleError } from "@/server/cross-bundle-error";

/**
 * Every error class a service on `globalThis` (`getAuthServices`) can throw
 * at a route. Each module is loaded twice, the way `next dev` gives a route
 * compiled later its own copy, and an error built from one copy must still
 * be `instanceof` the other copy's class — and of no other class.
 */
function loadModules() {
  return Promise.all([
    import("@/server/auth/sudo"),
    import("@/server/auth/sessions"),
    import("@/server/auth/oidc-flow"),
    import("@/server/auth/oidc-protocol"),
    import("@/server/auth/backchannel-logout"),
    import("@/server/access-gate/authorization"),
    import("@/server/sky-account/problem"),
    import("@/server/keycloak-account/schema"),
    import("@/server/keycloak-account/access-token"),
    import("@/server/keycloak-account/adapter"),
    import("@/server/keycloak-account/service"),
    import("@/server/core/profile-client"),
    import("@/server/core/skypass-wallet-client"),
  ]);
}

type ErrorClass = abstract new (...args: never[]) => Error;

function errorClasses(modules: Array<Record<string, unknown>>) {
  const classes = new Map<string, ErrorClass>();
  for (const exports of modules) {
    for (const [name, value] of Object.entries(exports)) {
      if (typeof value === "function" && value.prototype instanceof Error) classes.set(name, value as ErrorClass);
    }
  }
  return classes;
}

describe("error classes shared through the service registry", () => {
  it("are recognised across two copies of their module, and only as themselves", async () => {
    const first = errorClasses(await loadModules());
    vi.resetModules();
    const second = errorClasses(await loadModules());

    expect([...first.keys()]).toEqual(expect.arrayContaining([
      "SudoRequiredError",
      "SkyAccountProblem",
      "CoreProfileRejectedError",
      "CoreSkyPassWalletError",
      "KeycloakAccountUnauthorizedError",
      "AccountReauthenticationRequiredError",
    ]));
    expect([...second.keys()]).toEqual([...first.keys()]);

    for (const [name, local] of first) {
      const foreign = second.get(name)!;
      expect(foreign, name).not.toBe(local);
      const fromOtherCopy: unknown = Object.create(foreign.prototype);
      expect(fromOtherCopy instanceof local, name).toBe(true);
      expect(Object.create(local.prototype) instanceof local, name).toBe(true);
      expect(new Error(name) instanceof local, name).toBe(false);
      expect(Object.assign(new Error(name), { name }) instanceof local, name).toBe(false);
      for (const [otherName, other] of second) {
        if (otherName !== name) expect(Object.create(other.prototype) instanceof local, `${otherName} as ${name}`).toBe(false);
      }
    }
  });
});

describe("brandCrossBundleError", () => {
  it("leaves a subclass that is not branded with the ordinary prototype check", () => {
    class BaseError extends Error {
      static {
        brandCrossBundleError(this, "test.BaseError");
      }
    }
    class SubError extends BaseError {}

    expect(new SubError() instanceof BaseError).toBe(true);
    expect(new SubError() instanceof SubError).toBe(true);
    expect(new BaseError() instanceof SubError).toBe(false);
    const notObjects: unknown[] = [null, undefined, "BaseError", 0];
    for (const value of notObjects) expect(value instanceof BaseError).toBe(false);
  });
});
