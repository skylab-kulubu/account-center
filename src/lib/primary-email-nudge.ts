import type { PrimaryEmailChoice } from "@/lib/email-fields";

/**
 * K4c: the nudge shown to a person whose Primary e-mail is the School e-mail.
 * "Şifremi unuttum" mails only the Primary e-mail (K4b), and a graduate's
 * school mailbox may close, so the person is asked to make a proven Personal
 * e-mail primary (`make-personal-primary`) or, without one, to add one
 * (`add-personal`). A Personal e-mail that is not proven cannot become
 * primary; the e-mail page already says so and how to prove it, so no nudge.
 * Each nudge can be dismissed for good, separately: a person who dismissed
 * "add" and later adds an address is still asked once to make it primary.
 */
export const PRIMARY_EMAIL_NUDGES = ["make-personal-primary", "add-personal"] as const;

export type PrimaryEmailNudge = (typeof PRIMARY_EMAIL_NUDGES)[number];

export function isPrimaryEmailNudge(value: unknown): value is PrimaryEmailNudge {
  return (PRIMARY_EMAIL_NUDGES as readonly unknown[]).includes(value);
}

export type PrimaryEmailNudgeInput = {
  primary: PrimaryEmailChoice | "none";
  personalEmail: string | null;
  personalEmailVerified: boolean;
};

export function primaryEmailNudgeFor(
  view: PrimaryEmailNudgeInput,
  dismissed: ReadonlySet<PrimaryEmailNudge>,
): PrimaryEmailNudge | null {
  if (view.primary !== "school") return null;
  const nudge: PrimaryEmailNudge | null = view.personalEmail === null
    ? "add-personal"
    : view.personalEmailVerified ? "make-personal-primary" : null;
  return nudge !== null && !dismissed.has(nudge) ? nudge : null;
}

/** Where a nudge outside the e-mail page leads: the e-mail page, opened on the flow the nudge names. */
export function primaryEmailNudgeIntentPath(nudge: PrimaryEmailNudge) {
  return `/email?intent=${nudge}`;
}
