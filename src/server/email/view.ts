import "server-only";

import type { SkyAccountIdentity, SkyAccountPrimaryEmail } from "@/server/sky-account/types";

/**
 * What the e-mail page shows, reduced from sky-account `GET identity`: the
 * Primary e-mail as Keycloak holds it (`email`) and which of the two
 * addresses it is, the School e-mail with the Verified YTÜ state that proves
 * it, and the Personal e-mail with whether its code was entered. No subject,
 * name, username, credential or token.
 */
export type EmailView = {
  email: string | null;
  emailVerified: boolean;
  primary: SkyAccountPrimaryEmail;
  schoolEmail: string | null;
  verifiedYtu: boolean;
  personalEmail: string | null;
  personalEmailVerified: boolean;
};

/** Public JSON of `GET /api/account/email`: the view plus the session CSRF proof. */
export type EmailPayload = EmailView & { csrfToken: string };

/**
 * Public JSON of `GET /api/account/email/pending`: the person's own change
 * still waiting for its code, or `null`. Never the code.
 */
export type PendingEmailPayload = {
  pending: { address: string; expiresAt: string; attemptsLeft: number } | null;
};

export function emailView(identity: SkyAccountIdentity): EmailView {
  return {
    email: identity.email,
    emailVerified: identity.emailVerified,
    primary: identity.primary,
    schoolEmail: identity.schoolEmail,
    verifiedYtu: identity.verifiedYtu,
    personalEmail: identity.personalEmail,
    personalEmailVerified: identity.personalEmailVerified,
  };
}
