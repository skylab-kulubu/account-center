import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_PICTURE_ORIGIN, parseProfilePictureOrigin } from "@/config/club-profile";

describe("PROFILE_PICTURE_ORIGIN", () => {
  it("falls back to the platform media CDN when unset or blank", () => {
    expect(parseProfilePictureOrigin(undefined)).toBe(DEFAULT_PROFILE_PICTURE_ORIGIN);
    expect(parseProfilePictureOrigin("")).toBe(DEFAULT_PROFILE_PICTURE_ORIGIN);
    expect(parseProfilePictureOrigin("   ")).toBe(DEFAULT_PROFILE_PICTURE_ORIGIN);
  });

  it("accepts only a canonical credential-free HTTPS origin", () => {
    expect(parseProfilePictureOrigin("https://media.yildizskylab.com")).toBe("https://media.yildizskylab.com");
    expect(parseProfilePictureOrigin(" https://media.yildizskylab.com:8443 ")).toBe("https://media.yildizskylab.com:8443");
    for (const invalid of [
      "http://cdn.yildizskylab.com",
      "https://cdn.yildizskylab.com/",
      "https://cdn.yildizskylab.com/media",
      "https://cdn.yildizskylab.com/?v=1",
      "https://cdn.yildizskylab.com/#media",
      "https://user:secret@cdn.yildizskylab.com",
      "https://CDN.yildizskylab.com",
      "cdn.yildizskylab.com",
      "<cdn-origin>",
    ]) {
      expect(() => parseProfilePictureOrigin(invalid), invalid).toThrow(/PROFILE_PICTURE_ORIGIN/);
    }
  });
});
