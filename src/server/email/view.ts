import "server-only";

import { secondsLeftUntil } from "@/lib/email-fields";
import type { PendingEmailChange } from "@/lib/email-fields";
import type {
  EmailChangeRequest,
  SkyAccountIdentity,
  SkyAccountPendingEmailChange,
  SkyAccountPrimaryEmail,
} from "@/server/sky-account/types";

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
export type PendingEmailPayload = { pending: PendingEmailChange | null };

/** `202` answer of `POST /api/account/email/change-request`: the deadline and the seconds left on the server's clock. */
export type EmailChangePayload = Pick<PendingEmailChange, "expiresAt" | "secondsLeft">;

/** Adds the seconds left, counted on this server's clock (`now`, epoch milliseconds), to the SPI's deadline. */
export function emailChangeView(change: EmailChangeRequest, now: number): EmailChangePayload {
  return { expiresAt: change.expiresAt, secondsLeft: secondsLeftUntil(change.expiresAt, now) };
}

export function pendingEmailView(pending: SkyAccountPendingEmailChange, now: number): PendingEmailChange {
  return { ...pending, ...emailChangeView(pending, now) };
}

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
