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

/** Public JSON of `GET /api/account/email/delivery`, the overview's line. */
export type EmailDeliveryPayload = { undeliverable: UndeliverableEmailKind[] };
