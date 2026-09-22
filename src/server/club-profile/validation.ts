import "server-only";

import {
  CLUB_PROFILE_EDITABLE_FIELDS,
  CLUB_PROFILE_LINKEDIN_MAX_LENGTH,
  CLUB_PROFILE_PICTURE_MAX_BYTES,
  CLUB_PROFILE_TEXT_MAX_LENGTH,
  isLinkedinProfileUrl,
} from "@/config/club-profile";
import type { ClubProfileEditableField, ClubProfilePictureType } from "@/config/club-profile";
import type { CoreProfile, CoreProfilePatch } from "@/server/core/profile-client";

/**
 * Browser-facing validation for the club-profile writes. Everything here runs
 * before the core client is touched, so a rejected request never costs a core
 * call and never carries names, phone or skyNumber (those are not editable
 * from this page).
 */

const PRINTABLE_TEXT = /^[^\p{Cc}]*$/u;

export type ClubProfileInput = Partial<Record<ClubProfileEditableField, string>>;

export type ClubProfileValidationReason =
  | "invalid_body"
  | "unknown_field"
  | "not_text"
  | "too_long"
  | "control_characters"
  | "linkedin_url";

export class ClubProfileValidationError extends Error {
  constructor(
    readonly field: ClubProfileEditableField | "body",
    readonly reason: ClubProfileValidationReason,
  ) {
    super(`Club profile input is invalid: ${field} (${reason}).`);
    this.name = "ClubProfileValidationError";
  }
}

export type ClubProfilePictureReason = "empty" | "too_large" | "unsupported_type";

export class ClubProfilePictureError extends Error {
  constructor(readonly reason: ClubProfilePictureReason) {
    super(`Club profile picture is invalid: ${reason}.`);
    this.name = "ClubProfilePictureError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEditableField(key: string): key is ClubProfileEditableField {
  return (CLUB_PROFILE_EDITABLE_FIELDS as readonly string[]).includes(key);
}

function parseText(field: ClubProfileEditableField, value: unknown) {
  if (typeof value !== "string") throw new ClubProfileValidationError(field, "not_text");
  if (!PRINTABLE_TEXT.test(value)) throw new ClubProfileValidationError(field, "control_characters");
  const trimmed = value.trim();
  if (field === "linkedin") {
    if (trimmed.length > CLUB_PROFILE_LINKEDIN_MAX_LENGTH) throw new ClubProfileValidationError(field, "too_long");
    if (trimmed.length > 0 && !isLinkedinProfileUrl(trimmed)) throw new ClubProfileValidationError(field, "linkedin_url");
    return trimmed;
  }
  if (trimmed.length > CLUB_PROFILE_TEXT_MAX_LENGTH) throw new ClubProfileValidationError(field, "too_long");
  return trimmed;
}

/**
 * Parses a browser PATCH body into trimmed editable fields. Unknown members
 * (names, phone, skyNumber, picture, prototype keys) reject the whole body
 * rather than being dropped, so a stale or tampered client fails loudly.
 */
export function parseClubProfileInput(body: unknown): ClubProfileInput {
  if (!isRecord(body)) throw new ClubProfileValidationError("body", "invalid_body");
  const input: ClubProfileInput = {};
  for (const [key, value] of Object.entries(body)) {
    if (!isEditableField(key)) throw new ClubProfileValidationError("body", "unknown_field");
    input[key] = parseText(key, value);
  }
  return input;
}

/** Only the members whose value differs from what core currently holds; an absent core value counts as empty. */
export function diffClubProfilePatch(
  current: Pick<CoreProfile, ClubProfileEditableField>,
  input: ClubProfileInput,
): CoreProfilePatch {
  const patch: CoreProfilePatch = {};
  for (const field of CLUB_PROFILE_EDITABLE_FIELDS) {
    const next = input[field];
    if (next === undefined) continue;
    if (next !== (current[field] ?? "")) patch[field] = next;
  }
  return patch;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0) {
  if (bytes.byteLength < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] as const;

/** The supported image type according to the file's magic bytes, ignoring any declared media type. */
export function sniffPictureContentType(bytes: Uint8Array): ClubProfilePictureType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, JPEG_SIGNATURE)) return "image/jpeg";
  if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_SIGNATURE, 8)) return "image/webp";
  return null;
}

export { isLinkedinProfileUrl };

export function validateClubProfilePicture(bytes: Uint8Array): { contentType: ClubProfilePictureType } {
  if (bytes.byteLength === 0) throw new ClubProfilePictureError("empty");
  if (bytes.byteLength > CLUB_PROFILE_PICTURE_MAX_BYTES) throw new ClubProfilePictureError("too_large");
  const contentType = sniffPictureContentType(bytes);
  if (!contentType) throw new ClubProfilePictureError("unsupported_type");
  return { contentType };
}
