// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  requireFreshSudoOrChallenge,
  SUDO_REQUIRED_STATUS,
  sudoRequiredResponse,
} from "@/server/auth/sudo-gate";
import { SudoRequiredError } from "@/server/auth/sudo";
import type { SudoProof } from "@/server/auth/sudo";
import type { SudoMethodAvailability } from "@/server/auth/sudo-methods";
import { SkyAccountUnavailableError } from "@/server/sky-account/problem";

const session = { id: "11111111-1111-4111-8111-111111111111", subject: "person" };
const proof: SudoProof = {
  method: "password",
  sudoToken: "eyJhbGciOiJIUzUxMiJ9.eyJ0eXAiOiJza3ktc3VkbyJ9.signature-fixture",
  expiresAt: new Date("2026-09-21T13:15:18.000Z"),
};

function gate(
  outcome: SudoProof | SudoRequiredError,
  methods: SudoMethodAvailability = { methods: ["password", "totp"], fallback: null },
) {
  const requireFreshSudo = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const resolveMethods = vi.fn(async () => methods);
  return { requireFreshSudo, resolveMethods, deps: { sudo: { requireFreshSudo }, methods: resolveMethods } };
}

describe("requireFreshSudoOrChallenge", () => {
  it("hands the fresh proof to the caller without touching the identity service", async () => {
    const { deps, resolveMethods, requireFreshSudo } = gate(proof);
    const outcome = await requireFreshSudoOrChallenge(session, deps, { requestId: "request-id" });
    expect(outcome).toEqual({ ok: true, proof });
    expect(requireFreshSudo).toHaveBeenCalledWith(session.id, { requestId: "request-id" });
    expect(resolveMethods).not.toHaveBeenCalled();
  });

  it("answers 428 sudo_required with the available methods when no proof exists", async () => {
    const { deps } = gate(new SudoRequiredError("missing", null));
    const outcome = await requireFreshSudoOrChallenge(session, deps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.response.status).toBe(SUDO_REQUIRED_STATUS);
    expect(outcome.response.status).toBe(428);
    expect(outcome.response.headers.get("cache-control")).toBe("no-store");
    await expect(outcome.response.json()).resolves.toEqual({
      error: "sudo_required",
      reason: "missing",
      methods: ["password", "totp"],
      fallback: null,
    });
  });

  it("distinguishes an expired proof and offers the Microsoft fallback when no method exists", async () => {
    const { deps } = gate(new SudoRequiredError("expired", null), { methods: [], fallback: "microsoft" });
    const outcome = await requireFreshSudoOrChallenge(session, deps);
    if (outcome.ok) throw new Error("unreachable");
    await expect(outcome.response.json()).resolves.toEqual({
      error: "sudo_required",
      reason: "expired",
      methods: [],
      fallback: "microsoft",
    });
  });

  it("accepts a Microsoft re-authentication proof and exposes its missing SPI token", async () => {
    const reauth: SudoProof = { method: "reauth", sudoToken: null, expiresAt: proof.expiresAt };
    const { deps } = gate(reauth);
    await expect(requireFreshSudoOrChallenge(session, deps)).resolves.toEqual({ ok: true, proof: reauth });
  });

  it("propagates identity lookup failures instead of inventing an empty method list", async () => {
    const requireFreshSudo = vi.fn(async () => { throw new SudoRequiredError("missing", null); });
    const methods = vi.fn(async () => { throw new SkyAccountUnavailableError(); });
    await expect(requireFreshSudoOrChallenge(session, { sudo: { requireFreshSudo }, methods }))
      .rejects.toBeInstanceOf(SkyAccountUnavailableError);
  });

  it("builds a bare challenge response for callers that already know the methods", async () => {
    const response = sudoRequiredResponse({ reason: "missing", methods: ["passkey"], fallback: null });
    expect(response.status).toBe(428);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "sudo_required",
      reason: "missing",
      methods: ["passkey"],
      fallback: null,
    });
    expect(JSON.stringify(await sudoRequiredResponse({ reason: "expired", methods: [], fallback: "microsoft" }).json()))
      .not.toContain("token");
  });
});
