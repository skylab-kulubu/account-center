// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountAccessAuthorizer } from "@/server/access-gate/authorization";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AccountAccessAuthorizer", () => {
  it("revokes every local subject session before returning blocked", async () => {
    const revokeSubject = vi.fn().mockResolvedValue(3);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const authorizer = new AccountAccessAuthorizer(
      { decide: async () => "blocked", ready: async () => true },
      { revokeSubject },
    );

    await expect(authorizer.authorize("raw-subject", "request-12345678")).resolves.toBe("blocked");
    expect(revokeSubject).toHaveBeenCalledWith("raw-subject");
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[0]).not.toContain("raw-subject");
    expect(warning.mock.calls[0]?.[0]).toContain('"decision":"blocked"');
  });

  it("fails closed when blocked-session cleanup cannot be confirmed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const authorizer = new AccountAccessAuthorizer(
      { decide: async () => "blocked", ready: async () => true },
      { revokeSubject: async () => { throw new Error("database unavailable"); } },
    );

    await expect(authorizer.authorize("raw-subject", "request-12345678")).resolves.toBe(
      "unavailable",
    );
  });
});
