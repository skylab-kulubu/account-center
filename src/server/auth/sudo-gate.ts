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
 * Why a mutation was refused: no proof (`missing`), a stale one (`expired`),
 * or a fresh Microsoft re-authentication that satisfies `my.`-local gates but
 * carries no sky-account token (`spi_token_required`). The last one is rare
 * now that the callback turns the fresh ID token into a real sudo token
 * (`POST sudo/authentication`): it is left over from a re-authentication
 * whose SPI call failed. The person is re-authenticated but holds nothing
 * `X-Sky-Sudo` accepts, so the useless proof is dropped here and the page
 * says the step must be repeated — the dialog then offers the Microsoft
 * fallback again.
 */
export type SudoChallengeReason = SudoRequirementReason | "spi_token_required";

/**
 * Body of the 428 answer. `methods` is what the person can prove with inside
 * `my.` (tab order) and `fallback` is the Microsoft re-authentication offered
 * only when that list is empty. The dialog re-reads
 * `GET /api/account/sudo/methods` when it opens, so this is a hint for the
 * caller, never a secret.
 */
export type SudoChallenge = SudoMethodAvailability & {
  error: "sudo_required";
  reason: SudoChallengeReason;
};

/** A proof that can be presented to the sky-account SPI. */
export type SudoSpiProof = SudoProof & { sudoToken: string };

export type SudoGateOutcome<Proof = SudoProof> =
  | { ok: true; proof: Proof }
  | { ok: false; reason: SudoChallengeReason; response: NextResponse };

export type SudoGateDependencies = {
  sudo: Pick<SudoVault, "requireFreshSudo" | "clearSudo">;
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
 * fallback) normally carries an SPI token too; the rare token-less one is
 * accepted here and refused by `requireSpiSudoOrChallenge`, which callers
 * that must present `X-Sky-Sudo` use instead.
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
    return {
      ok: false,
      reason: error.reason,
      response: sudoRequiredResponse({ reason: error.reason, ...availability }),
    };
  }
}

/**
 * The gate for routes that forward the proof to the SPI: like
 * `requireFreshSudoOrChallenge`, but a token-less Microsoft re-authentication
 * proof is refused with `428 spi_token_required` (methods included), so the
 * proof the caller receives always carries `X-Sky-Sudo` material. Such a
 * proof is also discarded: it can never satisfy this gate, and dropping it
 * turns the next attempt into an ordinary challenge whose dialog offers the
 * Microsoft fallback again.
 */
export async function requireSpiSudoOrChallenge(
  session: { id: string },
  dependencies: SudoGateDependencies,
  options: { requestId?: string } = {},
): Promise<SudoGateOutcome<SudoSpiProof>> {
  const outcome = await requireFreshSudoOrChallenge(session, dependencies, options);
  if (!outcome.ok) return outcome;
  const { proof } = outcome;
  if (proof.sudoToken === null) {
    await dependencies.sudo.clearSudo(session.id).catch(() => undefined);
    const availability = await dependencies.methods();
    return {
      ok: false,
      reason: "spi_token_required",
      response: sudoRequiredResponse({ reason: "spi_token_required", ...availability }),
    };
  }
  return { ok: true, proof: { ...proof, sudoToken: proof.sudoToken } };
}

/** Wires the gate to the shared services for a route handler. */
export function requireAccountSudo(
  services: SudoMethodsSource & { sudo: SudoGateDependencies["sudo"] },
  session: { id: string; subject: string },
  options: { requestId?: string } = {},
) {
  return requireFreshSudoOrChallenge(
    session,
    { sudo: services.sudo, methods: () => resolveSudoMethods(services, session) },
    options,
  );
}

/** Wires the SPI-token gate to the shared services for a route handler that calls a sudo-protected SPI endpoint. */
export function requireAccountSpiSudo(
  services: SudoMethodsSource & { sudo: SudoGateDependencies["sudo"] },
  session: { id: string; subject: string },
  options: { requestId?: string } = {},
) {
  return requireSpiSudoOrChallenge(
    session,
    { sudo: services.sudo, methods: () => resolveSudoMethods(services, session) },
    options,
  );
}
