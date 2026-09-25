/**
 * Club-profile limits shared by the browser form and the BFF validation. The
 * browser applies them for early feedback only; the server re-validates every
 * request before anything reaches core.
 */

export const CLUB_PROFILE_EDITABLE_FIELDS = ["university", "faculty", "department", "linkedin"] as const;

export type ClubProfileEditableField = (typeof CLUB_PROFILE_EDITABLE_FIELDS)[number];

/**
 * The fields that follow the YTÜ Microsoft login for a YTÜ-linked person
 * (core's `ytuLinked`): shown read-only with "YTÜ hesabından gelir", and a
 * change is refused by the BFF and by core.
 */
export const CLUB_PROFILE_YTU_FIELDS = ["university", "faculty", "department"] as const;

export type ClubProfileYtuField = (typeof CLUB_PROFILE_YTU_FIELDS)[number];

export function isClubProfileYtuField(field: string): field is ClubProfileYtuField {
  return (CLUB_PROFILE_YTU_FIELDS as readonly string[]).includes(field);
}

/** The fields the person edits: LinkedIn only when YTÜ-linked, all four otherwise. */
export function clubProfileEditableFields(ytuLinked: boolean): readonly ClubProfileEditableField[] {
  return ytuLinked ? CLUB_PROFILE_EDITABLE_FIELDS.filter((field) => !isClubProfileYtuField(field)) : CLUB_PROFILE_EDITABLE_FIELDS;
}

/** Trimmed length cap for university, faculty and department. */
export const CLUB_PROFILE_TEXT_MAX_LENGTH = 120;

/** Trimmed length cap for the LinkedIn profile URL. */
export const CLUB_PROFILE_LINKEDIN_MAX_LENGTH = 200;

export const CLUB_PROFILE_LINKEDIN_HOSTS: ReadonlySet<string> = new Set(["linkedin.com", "www.linkedin.com"]);

export const CLUB_PROFILE_PICTURE_MAX_BYTES = 5 * 1_024 * 1_024;

export const CLUB_PROFILE_PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type ClubProfilePictureType = (typeof CLUB_PROFILE_PICTURE_TYPES)[number];

/**
 * The platform media CDN core publishes profile pictures on
 * (`profilePictureUrl` from `/v1/users/me`) when `PROFILE_PICTURE_ORIGIN`
 * is unset. Whichever origin applies is the only cross-origin image source
 * in the Content Security Policy; nothing else loads from it.
 */
export const DEFAULT_PROFILE_PICTURE_ORIGIN = "https://cdn.yildizskylab.com";

/**
 * Resolves `PROFILE_PICTURE_ORIGIN`: unset or blank falls back to the
 * platform CDN; anything else must be a canonical, credential-free HTTPS
 * origin (no path, query or fragment) exactly as the browser serializes it.
 */
export function parseProfilePictureOrigin(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_PROFILE_PICTURE_ORIGIN;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("PROFILE_PICTURE_ORIGIN must be a valid HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    trimmed !== url.origin
  ) {
    throw new Error("PROFILE_PICTURE_ORIGIN must be a canonical credential-free HTTPS origin.");
  }
  return url.origin;
}

/** Multipart field the browser posts the picture under; the BFF reads exactly this one. */
export const CLUB_PROFILE_PICTURE_FIELD = "file";

export function isClubProfilePictureType(value: string): value is ClubProfilePictureType {
  return (CLUB_PROFILE_PICTURE_TYPES as readonly string[]).includes(value);
}

/**
 * Characters no club-profile text may carry: control characters, format
 * characters (zero-width joiners, bidi marks, soft hyphens, BOM), line and
 * paragraph separators, and every space other than U+0020 (NBSP and friends).
 */
const FORBIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u;
const LINKEDIN_AUTHORITY = /^https:\/\/([^/?#]*)/i;

export function hasForbiddenCharacters(value: string) {
  return FORBIDDEN_CHARACTERS.test(value);
}

/**
 * The canonical serialization of a LinkedIn profile URL, or `null` when the
 * value is not one. The raw authority must be exactly `linkedin.com` or
 * `www.linkedin.com` (any case) before the URL parser sees it, so userinfo,
 * explicit ports (even `:443`) and backslash spellings are refused instead
 * of being normalized away; the parser then canonicalizes host case and
 * escaping (`new URL(value).href`).
 */
export function normalizeLinkedinProfileUrl(value: string): string | null {
  if (value.length === 0 || hasForbiddenCharacters(value) || /[\s\\]/u.test(value)) return null;
  const authority = LINKEDIN_AUTHORITY.exec(value)?.[1];
  if (!authority || !CLUB_PROFILE_LINKEDIN_HOSTS.has(authority.toLowerCase())) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port !== "" || !CLUB_PROFILE_LINKEDIN_HOSTS.has(url.hostname)) {
    return null;
  }
  return url.href;
}

/** Whether `value` is an acceptable LinkedIn profile URL within the shared length cap. */
export function isLinkedinProfileUrl(value: string) {
  const normalized = normalizeLinkedinProfileUrl(value);
  return normalized !== null && normalized.length <= CLUB_PROFILE_LINKEDIN_MAX_LENGTH && value.length <= CLUB_PROFILE_LINKEDIN_MAX_LENGTH;
}
