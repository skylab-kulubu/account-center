export type AccountProfile = {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  emailVerified: boolean;
};

export type AuthenticationSummary = {
  passwordConfigured: boolean;
  otpConfigured: boolean;
  passkeyCount: number;
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
  sessions(accessToken: string): Promise<AccountSession[]>;
  snapshot(accessToken: string): Promise<KeycloakAccountSnapshot>;
  revokeSession(accessToken: string, sessionId: string): Promise<void>;
  revokeOtherSessions(accessToken: string): Promise<void>;
}
