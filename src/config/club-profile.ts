/**
 * Club-profile limits shared by the browser form and the BFF validation. The
 * browser applies them for early feedback only; the server re-validates every
 * request before anything reaches core.
 */

export const CLUB_PROFILE_EDITABLE_FIELDS = ["university", "faculty", "department", "linkedin"] as const;

export type ClubProfileEditableField = (typeof CLUB_PROFILE_EDITABLE_FIELDS)[number];

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
 * (`profilePictureUrl` from `/v1/users/me`). It is the only cross-origin
 * image source in the Content Security Policy; nothing else loads from it.
 */
export const PROFILE_PICTURE_ORIGIN = "https://cdn.yildizskylab.com";

/** Multipart field the browser posts the picture under; the BFF reads exactly this one. */
export const CLUB_PROFILE_PICTURE_FIELD = "file";

export function isClubProfilePictureType(value: string): value is ClubProfilePictureType {
  return (CLUB_PROFILE_PICTURE_TYPES as readonly string[]).includes(value);
}

const PRINTABLE_TEXT = /^[^\p{Cc}]*$/u;
const WHITESPACE = /\s/u;

/**
 * `https://` plus exactly `linkedin.com` or `www.linkedin.com`, no credentials,
 * no explicit port, no whitespace or control characters, within the length cap.
 */
export function isLinkedinProfileUrl(value: string) {
  if (value.length === 0 || value.length > CLUB_PROFILE_LINKEDIN_MAX_LENGTH) return false;
  if (!PRINTABLE_TEXT.test(value) || WHITESPACE.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    url.port === "" &&
    CLUB_PROFILE_LINKEDIN_HOSTS.has(url.hostname)
  );
}
