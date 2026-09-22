import "server-only";

import type { SkyAccountIdentity } from "@/server/sky-account/types";

/**
 * What the identity page shows, reduced from sky-account `GET identity`: the
 * name and whether the Verified YTÜ lock applies, the username and the next
 * moment it may change, the YTÜ link state with the School e-mail, and the
 * Primary e-mail. No subject, credential, personal e-mail or token.
 */
export type IdentityView = {
  firstName: string | null;
  lastName: string | null;
  /** `true` for a Verified YTÜ account: the name comes from the YTÜ record and the SPI refuses changes. */
  nameLocked: boolean;
  username: string;
  /** ISO instant of the next allowed username change while the 14-day cooldown runs; `null` when free. */
  usernameChangeAvailableAt: string | null;
  verifiedYtu: boolean;
  schoolEmail: string | null;
  email: string | null;
  emailVerified: boolean;
};

/** Public JSON of `GET /api/account/identity`: the view plus the session CSRF proof. */
export type IdentityPayload = IdentityView & { csrfToken: string };

export function identityView(identity: SkyAccountIdentity, now: Date = new Date()): IdentityView {
  const availableAt = identity.usernameChangeAvailableAt === null
    ? null
    : new Date(identity.usernameChangeAvailableAt);
  return {
    firstName: identity.firstName,
    lastName: identity.lastName,
    nameLocked: identity.nameLocked,
    username: identity.username,
    // A cooldown that already ended (clock skew, a stale read) must not disable the form.
    usernameChangeAvailableAt: availableAt !== null && availableAt.getTime() > now.getTime()
      ? availableAt.toISOString()
      : null,
    verifiedYtu: identity.verifiedYtu,
    schoolEmail: identity.schoolEmail,
    email: identity.email,
    emailVerified: identity.emailVerified,
  };
}
