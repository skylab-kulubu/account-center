/**
 * sky-account API v1 read models. The wire contract is pinned in
 * `docs/sky-account-api.md` (v1) and the fixtures under
 * `tests/fixtures/sky-account-v1-*.json`.
 */

export type SkyAccountCredentialType = "otp" | "webauthn-passwordless" | "webauthn";

export type SkyAccountCredential = {
  id: string;
  type: SkyAccountCredentialType;
  label: string | null;
  createdAt: string | null;
  /** Transports the browser reported at registration (passkeys only; ordered, absent when the SPI omits them). */
  transports?: string[];
};

export type SkyAccountPrimaryEmail = "school" | "personal" | "none";

export type SkyAccountIdentity = {
  sub: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  emailVerified: boolean;
  schoolEmail: string | null;
  personalEmail: string | null;
  /**
   * The Personal e-mail was proven with the mailed code (the SPI's
   * `personalEmailVerifiedAt` stamp). `false` without an address, and also
   * when an SPI release older than the e-mail endpoints omits the member:
   * an address nobody is known to have proven is never offered as primary.
   */
  personalEmailVerified: boolean;
  primary: SkyAccountPrimaryEmail;
  verifiedYtu: boolean;
  nameLocked: boolean;
  usernameChangeAvailableAt: string | null;
  credentials: {
    password: boolean;
    totp: SkyAccountCredential[];
    passkeys: SkyAccountCredential[];
  };
};

/** An opaque, Keycloak-signed sudo token; Account Center stores it encrypted and never inspects it. */
export type SudoGrant = {
  sudoToken: string;
  expiresAt: Date;
};

/**
 * `POST sudo/webauthn/options`: the assertion options the browser hands to
 * `navigator.credentials.get()` after base64url → `ArrayBuffer` conversion
 * (`challenge`, `allowCredentials[].id`). The BFF relays it unchanged.
 */
export type WebauthnAssertionOptions = {
  challenge: string;
  rpId: string;
  allowCredentials: Array<{
    type: "public-key";
    id: string;
    transports?: string[];
  }>;
  userVerification: "required" | "preferred" | "discouraged";
  timeout?: number;
};

/**
 * `POST sudo/webauthn/verify` body: the `PublicKeyCredential` JSON the browser
 * produced (base64url members, `id == rawId`). The BFF validates the shape and
 * forwards exactly these members; it never inspects or reuses the assertion.
 * `authenticatorAttachment` belongs to the registration body only (contract),
 * and the SPI rejects unknown members, so it is not part of this type.
 */
export type WebauthnAssertion = {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
  };
};

/**
 * `POST credentials/webauthn/options`: the creation options the browser hands
 * to `navigator.credentials.create()` after base64url → `ArrayBuffer`
 * conversion (`challenge`, `user.id`, `excludeCredentials[].id`). Produced by
 * the realm passwordless policy; the BFF relays it unchanged.
 */
export type WebauthnRegistrationOptions = {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number;
  excludeCredentials: Array<{
    type: "public-key";
    id: string;
    transports?: string[];
  }>;
  authenticatorSelection: {
    authenticatorAttachment?: "platform" | "cross-platform";
    residentKey?: "required" | "preferred" | "discouraged";
    requireResidentKey?: boolean;
    userVerification?: "required" | "preferred" | "discouraged";
  };
  attestation?: "none" | "indirect" | "direct" | "enterprise";
  extensions: { credProps: true };
};

/**
 * `POST credentials/webauthn/register` body without `label`: the
 * `PublicKeyCredential` JSON the browser produced for the creation ceremony
 * (base64url members, `id == rawId`). `transports` and
 * `authenticatorAttachment` are the browser's own report and are forwarded
 * because Keycloak stores and checks them; free-form client extension
 * results are never forwarded.
 */
export type WebauthnAttestation = {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  };
  authenticatorAttachment?: "platform" | "cross-platform";
};

/** `202` answer of `POST email/change-request`: the six-digit code went out and dies at `expiresAt` (ten minutes). */
export type EmailChangeRequest = {
  expiresAt: Date;
};

/**
 * `GET email/pending`: the caller's change still waiting for its code, read
 * without consuming it. Never the code or its hash.
 */
