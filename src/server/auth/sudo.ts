import "server-only";

import { randomUUID } from "node:crypto";
import { COMPACT_JWS } from "@/server/contract-shapes";
import type { SecretCipher } from "@/server/auth/crypto";
import { logAuthEvent } from "@/server/auth/logging";
import type { SudoRepository } from "@/server/auth/repositories";

/** Upper bound for a stored sudo proof; the sky-account SPI issues five-minute tokens. */
export const SUDO_MAX_LIFETIME_SECONDS = 15 * 60;
/** A sudo proof with this little life left is not handed out, so the SPI call cannot race the deadline. */
export const SUDO_FRESHNESS_MARGIN_SECONDS = 5;
/**
 * A Microsoft re-authentication (`prompt=login&max_age=0`) marks sudo for five
 * minutes from the signed `auth_time`, the same window the SPI grants a token.
 */
export const SUDO_REAUTHENTICATION_LIFETIME_SECONDS = 5 * 60;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A proof method the person completes inside `my.` against the sky-account SPI. */
export type SudoMethod = "password" | "totp" | "passkey";
/**
 * Every proof kind the vault records. `reauth` is the Microsoft fallback: the
 * callback turns the fresh ID token into a sky-account token with
 * `POST sudo/authentication`, so a `reauth` proof normally carries SPI
 * material like the other three. Only when that call fails does it fall back
 * to a token-less proof, which satisfies `my.`-local gates alone.
 */
export type SudoProofMethod = SudoMethod | "reauth";
export type SudoRequirementReason = "missing" | "expired";

export const sudoMethods: readonly SudoMethod[] = ["password", "passkey", "totp"];
const sudoProofMethods: ReadonlySet<string> = new Set<SudoProofMethod>([...sudoMethods, "reauth"]);

export function isSudoMethod(value: unknown): value is SudoMethod {
  return typeof value === "string" && (sudoMethods as readonly string[]).includes(value);
}

/**
 * A fresh sudo proof. `sudoToken` is the opaque sky-account token for
 * `X-Sky-Sudo`, or `null` for a Microsoft re-authentication whose
 * `POST sudo/authentication` call did not succeed: such a proof satisfies
 * `my.`-local gates but cannot be presented to the SPI.
 */
export type SudoProof = {
  method: SudoProofMethod;
  sudoToken: string | null;
  expiresAt: Date;
};

/** Browser-safe view of the current proof: no token material. */
export type SudoStatus = {
  method: SudoProofMethod;
  expiresAt: Date;
};

/**
 * Thrown by `requireFreshSudo` when a mutation must not proceed. Routes turn
 * it into `428 sudo_required` with the methods the person can use.
 */
export class SudoRequiredError extends Error {
  constructor(
    readonly reason: SudoRequirementReason,
    readonly availableMethods: readonly SudoMethod[] | null,
  ) {
    super(`A fresh sudo proof is required (${reason}).`);
    this.name = "SudoRequiredError";
  }
}

export class SudoSessionInactiveError extends Error {
  constructor() {
    super("The session is no longer active; the sudo proof was not stored.");
    this.name = "SudoSessionInactiveError";
  }
}

type SudoEnvelope = { sudoToken: string | null; method: SudoProofMethod };

type RequireFreshSudoOptions = {
  /** Methods the person can prove with (from `GET identity`), echoed on the rejection. */
  availableMethods?: readonly SudoMethod[];
  requestId?: string;
};

function sudoAssociatedData(sessionId: string) {
  return `session:${sessionId}:sudo`;
}

function validEnvelope(value: unknown): value is SudoEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Record<string, unknown>;
  if (typeof envelope.method !== "string" || !sudoProofMethods.has(envelope.method)) return false;
  // Only the Microsoft fallback may lack a token, and only when the SPI refused to issue one.
  if (envelope.method === "reauth" && envelope.sudoToken === null) return true;
  return typeof envelope.sudoToken === "string" && COMPACT_JWS.test(envelope.sudoToken);
}

/**
 * Keeps the opaque sky-account sudo token encrypted on the session record.
 * The token never reaches the browser; it is decrypted only to be forwarded
 * in `X-Sky-Sudo` for the person's own sensitive actions. Every method takes
 * the local session record id.
 */
export class SudoVault {
  constructor(
    private readonly repository: SudoRepository,
    private readonly cipher: SecretCipher,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async #store(sessionId: string, envelope: SudoEnvelope, expiresAt: Date, now: Date) {
    const boundedExpiresAt = new Date(Math.min(
      expiresAt.getTime(),
      now.getTime() + SUDO_MAX_LIFETIME_SECONDS * 1_000,
    ));
    const ciphertext = this.cipher.encrypt(envelope, sudoAssociatedData(sessionId));
    const stored = await this.repository.replaceSudo(sessionId, ciphertext, boundedExpiresAt, now);
    if (!stored) throw new SudoSessionInactiveError();
  }

