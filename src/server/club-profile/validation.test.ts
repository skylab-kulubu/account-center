// @vitest-environment node

import { describe, expect, it } from "vitest";
import meFixture from "../../../tests/fixtures/core-users-me.json";
import {
  CLUB_PROFILE_LINKEDIN_MAX_LENGTH,
  CLUB_PROFILE_PICTURE_MAX_BYTES,
  CLUB_PROFILE_TEXT_MAX_LENGTH,
} from "@/config/club-profile";
import {
  ClubProfilePictureError,
  ClubProfileValidationError,
  diffClubProfilePatch,
  isLinkedinProfileUrl,
  normalizeLinkedinProfileUrl,
  parseClubProfileInput,
  sniffPictureContentType,
  validateClubProfilePicture,
} from "@/server/club-profile/validation";
import type { CoreProfile } from "@/server/core/profile-client";

const current: CoreProfile = { ...meFixture, studentCardLinked: true };

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const webp = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

function validationFailure(body: unknown) {
  try {
    parseClubProfileInput(body);
  } catch (error) {
    if (error instanceof ClubProfileValidationError) return { field: error.field, reason: error.reason };
    throw error;
  }
  throw new Error("expected the input to be rejected");
}

describe("club-profile input validation", () => {
  it("accepts only the four editable club fields, trimmed", () => {
    expect(parseClubProfileInput({
      university: "  Yıldız Teknik Üniversitesi ",
      faculty: "Makine Fakültesi",
      department: "",
      linkedin: " https://www.linkedin.com/in/ada-lovelace ",
    })).toEqual({
      university: "Yıldız Teknik Üniversitesi",
      faculty: "Makine Fakültesi",
      department: "",
      linkedin: "https://www.linkedin.com/in/ada-lovelace",
    });
    expect(parseClubProfileInput({})).toEqual({});
    expect(parseClubProfileInput({ faculty: "Fen-Edebiyat Fakültesi" })).toEqual({ faculty: "Fen-Edebiyat Fakültesi" });
  });

  it("rejects bodies that are not a plain object of strings", () => {
    expect(validationFailure(null)).toEqual({ field: "body", reason: "invalid_body" });
    expect(validationFailure([])).toEqual({ field: "body", reason: "invalid_body" });
    expect(validationFailure("faculty")).toEqual({ field: "body", reason: "invalid_body" });
    expect(validationFailure({ faculty: 42 })).toEqual({ field: "faculty", reason: "not_text" });
    expect(validationFailure({ faculty: null })).toEqual({ field: "faculty", reason: "not_text" });
    expect(validationFailure({ university: ["x"] })).toEqual({ field: "university", reason: "not_text" });
  });

  it("refuses names, phone, skyNumber and any other field even when a club field is present", () => {
    expect(validationFailure({ faculty: "x", firstName: "Ada" })).toEqual({ field: "body", reason: "unknown_field" });
    expect(validationFailure({ phone: "+905550000000" })).toEqual({ field: "body", reason: "unknown_field" });
    expect(validationFailure({ skyNumber: "SKY-1" })).toEqual({ field: "body", reason: "unknown_field" });
    expect(validationFailure({ profilePictureUrl: "https://x.invalid/a.png" })).toEqual({ field: "body", reason: "unknown_field" });
    expect(validationFailure(JSON.parse('{"__proto__": {"faculty": "x"}}'))).toEqual({ field: "body", reason: "unknown_field" });
    expect(validationFailure(JSON.parse('{"constructor": "x", "faculty": "y"}'))).toEqual({ field: "body", reason: "unknown_field" });
  });

  it("caps the text fields at the shared trimmed length", () => {
    const longest = "x".repeat(CLUB_PROFILE_TEXT_MAX_LENGTH);
    expect(parseClubProfileInput({ department: ` ${longest} ` })).toEqual({ department: longest });
    expect(validationFailure({ department: `${longest}x` })).toEqual({ field: "department", reason: "too_long" });
  });

  it("forbids control, format, separator and non-breaking space characters in every field", () => {
    const cases: Array<[string, string]> = [
      ["university", "Yıldız\u0000"],
      ["faculty", "Makine\nFakültesi"],
      ["department", "Bilgisayar\u00a0Mühendisliği"],
      ["department", "Bilgisayar\u2028Mühendisliği"],
      ["university", "Yıldız\u200bTeknik"],
      ["university", "\ufeffYıldız Teknik Üniversitesi"],
      ["faculty", "Ma\u00adkine"],
      ["faculty", "Makine\u202fFakültesi"],
      ["linkedin", "https://www.linkedin.com/in/ada\u200e"],
    ];
    for (const [field, value] of cases) {
      expect(validationFailure({ [field]: value }), JSON.stringify(value)).toEqual({ field, reason: "forbidden_characters" });
    }
    expect(parseClubProfileInput({ faculty: "Elektrik-Elektronik Fakültesi", department: "Kontrol ve Otomasyon Mühendisliği" }))
      .toEqual({ faculty: "Elektrik-Elektronik Fakültesi", department: "Kontrol ve Otomasyon Mühendisliği" });
  });

  it("normalizes an https LinkedIn URL on linkedin.com or www.linkedin.com to its canonical form", () => {
    const normalized: Array<[string, string]> = [
      ["https://www.linkedin.com/in/ada-lovelace", "https://www.linkedin.com/in/ada-lovelace"],
      ["https://linkedin.com/in/ada-lovelace/", "https://linkedin.com/in/ada-lovelace/"],
      ["https://WWW.LinkedIn.com/in/Ada", "https://www.linkedin.com/in/Ada"],
      ["HTTPS://linkedin.com", "https://linkedin.com/"],
      ["https://www.linkedin.com/in/ada?trk=public", "https://www.linkedin.com/in/ada?trk=public"],
      ["https://www.linkedin.com/in/ada-ünal", "https://www.linkedin.com/in/ada-%C3%BCnal"],
    ];
    for (const [input, expected] of normalized) {
      expect(normalizeLinkedinProfileUrl(input), input).toBe(expected);
      expect(isLinkedinProfileUrl(input), input).toBe(true);
    }
    for (const invalid of [
      "http://www.linkedin.com/in/ada",
      "https://tr.linkedin.com/in/ada",
      "https://www.linkedin.com.evil.invalid/in/ada",
      "https://evil.invalid/https://www.linkedin.com/in/ada",
      "https://user:secret@www.linkedin.com/in/ada",
      "https://user@www.linkedin.com/in/ada",
      "https://www.linkedin.com:8443/in/ada",
      "https://www.linkedin.com:443/in/ada",
      "https://www.linkedin.com\\evil.invalid/in/ada",
      "https://www.linkedin.com\\@evil.invalid",
      "https://evil.invalid\\@www.linkedin.com/in/ada",
      "https://www.linkedin.com/in/ada\\lovelace",
      "https:/www.linkedin.com/in/ada",
      "www.linkedin.com/in/ada",
      "javascript:alert(1)",
      "https://www.linkedin.com/in/ada lovelace",
      "https://www.linkedin.com/in/ada\u00a0lovelace",
      "https://www.linkedin.com/in/ada\u0000",
      "",
    ]) {
      expect(normalizeLinkedinProfileUrl(invalid), invalid).toBeNull();
      expect(isLinkedinProfileUrl(invalid), invalid).toBe(false);
    }
  });

  it("stores the LinkedIn link normalized, lets an empty value clear it and rejects malformed values", () => {
    expect(parseClubProfileInput({ linkedin: "  " })).toEqual({ linkedin: "" });
    expect(parseClubProfileInput({ linkedin: " https://WWW.LinkedIn.com/in/Ada-Lovelace " })).toEqual({ linkedin: "https://www.linkedin.com/in/Ada-Lovelace" });
    expect(validationFailure({ linkedin: "https://www.linkedin.com:443/in/ada" })).toEqual({ field: "linkedin", reason: "linkedin_url" });
    expect(validationFailure({ linkedin: "https://www.linkedin.com\\evil.invalid/in/ada" })).toEqual({ field: "linkedin", reason: "linkedin_url" });
    expect(validationFailure({ linkedin: "http://www.linkedin.com/in/ada" })).toEqual({ field: "linkedin", reason: "linkedin_url" });
    expect(validationFailure({ linkedin: "not a url" })).toEqual({ field: "linkedin", reason: "linkedin_url" });
    const longPath = `https://www.linkedin.com/in/${"a".repeat(CLUB_PROFILE_LINKEDIN_MAX_LENGTH)}`;
    expect(validationFailure({ linkedin: longPath })).toEqual({ field: "linkedin", reason: "too_long" });
    const longest = `https://www.linkedin.com/in/${"a".repeat(CLUB_PROFILE_LINKEDIN_MAX_LENGTH - "https://www.linkedin.com/in/".length)}`;
    expect(longest).toHaveLength(CLUB_PROFILE_LINKEDIN_MAX_LENGTH);
    expect(parseClubProfileInput({ linkedin: longest })).toEqual({ linkedin: longest });
    const expandsPastCap = `https://www.linkedin.com/in/${"ü".repeat(CLUB_PROFILE_LINKEDIN_MAX_LENGTH - "https://www.linkedin.com/in/".length)}`;
    expect(validationFailure({ linkedin: expandsPastCap })).toEqual({ field: "linkedin", reason: "too_long" });
  });
});

