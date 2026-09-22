export type OidcTokenSet = {
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  tokenType: string;
  scope?: string;
  expiresAt?: number;
};

type OidcTransactionBase = {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
};

export type LoginOidcTransactionPayload = OidcTransactionBase & {
  purpose?: "login";
  expectedSubject?: string;
  expectedAuthenticatedAt?: string;
};

export type AccountActionKind = "password" | "otp" | "passkey" | "delete-credential";
export type AccountActionOutcome = "success" | "cancelled" | "error" | "unverified";

export type AccountActionResult = {
  action: AccountActionKind;
  outcome: AccountActionOutcome;
};

export type StoredAccountActionResult = AccountActionResult & {
  resultHash: Buffer;
  sessionId: string;
  createdAt: Date;
  expiresAt: Date;
};

export type AccountActionTransactionPayload = OidcTransactionBase & {
  purpose: "account-action";
  expectedSubject: string;
  expectedSessionId: string;
  initiatedAt: string;
  action: {
    kind: AccountActionKind;
    keycloakAction: string;
    credentialType: "password" | "otp" | "webauthn-passwordless";
    credentialId?: string;
    beforeCredentials: Array<{
      id: string;
      type: string;
      createdAt: string | null;
    }>;
  };
};

export type AccountDeletionReauthenticationTransactionPayload = OidcTransactionBase & {
  purpose: "account-deletion-reauthentication";
  expectedSubject: string;
  expectedSessionId: string;
  initiatedAt: string;
};

/**
 * Sudo mode's Microsoft fallback: a `prompt=login&max_age=0` round trip bound
 * to the current BFF session that, on return, marks sudo for five minutes
 * from the signed `auth_time`.
 */
export type SudoReauthenticationTransactionPayload = OidcTransactionBase & {
  purpose: "sudo-reauthentication";
  expectedSubject: string;
  expectedSessionId: string;
  initiatedAt: string;
};

export type OidcTransactionPayload =
  | LoginOidcTransactionPayload
  | AccountActionTransactionPayload
  | AccountDeletionReauthenticationTransactionPayload
  | SudoReauthenticationTransactionPayload;

export type StoredOidcTransaction = {
  id: string;
  stateHash: Buffer;
  browserBindingHash: Buffer;
  payloadCiphertext: string;
  createdAt: Date;
  expiresAt: Date;
};

export type NewSessionRecord = {
  id: string;
  subject: string;
  keycloakSid: string | null;
  handleHash: Buffer;
  tokenCiphertext: string;
  createdAt: Date;
  rotatedAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
};

export type ActiveSession = {
  id: string;
  subject: string;
  keycloakSid: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
};

export type SessionUseResult = {
  session: ActiveSession;
  rotated: boolean;
};

export type BrowserSession = SessionUseResult & {
  rotatedHandle?: string;
};

export type NativeHandoffIdentity = {
  subject: string;
  keycloakSid: string;
  authenticatedAt: Date;
};

export type NewNativeHandoff = NativeHandoffIdentity & {
  id: string;
  codeHash: Buffer;
  createdAt: Date;
  expiresAt: Date;
};

export type NativeBridgeRedemption = NativeHandoffIdentity;
