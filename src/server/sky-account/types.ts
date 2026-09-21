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

export type PatchNameInput = { firstName: string; lastName: string };
export type ChangeUsernameInput = { username: string };
export type SudoPasswordInput = { password: string };
export type SudoTotpInput = { code: string };
export type ChangePasswordInput = { newPassword: string; logoutOtherSessions: boolean };
export type TotpConfirmInput = { setupHandle: string; code: string; label: string };

export interface SkyAccountClient {
  identity(auth: BearerAuthorization): Promise<SkyAccountIdentity>;
  patchName(auth: BearerAuthorization, input: PatchNameInput): Promise<SkyAccountIdentity>;
  changeUsername(auth: SudoAuthorization, input: ChangeUsernameInput): Promise<SkyAccountIdentity>;
  sudoPassword(auth: BearerAuthorization, input: SudoPasswordInput): Promise<SudoGrant>;
  sudoTotp(auth: BearerAuthorization, input: SudoTotpInput): Promise<SudoGrant>;
  changePassword(auth: SudoAuthorization, input: ChangePasswordInput): Promise<void>;
  totpSetup(auth: SudoAuthorization): Promise<TotpSetup>;
  totpConfirm(auth: SudoAuthorization, input: TotpConfirmInput): Promise<SkyAccountCredential>;
  deleteCredential(auth: SudoAuthorization, credentialId: string): Promise<void>;
}