describe("club-profile patch diffing", () => {
  it("forwards only the fields whose trimmed value differs from the current core value", () => {
    expect(diffClubProfilePatch(current, {
      university: "Yıldız Teknik Üniversitesi",
      faculty: "Makine Fakültesi",
      department: "Bilgisayar Mühendisliği",
      linkedin: "https://www.linkedin.com/in/ada-lovelace",
    })).toEqual({ faculty: "Makine Fakültesi" });
  });

  it("treats an empty input as clearing a set value and as unchanged for an absent one", () => {
    expect(diffClubProfilePatch(current, { linkedin: "" })).toEqual({ linkedin: "" });
    expect(diffClubProfilePatch({ ...current, linkedin: null }, { linkedin: "" })).toEqual({});
    expect(diffClubProfilePatch({ ...current, faculty: null }, { faculty: "Makine Fakültesi" })).toEqual({ faculty: "Makine Fakültesi" });
  });

  it("returns an empty patch when nothing changed", () => {
    expect(diffClubProfilePatch(current, {})).toEqual({});
    expect(diffClubProfilePatch(current, { department: "Bilgisayar Mühendisliği" })).toEqual({});
  });

  it("refuses to change university, faculty or department of a YTÜ-linked person", () => {
    const linked = { ...current, ytuLinked: true };
    const refusal = (input: Parameters<typeof diffClubProfilePatch>[1]) => {
      try {
        diffClubProfilePatch(linked, input);
      } catch (error) {
        if (error instanceof ClubProfileValidationError) return { field: error.field, reason: error.reason };
        throw error;
      }
      throw new Error("expected the change to be refused");
    };
    expect(refusal({ department: "Fizik" })).toEqual({ field: "department", reason: "ytu_managed" });
    expect(refusal({ faculty: "", linkedin: "" })).toEqual({ field: "faculty", reason: "ytu_managed" });
    expect(refusal({ university: "Boğaziçi Üniversitesi" })).toEqual({ field: "university", reason: "ytu_managed" });
    // The stored values sent back are no change; LinkedIn stays editable.
    expect(diffClubProfilePatch(linked, {
      university: "Yıldız Teknik Üniversitesi",
      faculty: "Elektrik-Elektronik Fakültesi",
      department: "Bilgisayar Mühendisliği",
      linkedin: "",
    })).toEqual({ linkedin: "" });
    // Someone who is not YTÜ-linked edits all four.
    expect(diffClubProfilePatch({ ...current, ytuLinked: false }, { department: "Fizik" })).toEqual({ department: "Fizik" });
  });
});

