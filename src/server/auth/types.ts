export type OidcTokenSet = {
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  tokenType: string;
  scope?: string;
  expiresAt?: number;
};

export type OidcTransactionPayload = {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expectedSubject?: string;
  expectedAuthenticatedAt?: string;
};

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
