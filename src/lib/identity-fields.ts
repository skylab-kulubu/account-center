/**
 * Name and username rules shared by the identity page and the BFF routes.
 * They mirror the sky-account SPI (`docs/sky-account-api.md`, `identity/name`
 * and `identity/username`) so the browser can refuse early what the SPI would
 * refuse anyway; the SPI stays the authority and its answer is what the page
 * shows. Names: the SPI drops format characters and folds every space kind
 * into one; here such characters are rejected outright (like the club
 * profile does), runs of U+0020 are folded, the result is trimmed and must be
 * 1–64 characters without Keycloak's `person-name-prohibited-characters`.
 * Usernames: lower-cased, then `^[a-z0-9._]{3,30}$`.
 */

export const MAX_PERSON_NAME_LENGTH = 64;
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;
/** The SPI pattern, applied after lower-casing. */
export const USERNAME_PATTERN = /^[a-z0-9._]{3,30}$/;

export type PersonNameField = "firstName" | "lastName";
export type PersonNameReason = "empty" | "too_long" | "invisible_characters" | "prohibited_characters";
export type UsernameReason = "empty" | "too_short" | "too_long" | "invalid_characters";

export type FieldCheck<Reason extends string> =
  | { ok: true; value: string }
  | { ok: false; reason: Reason };

/**
 * Control characters, format characters (zero-width joiners, bidi marks,
 * soft hyphens, BOM), line and paragraph separators, and every space other
 * than U+0020 (NBSP and friends).
 */
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u;
/** Keycloak's default `person-name-prohibited-characters` set (control characters are caught above). */
const PROHIBITED_NAME_CHARACTERS = /[<>&"$%!#?§;*~/\\|^=[\]{}()`]/;
const USERNAME_CHARACTERS = /^[a-z0-9._]*$/;

export const personNameLabels: Readonly<Record<PersonNameField, string>> = {
  firstName: "Ad",
  lastName: "Soyad",
};

export function isPersonNameField(value: unknown): value is PersonNameField {
  return value === "firstName" || value === "lastName";
}

/** The normalised name (spaces folded, trimmed) or the first rule it breaks. */
export function checkPersonName(value: unknown): FieldCheck<PersonNameReason> {
  if (typeof value !== "string") return { ok: false, reason: "empty" };
  if (INVISIBLE_CHARACTERS.test(value)) return { ok: false, reason: "invisible_characters" };
  if (PROHIBITED_NAME_CHARACTERS.test(value)) return { ok: false, reason: "prohibited_characters" };
  const normalized = value.replace(/ {2,}/g, " ").trim();
  if (normalized.length === 0) return { ok: false, reason: "empty" };
  if (normalized.length > MAX_PERSON_NAME_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, value: normalized };
}

/** The lower-cased, trimmed username or the first rule it breaks. */
export function checkUsername(value: unknown): FieldCheck<UsernameReason> {
  if (typeof value !== "string") return { ok: false, reason: "empty" };
  const username = value.trim().toLowerCase();
  if (username.length === 0) return { ok: false, reason: "empty" };
  if (!USERNAME_CHARACTERS.test(username)) return { ok: false, reason: "invalid_characters" };
  if (username.length < USERNAME_MIN_LENGTH) return { ok: false, reason: "too_short" };
  if (username.length > USERNAME_MAX_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, value: username };
}

export function personNameMessage(field: PersonNameField, reason: PersonNameReason): string {
  const label = personNameLabels[field];
  switch (reason) {
    case "empty":
      return `${label} boş olamaz.`;
    case "too_long":
      return `${label} en fazla ${MAX_PERSON_NAME_LENGTH} karakter olabilir.`;
    case "invisible_characters":
      return `${label} görünmez, biçimlendirme ya da kontrol karakteri içeremez.`;
    case "prohibited_characters":
      return `${label} şu karakterleri içeremez: < > & " $ % ! # ? § ; * ~ / \\ | ^ = [ ] { } ( ) \``;
  }
}

export function usernameMessage(reason: UsernameReason): string {
  switch (reason) {
    case "empty":
      return "Kullanıcı adı boş olamaz.";
    case "too_short":
      return `Kullanıcı adı en az ${USERNAME_MIN_LENGTH} karakter olmalı.`;
    case "too_long":
      return `Kullanıcı adı en fazla ${USERNAME_MAX_LENGTH} karakter olabilir.`;
    case "invalid_characters":
      return "Kullanıcı adı yalnız küçük harf (a-z), rakam, nokta ve alt çizgi içerebilir.";
  }
}
