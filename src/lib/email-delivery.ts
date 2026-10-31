/**
 * Which of the person's own addresses SkyMail no longer mails (a bounce or a
 * complaint suppressed it, skymail-backend `GET /v1/me/email-delivery`). The
 * BFF matches SkyMail's addresses against the person's Primary, School and
 * Personal e-mail and hands the browser only these kinds: never SkyMail's
 * addresses or dates. Only the panel lifts a suppression (ADR 0073 karar 7),
 * so the page offers no action of its own.
 */
export const UNDELIVERABLE_EMAIL_KINDS = ["primary", "school", "personal"] as const;

export type UndeliverableEmailKind = (typeof UNDELIVERABLE_EMAIL_KINDS)[number];

export const emailDeliveryCopy = {
  address: "Bu adrese posta ulaşmıyor.",
  overview: "Bir e-posta adresine posta ulaşmıyor.",
} as const;

/** The `undeliverable` member of the BFF's answers; anything else (an older BFF, drift) is no warning. */
export function parseUndeliverable(value: unknown): UndeliverableEmailKind[] {
  if (!Array.isArray(value)) return [];
  return UNDELIVERABLE_EMAIL_KINDS.filter((kind) => value.includes(kind));
}

/** The addresses the e-mail page shows a row for. */
export type DeliveryRowsInput = {
  email: string | null;
  primary: "school" | "personal" | "none";
  schoolEmail: string | null;
  personalEmail: string | null;
};

/**
 * The rows of `/email` that carry "Bu adrese posta ulaşmıyor.": an address
 * named by its own kind, and the Primary e-mail's row (school, personal, or
 * a legacy primary: no personal address yet) when the primary is named. The
 * BFF keeps only the kinds that land on a row (`shownUndeliverable`), so the
 * overview never warns about an address the e-mail page does not mark.
 */
export function undeliverableRows(view: DeliveryRowsInput, kinds: readonly UndeliverableEmailKind[]) {
  const named = new Set(kinds);
  const primary = named.has("primary");
  return {
    school: view.schoolEmail !== null && (named.has("school") || (primary && view.primary === "school")),
    personal: view.personalEmail !== null && (named.has("personal") || (primary && view.primary === "personal")),
    legacy: primary && view.primary === "none" && view.email !== null && view.personalEmail === null,
  };
}

/** The kinds that put the warning on at least one row of `/email`. */
export function shownUndeliverable(view: DeliveryRowsInput, kinds: readonly UndeliverableEmailKind[]) {
  return kinds.filter((kind) => Object.values(undeliverableRows(view, [kind])).some(Boolean));
}

/** Public JSON of `GET /api/account/email/delivery`, the overview's line. */
export type EmailDeliveryPayload = { undeliverable: UndeliverableEmailKind[] };
