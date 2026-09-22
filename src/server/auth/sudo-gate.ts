import "server-only";

import { NextResponse } from "next/server";
import { noStore } from "@/server/auth/http";
import { resolveSudoMethods } from "@/server/auth/sudo-methods";
import type { SudoMethodAvailability, SudoMethodsSource } from "@/server/auth/sudo-methods";
import { SudoRequiredError } from "@/server/auth/sudo";
import type { SudoProof, SudoRequirementReason, SudoVault } from "@/server/auth/sudo";

/** `428 Precondition Required`: the mutation needs a fresh Sudo mode proof first. */
export const SUDO_REQUIRED_STATUS = 428;

/**
 * Body of the 428 answer. `methods` is what the person can prove with inside
 * `my.` (tab order) and `fallback` is the Microsoft re-authentication offered
 * only when that list is empty. The dialog re-reads
 * `GET /api/account/sudo/methods` when it opens, so this is a hint for the
 * caller, never a secret.
 */
export type SudoChallenge = SudoMethodAvailability & {
  error: "sudo_required";
  reason: SudoRequirementReason;
};

export type SudoGateOutcome =
  | { ok: true; proof: SudoProof }
  | { ok: false; response: NextResponse };

export type SudoGateDependencies = {
  sudo: Pick<SudoVault, "requireFreshSudo">;
  /** Resolves the person's available methods; called only when a challenge must be built. */
  methods: () => Promise<SudoMethodAvailability>;
};

export function sudoRequiredResponse(challenge: Omit<SudoChallenge, "error">) {
  const body: SudoChallenge = {
    error: "sudo_required",
    reason: challenge.reason,
    methods: [...challenge.methods],
    fallback: challenge.fallback,
  };
  return noStore(NextResponse.json(body, { status: SUDO_REQUIRED_STATUS }));
}

/**
 * Guard for every mutation route that calls a sudo-protected sky-account
 * endpoint. Returns the fresh proof, or a ready `428 sudo_required` response
 * listing the methods the person can use. A `reauth` proof (Microsoft
 * fallback) is fresh but carries no SPI token; callers that must present
 * `X-Sky-Sudo` decide what to do with `proof.sudoToken === null`.
 *
 * When the identity service cannot be read while building the challenge the
 * error propagates: an empty method list would wrongly tell the person that
 * no proof is possible.
 */
export async function requireFreshSudoOrChallenge(
  session: { id: string },
  dependencies: SudoGateDependencies,
  options: { requestId?: string } = {},
): Promise<SudoGateOutcome> {
  try {
    const proof = await dependencies.sudo.requireFreshSudo(session.id, {
      ...(options.requestId ? { requestId: options.requestId } : {}),
    });
    return { ok: true, proof };
  } catch (error) {
    if (!(error instanceof SudoRequiredError)) throw error;
    const availability = await dependencies.methods();
    return { ok: false, response: sudoRequiredResponse({ reason: error.reason, ...availability }) };
  }
}

/** Wires the gate to the shared services for a route handler. */
export function requireAccountSudo(
  services: SudoMethodsSource & { sudo: Pick<SudoVault, "requireFreshSudo"> },
  session: { id: string; subject: string },
  options: { requestId?: string } = {},
) {
  return requireFreshSudoOrChallenge(
    session,
    { sudo: services.sudo, methods: () => resolveSudoMethods(services, session) },
    options,
  );
}
