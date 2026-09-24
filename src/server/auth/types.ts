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

/**
 * The YTÜ account link: a `kc_action=idp_link` round trip bound to the current
 * BFF session that returns to the identity page. No forced login: Keycloak
 * sends the person to Microsoft, and the callback proves the link by reading
 * the identity again rather than by trusting `kc_action_status`.
 */
export type YtuLinkTransactionPayload = OidcTransactionBase & {
  purpose: "ytu-link";
  returnTo: "/identity";
  expectedSubject: string;
  expectedSessionId: string;
  initiatedAt: string;
};

export type OidcTransactionPayload =
  | LoginOidcTransactionPayload
  | SudoReauthenticationTransactionPayload
  | YtuLinkTransactionPayload;

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