describe("club-profile picture validation", () => {
  it("sniffs the three supported formats from their magic bytes only", () => {
    expect(sniffPictureContentType(png)).toBe("image/png");
    expect(sniffPictureContentType(jpeg)).toBe("image/jpeg");
    expect(sniffPictureContentType(webp)).toBe("image/webp");
    expect(sniffPictureContentType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull();
    expect(sniffPictureContentType(new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\"/>"))).toBeNull();
    expect(sniffPictureContentType(new TextEncoder().encode("RIFF....WAVE"))).toBeNull();
    expect(sniffPictureContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(sniffPictureContentType(new Uint8Array(0))).toBeNull();
  });

  it("accepts a supported picture up to the shared size cap and reports the sniffed type", () => {
    expect(validateClubProfilePicture(png)).toEqual({ contentType: "image/png" });
    const largest = new Uint8Array(CLUB_PROFILE_PICTURE_MAX_BYTES);
    largest.set(jpeg);
    expect(validateClubProfilePicture(largest)).toEqual({ contentType: "image/jpeg" });
  });

  it("rejects empty, oversize and unsupported pictures before anything reaches core", () => {
    const rejection = (bytes: Uint8Array) => {
      try {
        validateClubProfilePicture(bytes);
      } catch (error) {
        if (error instanceof ClubProfilePictureError) return error.reason;
        throw error;
      }
      throw new Error("expected the picture to be rejected");
    };
    expect(rejection(new Uint8Array(0))).toBe("empty");
    const oversize = new Uint8Array(CLUB_PROFILE_PICTURE_MAX_BYTES + 1);
    oversize.set(png);
    expect(rejection(oversize)).toBe("too_large");
    expect(rejection(new TextEncoder().encode("GIF89a"))).toBe("unsupported_type");
    expect(rejection(new TextEncoder().encode("%PDF-1.7"))).toBe("unsupported_type");
  });
});