  /**
   * Records a sky-account sudo grant. `method` is the proof the SPI accepted:
   * one the person completed inside `my.`, or `reauth` for the grant the
   * callback obtained with `POST sudo/authentication` from a fresh Microsoft
   * login. The deadline is the SPI's, still bounded by the local maximum.
   */
  async storeSudo(sessionId: string, sudoToken: string, expiresAt: Date, method: SudoProofMethod) {
    if (!SESSION_ID.test(sessionId)) throw new Error("Invalid session record for sudo storage.");
    if (typeof sudoToken !== "string" || !COMPACT_JWS.test(sudoToken)) {
      throw new Error("Invalid sudo token material.");
    }
    if (!sudoProofMethods.has(method)) throw new Error("Invalid sudo proof method.");
    const now = this.clock();
    const expiresAtMs = expiresAt.getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
      throw new Error("The sudo proof has already expired.");
    }
    await this.#store(sessionId, { sudoToken, method }, expiresAt, now);
  }

  /**
   * Records a Microsoft re-authentication as a token-less proof that lasts
   * five minutes from the signed `auth_time` the callback verified. This is
   * the fallback of the fallback: the callback writes it only when
   * `POST sudo/authentication` could not turn the same login into a real
   * sudo token. A fresh proof that carries SPI material is worth more and is
   * never replaced; the method then returns `false`.
   */
  async storeReauthenticationProof(sessionId: string, authenticatedAt: Date): Promise<boolean> {
    if (!SESSION_ID.test(sessionId)) throw new Error("Invalid session record for sudo storage.");
    const now = this.clock();
    const authenticatedAtMs = authenticatedAt.getTime();
    if (!Number.isFinite(authenticatedAtMs)) throw new Error("The re-authentication proof has already expired.");
    if (authenticatedAtMs > now.getTime() + 5_000) throw new Error("The re-authentication time is in the future.");
    const expiresAt = new Date(authenticatedAtMs + SUDO_REAUTHENTICATION_LIFETIME_SECONDS * 1_000);
    if (expiresAt.getTime() <= now.getTime()) throw new Error("The re-authentication proof has already expired.");
    if (await this.#holdsFreshTokenProof(sessionId, now)) return false;
    await this.#store(sessionId, { sudoToken: null, method: "reauth" }, expiresAt, now);
    return true;
  }

  async #holdsFreshTokenProof(sessionId: string, now: Date) {
    const stored = await this.repository.readSudo(sessionId, now);
    if (!stored) return false;
    const deadline = stored.expiresAt.getTime() - SUDO_FRESHNESS_MARGIN_SECONDS * 1_000;
    if (!Number.isFinite(deadline) || deadline <= now.getTime()) return false;
    try {
      const envelope = this.cipher.decrypt<unknown>(stored.ciphertext, sudoAssociatedData(sessionId));
      return validEnvelope(envelope) && envelope.sudoToken !== null;
    } catch {
      return false;
    }
  }

  /**
   * Returns the fresh proof for the SPI call (token, method, deadline), or
   * throws `SudoRequiredError` when no proof with more than the freshness
   * margin left exists for this session record.
   */
  async requireFreshSudo(sessionId: string, options: RequireFreshSudoOptions = {}): Promise<SudoProof> {
    const hint = options.availableMethods ? [...options.availableMethods] : null;
    const stored = SESSION_ID.test(sessionId)
      ? await this.repository.readSudo(sessionId, this.clock())
      : null;
    if (!stored) throw new SudoRequiredError("missing", hint);
    const deadline = stored.expiresAt.getTime() - SUDO_FRESHNESS_MARGIN_SECONDS * 1_000;
    if (!Number.isFinite(deadline) || deadline <= this.clock().getTime()) {
      await this.repository.clearSudo(sessionId).catch(() => undefined);
      throw new SudoRequiredError("expired", hint);
    }
    let envelope: unknown;
    try {
      envelope = this.cipher.decrypt<unknown>(stored.ciphertext, sudoAssociatedData(sessionId));
      if (!validEnvelope(envelope)) throw new Error("unreadable sudo envelope");
    } catch {
      await this.repository.clearSudo(sessionId).catch(() => undefined);
      logAuthEvent({
        event: "sudo_material_discarded",
        requestId: options.requestId ?? randomUUID(),
        outcome: "failure",
        reason: "sudo_decrypt_failed",
      });
      throw new SudoRequiredError("missing", hint);
    }
    return { method: envelope.method, sudoToken: envelope.sudoToken, expiresAt: stored.expiresAt };
  }

  /** The current fresh proof without its token, or `null`; never throws for a missing proof. */
  async currentSudo(sessionId: string, options: { requestId?: string } = {}): Promise<SudoStatus | null> {
    try {
      const proof = await this.requireFreshSudo(sessionId, options);
      return { method: proof.method, expiresAt: proof.expiresAt };
    } catch (error) {
      if (error instanceof SudoRequiredError) return null;
      throw error;
    }
  }

  async clearSudo(sessionId: string) {
    if (!SESSION_ID.test(sessionId)) return;
    await this.repository.clearSudo(sessionId);
  }
}
