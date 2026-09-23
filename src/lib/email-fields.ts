import type { FieldCheck } from "@/lib/identity-fields";

/**
 * E-mail rules shared by the e-mail page, the BFF routes and the sky-account
 * client. They mirror the SPI (`docs/sky-account-api.md`, `email/*`) so the
 * browser and the BFF refuse early what the SPI would refuse anyway; the SPI
 * stays the authority. Addresses: trimmed and lower-cased like the SPI stores
 * them, at most 254 characters (RFC 5321 path), one `@` and no spaces — only
 * obvious non-addresses stop here, Keycloak's own validator decides the rest.
 * Codes: the spaces a copy from the mail inserts are dropped, then exactly
 * six digits.
 */

export const MAX_EMAIL_ADDRESS_LENGTH = 254;
export const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+$/;
export const EMAIL_CODE_PATTERN = /^\d{6}$/;
/** How long the SPI keeps a pending change; no countdown ever shows more. */
export const EMAIL_CODE_LIFETIME_SECONDS = 10 * 60;
/** The SPI allows five wrong codes per change; a count far above that is drift, not a count. */
export const MAX_EMAIL_CODE_ATTEMPTS = 100;

export type PrimaryEmailChoice = "school" | "personal";

export const emailAddressMessage = "Geçerli bir e-posta adresi gir.";
export const emailCodeMessage = "Doğrulama kodu 6 rakamdan oluşur.";

/**
 * A change waiting for its code, as the BFF answers it and the page shows
 * it; never the code. `expiresAt` is the SPI's deadline (for display);
 * `secondsLeft` is computed on the server from it when the answer is built,
 * and the page counts down from that with a monotonic clock, so a browser
 * whose clock is off neither closes the code early nor keeps it open late.
 */
export type PendingEmailChange = {
  address: string;
  expiresAt: string;
  attemptsLeft: number;
  secondsLeft: number;
};

/** Trimmed and lower-cased the way the SPI stores it (`Locale.ROOT`), so addresses compare as Keycloak holds them. */
export function normalizeEmailAddress(value: string) {
  return value.trim().toLowerCase();
}

/** The normalised address or `invalid`. */
export function checkEmailAddress(value: unknown): FieldCheck<"invalid"> {
  const address = typeof value === "string" ? normalizeEmailAddress(value) : "";
  if (address.length > MAX_EMAIL_ADDRESS_LENGTH || !EMAIL_ADDRESS_PATTERN.test(address)) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, value: address };
}

/** The six digits without the spaces a copy inserts, or `invalid`. */
export function checkEmailCode(value: unknown): FieldCheck<"invalid"> {
  const code = typeof value === "string" ? value.replace(/\s+/g, "") : "";
  return EMAIL_CODE_PATTERN.test(code) ? { ok: true, value: code } : { ok: false, reason: "invalid" };
}

export function isPrimaryEmailChoice(value: unknown): value is PrimaryEmailChoice {
  return value === "school" || value === "personal";
}

/** Seconds left on a code as the BFF reports them: whole, never more than the code's life. */
export function isEmailCodeSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= EMAIL_CODE_LIFETIME_SECONDS;
}

export function isEmailCodeAttempts(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_EMAIL_CODE_ATTEMPTS;
}

/**
 * Whole seconds from `now` (epoch milliseconds on the caller's clock) to
 * `expiresAt`, bounded to the code's ten-minute life; `0` once it passed or
 * for an instant that does not parse. Meant for the server, whose clock is
 * the one the answer is built with.
 */
export function secondsLeftUntil(expiresAt: string, now: number): number {
  const remaining = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  return Math.min(EMAIL_CODE_LIFETIME_SECONDS, Math.ceil(remaining / 1_000));
}
