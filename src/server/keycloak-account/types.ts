export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * User Profile attribute metadata as declared by the realm User Profile
 * configuration and evaluated for the person (`readOnly`/`required` reflect
 * the user permissions, not the admin ones). Read-only information for the
 * UI; Account Center never writes profile attributes through Account REST.
 */
export type ProfileAttributeMetadata = {
  name: string;
  displayName: string | null;
  required: boolean;
  readOnly: boolean;
  validators: Record<string, Record<string, JsonValue>>;
  annotations: Record<string, JsonValue>;
};

export type ProfileAttributeName =
  | "schoolEmail"
  | "personalEmail"
  | "skyNumber"
  | "department"
  | "university";

export type ProfileAttributes = Record<ProfileAttributeName, string | null>;

export type AccountProfile = {
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  emailVerified: boolean;
  attributes: ProfileAttributes;
  attributeMetadata: ProfileAttributeMetadata[];
};

export type AuthenticationSummary = {
  passwordConfigured: boolean;
  otpConfigured: boolean;
  passkeyCount: number;
};

export type OwnedCredential = {
  id: string;
  type: string;
  label: string | null;
  createdAt: string | null;
  removeable: boolean;
};

export type CredentialInventory = {
  summary: AuthenticationSummary;
  credentials: OwnedCredential[];
};

export type SecurityCredential = {
  kind: "otp" | "passkey";
  label: string;
  createdAt: string | null;
  deletionReference: string;
};

export type AccountSecurity = AuthenticationSummary & {
  credentials: SecurityCredential[];
};

export type AccountSession = {
  id: string;
  startedAt: string;
  lastAccessAt: string;
  expiresAt: string;
  browser: string | null;
  current: boolean;
  device: {
    name: string | null;
    operatingSystem: string | null;
    operatingSystemVersion: string | null;
    mobile: boolean | null;
  } | null;
};

export type ManagedAccountSession = Omit<AccountSession, "id"> & {
  reference: string | null;
};

/** A group the person belongs to, as `GET /account/groups?briefRepresentation=false` reports it. */
export type AccountGroup = {
  id: string;
  name: string;
  path: string;
  attributes: Record<string, string[]>;
};

/** An identity provider of the realm and whether the person is linked to it. */
export type LinkedAccount = {
  connected: boolean;
  providerAlias: string;
  displayName: string | null;
  linkedUsername: string | null;
  social: boolean;
};

export type AccountOverview = {
  profile: AccountProfile;
  authentication: AuthenticationSummary;
};

export type KeycloakAccountSnapshot = AccountOverview & {
  sessions: AccountSession[];
};

export type AccountSnapshot = AccountOverview & {
  sessions: ManagedAccountSession[];
};

export interface KeycloakAccountReadAdapter {
  profile(accessToken: string): Promise<AccountProfile>;
  authentication(accessToken: string): Promise<AuthenticationSummary>;
  credentialInventory(accessToken: string): Promise<CredentialInventory>;
  sessions(accessToken: string): Promise<AccountSession[]>;
  groups(accessToken: string): Promise<AccountGroup[]>;
  linkedAccounts(accessToken: string): Promise<LinkedAccount[]>;
  linkedAccountUri(accessToken: string, providerAlias: string, redirectUri: URL): Promise<URL>;
  snapshot(accessToken: string): Promise<KeycloakAccountSnapshot>;
  revokeSession(accessToken: string, sessionId: string): Promise<void>;
  revokeOtherSessions(accessToken: string): Promise<void>;
}
