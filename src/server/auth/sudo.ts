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

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SudoMethod = "password" | "totp" | "passkey";
export type SudoRequirementReason = "missing" | "expired";

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

type SudoEnvelope = { sudoToken: string };

type RequireFreshSudoOptions = {
  /** Methods the person can prove with (from `GET identity`), echoed on the rejection. */
  availableMethods?: readonly SudoMethod[];
  requestId?: string;
};

function sudoAssociatedData(sessionId: string) {
  return `session:${sessionId}:sudo`;
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

  async storeSudo(sessionId: string, sudoToken: string, expiresAt: Date) {
    if (!SESSION_ID.test(sessionId)) throw new Error("Invalid session record for sudo storage.");
    if (typeof sudoToken !== "string" || !COMPACT_JWS.test(sudoToken)) {
      throw new Error("Invalid sudo token material.");
    }
    const now = this.clock();
    const expiresAtMs = expiresAt.getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
      throw new Error("The sudo proof has already expired.");
    }
    const boundedExpiresAt = new Date(Math.min(
      expiresAtMs,
      now.getTime() + SUDO_MAX_LIFETIME_SECONDS * 1_000,
    ));
    const envelope: SudoEnvelope = { sudoToken };
    const ciphertext = this.cipher.encrypt(envelope, sudoAssociatedData(sessionId));
    const stored = await this.repository.replaceSudo(sessionId, ciphertext, boundedExpiresAt, now);
    if (!stored) throw new SudoSessionInactiveError();
  }

  /**
   * Returns the plaintext sudo token for the SPI call, or throws
   * `SudoRequiredError` when no proof with more than the freshness margin
   * left exists for this session record.
   */
  async requireFreshSudo(sessionId: string, options: RequireFreshSudoOptions = {}): Promise<string> {
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
    let envelope: SudoEnvelope;
    try {
      envelope = this.cipher.decrypt<SudoEnvelope>(stored.ciphertext, sudoAssociatedData(sessionId));
      if (typeof envelope.sudoToken !== "string" || !COMPACT_JWS.test(envelope.sudoToken)) {
        throw new Error("unreadable sudo envelope");
      }
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
    return envelope.sudoToken;
  }

  async clearSudo(sessionId: string) {
    if (!SESSION_ID.test(sessionId)) return;
    await this.repository.clearSudo(sessionId);
  }
}