export type PendingEmailChange = {
  address: string;
  expiresAt: Date;
  attemptsLeft: number;
};

export type TotpSetup = {
  setupHandle: string;
  secret: string;
  otpauthUri: string;
  expiresAt: Date;
  policy: {
    type: "totp";
    algorithm: "SHA1" | "SHA256" | "SHA512";
    digits: 6 | 8;
    period: number;
  };
};

/** Bearer material for endpoints that need only the session's user token. */
export type BearerAuthorization = {
  accessToken: string;
};

/** Bearer material for sudo-protected endpoints; the sudo token travels in `X-Sky-Sudo`. */
export type SudoAuthorization = BearerAuthorization & {
  sudoToken: string;
};

/**
 * `POST sudo/authentication` body: the ID token of a fresh Keycloak login
 * (`prompt=login&max_age=0`), the proof of a person who has no password,
 * verification app or passkey. The BFF holds it only for this call; it is
 * never logged, stored or shown to the browser.
 */
export type SudoAuthenticationInput = { idToken: string };

export type PatchNameInput = { firstName: string; lastName: string };
export type ChangeUsernameInput = { username: string };
export type SudoPasswordInput = { password: string };
export type SudoTotpInput = { code: string };
export type ChangePasswordInput = { newPassword: string; logoutOtherSessions: boolean };
export type TotpConfirmInput = { setupHandle: string; code: string; label: string };
export type RegisterPasskeyInput = { attestation: WebauthnAttestation; label: string };
/** The address to prove; the SPI trims it, lower-cases it with `Locale.ROOT` and runs Keycloak's own validator. */
export type EmailChangeInput = { address: string };
/** The six digits from the mail; spaces a copy inserts are dropped before sending. */
export type EmailConfirmInput = { code: string };
export type PrimaryEmailInput = { which: Exclude<SkyAccountPrimaryEmail, "none"> };

export interface SkyAccountClient {
  identity(auth: BearerAuthorization): Promise<SkyAccountIdentity>;
  patchName(auth: BearerAuthorization, input: PatchNameInput): Promise<SkyAccountIdentity>;
  changeUsername(auth: SudoAuthorization, input: ChangeUsernameInput): Promise<SkyAccountIdentity>;
  sudoPassword(auth: BearerAuthorization, input: SudoPasswordInput): Promise<SudoGrant>;
  sudoTotp(auth: BearerAuthorization, input: SudoTotpInput): Promise<SudoGrant>;
  sudoWebauthnOptions(auth: BearerAuthorization): Promise<WebauthnAssertionOptions>;
  sudoWebauthnVerify(auth: BearerAuthorization, assertion: WebauthnAssertion): Promise<SudoGrant>;
  sudoAuthentication(auth: BearerAuthorization, input: SudoAuthenticationInput): Promise<SudoGrant>;
  changePassword(auth: SudoAuthorization, input: ChangePasswordInput): Promise<void>;
  totpSetup(auth: SudoAuthorization): Promise<TotpSetup>;
  totpConfirm(auth: SudoAuthorization, input: TotpConfirmInput): Promise<SkyAccountCredential>;
  webauthnRegistrationOptions(auth: SudoAuthorization): Promise<WebauthnRegistrationOptions>;
  registerPasskey(auth: SudoAuthorization, input: RegisterPasskeyInput): Promise<SkyAccountCredential>;
  deleteCredential(auth: SudoAuthorization, credentialId: string): Promise<void>;
  requestEmailChange(auth: SudoAuthorization, input: EmailChangeInput): Promise<EmailChangeRequest>;
  confirmEmail(auth: BearerAuthorization, input: EmailConfirmInput): Promise<SkyAccountIdentity>;
  /** The waiting change, or `null` when nothing waits (`404 no_pending_email_change`). */
  pendingEmailChange(auth: BearerAuthorization): Promise<PendingEmailChange | null>;
  setPrimaryEmail(auth: SudoAuthorization, input: PrimaryEmailInput): Promise<SkyAccountIdentity>;
  removePersonalEmail(auth: SudoAuthorization): Promise<SkyAccountIdentity>;
}
