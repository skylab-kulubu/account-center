import "server-only";

import type { SudoMethod, SudoProofMethod } from "@/server/auth/sudo";
import { sudoMethodAvailability } from "@/server/auth/sudo-methods";
import type { SkyAccountCredential, SkyAccountIdentity } from "@/server/sky-account/types";

/**
 * One row of the security page. `reference` is a session-bound HMAC of the
 * Keycloak credential id (`SessionManager.credentialReference`): the browser
 * never sees a raw credential id and can only name a credential back to the
 * same local session, which re-reads `GET identity` before acting on it.
 */
export type SecurityCredentialView = {
  reference: string;
  label: string | null;
  createdAt: string | null;
  /** Passkeys only: transports the browser reported at registration. */
  transports?: string[];
  /** A legacy two-factor `webauthn` credential: not a passkey, cannot prove sudo, may only be removed. */
  legacy?: true;
};

export type SecurityView = {
  password: boolean;
  totp: SecurityCredentialView[];
  passkeys: SecurityCredentialView[];
  sudo: {
    methods: SudoMethod[];
    fallback: "microsoft" | null;
    active: { method: SudoProofMethod; expiresAt: string } | null;
  };
};

/** Public JSON of `GET /api/account/security`: the view plus the session CSRF proof. */
export type SecurityPayload = SecurityView & { csrfToken: string };

const CREDENTIAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

type ReferenceSource = (sessionId: string, credentialId: string) => string;

function row(
  credential: SkyAccountCredential,
  sessionId: string,
  reference: ReferenceSource,
): SecurityCredentialView {
  return {
    reference: reference(sessionId, credential.id),
    label: credential.label,
    createdAt: credential.createdAt,
    ...(credential.transports ? { transports: [...credential.transports] } : {}),
    ...(credential.type === "webauthn" ? { legacy: true as const } : {}),
  };
}

/**
 * Reduces `GET identity` to what the security page shows: whether a password
 * exists, the TOTP and passkey rows with opaque references, and the Sudo
 * mode availability. No name, e-mail, username, credential id or token.
 */
export function securityView(
  identity: SkyAccountIdentity,
  session: { id: string },
  reference: ReferenceSource,
  active: { method: SudoProofMethod; expiresAt: Date } | null,
): SecurityView {
  const availability = sudoMethodAvailability(identity.credentials);
  const usable = (credential: SkyAccountCredential) => CREDENTIAL_ID.test(credential.id);
  return {
    password: identity.credentials.password,
    totp: identity.credentials.totp.filter(usable).map((credential) => row(credential, session.id, reference)),
    passkeys: identity.credentials.passkeys.filter(usable).map((credential) => row(credential, session.id, reference)),
    sudo: {
      methods: availability.methods,
      fallback: availability.fallback,
      active: active ? { method: active.method, expiresAt: active.expiresAt.toISOString() } : null,
    },
  };
}
