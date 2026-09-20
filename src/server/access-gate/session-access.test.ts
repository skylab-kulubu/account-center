// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { AccountSessionAccess } from "@/server/access-gate/session-access";

const candidate = {
  id: "session-id",
  subject: "subject-must-not-be-logged",
  keycloakSid: "keycloak-session",
  createdAt: new Date("2026-09-20T00:00:00Z"),
  lastSeenAt: new Date("2026-09-20T00:00:00Z"),
  idleExpiresAt: new Date("2026-09-20T00:30:00Z"),
  absoluteExpiresAt: new Date("2026-09-20T08:00:00Z"),
};

function fixture(decision: "active" | "blocked" | "unavailable") {
  const sessions = {
    candidate: vi.fn().mockResolvedValue(candidate),
    authenticate: vi.fn().mockResolvedValue({ session: candidate, rotated: false }),
    authenticateMutation: vi.fn().mockResolvedValue({
      status: "active",
      value: { session: candidate, rotated: false },
    }),
    verifyCsrf: vi.fn().mockReturnValue(true),
  };
  const authorizer = { authorize: vi.fn().mockResolvedValue(decision) };
  return { access: new AccountSessionAccess(sessions, authorizer), sessions, authorizer };
}

describe("AccountSessionAccess", () => {
  it.each(["blocked", "unavailable"] as const)(
    "does not touch or rotate the session before a %s decision",
    async (decision) => {
      const { access, sessions } = fixture(decision);

      await expect(access.authenticate("h".repeat(43), { allowRotation: true })).resolves.toEqual({
        status: decision,
      });
      expect(sessions.authenticate).not.toHaveBeenCalled();
      expect(sessions.authenticateMutation).not.toHaveBeenCalled();
    },
  );

  it("revalidates and touches the handle only after an active decision", async () => {
    const { access, sessions, authorizer } = fixture("active");

    await expect(access.authenticate("h".repeat(43), { allowRotation: true })).resolves.toMatchObject({
      status: "active",
    });
    expect(authorizer.authorize).toHaveBeenCalledWith(candidate.subject, undefined);
    expect(sessions.candidate.mock.invocationCallOrder[0]).toBeLessThan(
      authorizer.authorize.mock.invocationCallOrder[0]!,
    );
    expect(authorizer.authorize.mock.invocationCallOrder[0]).toBeLessThan(
      sessions.authenticate.mock.invocationCallOrder[0]!,
    );
  });

  it("rejects invalid mutation proof before Redis and before session mutation", async () => {
    const { access, sessions, authorizer } = fixture("active");
    sessions.verifyCsrf.mockReturnValue(false);

    await expect(access.authenticateMutation("h".repeat(43), "wrong-proof")).resolves.toEqual({
      status: "forbidden",
    });
    expect(authorizer.authorize).not.toHaveBeenCalled();
    expect(sessions.authenticateMutation).not.toHaveBeenCalled();
  });
});
