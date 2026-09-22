// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  checkEmailAddress,
  checkEmailCode,
  EMAIL_CODE_LIFETIME_SECONDS,
  emailAddressMessage,
  emailCodeMessage,
  isEmailCodeAttempts,
  isPrimaryEmailChoice,
  MAX_EMAIL_ADDRESS_LENGTH,
  MAX_EMAIL_CODE_ATTEMPTS,
  secondsLeftUntil,
} from "@/lib/email-fields";

describe("e-mail address rule", () => {
  it("trims and lower-cases the way the SPI stores the address", () => {
    expect(checkEmailAddress("  Ada.Lovelace@Example.COM ")).toEqual({ ok: true, value: "ada.lovelace@example.com" });
    const longest = `${"a".repeat(MAX_EMAIL_ADDRESS_LENGTH - "@example.com".length)}@example.com`;
    expect(checkEmailAddress(longest)).toEqual({ ok: true, value: longest });
  });

  it("refuses what is obviously not an address, leaving the rest to Keycloak's validator", () => {
    for (const value of ["", "   ", "ada.example.com", "ada lovelace@example.com", "ada@", "@example.com", `a${"a".repeat(254)}@x.y`, 42, null, undefined]) {
      expect(checkEmailAddress(value)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(emailAddressMessage).toBe("Geçerli bir e-posta adresi gir.");
  });
});

describe("e-mail code rule", () => {
  it("drops the spaces a copy from the mail inserts and requires exactly six digits", () => {
    expect(checkEmailCode("123 456")).toEqual({ ok: true, value: "123456" });
    expect(checkEmailCode(" 12 34 56\t")).toEqual({ ok: true, value: "123456" });
    for (const value of ["12345", "1234567", "12a456", "", "١٢٣٤٥٦", 123456, null]) {
      expect(checkEmailCode(value)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(emailCodeMessage).toBe("Doğrulama kodu 6 rakamdan oluşur.");
  });

  it("bounds the tries a wrong code reports", () => {
    expect([0, 1, 5, MAX_EMAIL_CODE_ATTEMPTS].every(isEmailCodeAttempts)).toBe(true);
    expect([-1, 1.5, "4", MAX_EMAIL_CODE_ATTEMPTS + 1, Number.NaN, null].some(isEmailCodeAttempts)).toBe(false);
  });
});

describe("primary choice", () => {
  it("is the school or the personal address and nothing else", () => {
    expect(isPrimaryEmailChoice("school")).toBe(true);
    expect(isPrimaryEmailChoice("personal")).toBe(true);
    for (const value of ["none", "School", "", 1, null]) expect(isPrimaryEmailChoice(value)).toBe(false);
  });
});

describe("seconds left on a code", () => {
  const now = Date.parse("2026-09-23T00:00:00Z");

  it("counts whole seconds to the deadline on the caller's clock", () => {
    expect(secondsLeftUntil("2026-09-23T00:09:59.200Z", now)).toBe(600);
    expect(secondsLeftUntil("2026-09-23T00:04:00Z", now)).toBe(240);
    expect(secondsLeftUntil("2026-09-23T00:00:00Z", now)).toBe(0);
    expect(secondsLeftUntil("2026-09-22T23:59:00Z", now)).toBe(0);
  });

  it("never reports more than the ten minutes a code lives, nor anything for a malformed instant", () => {
    expect(EMAIL_CODE_LIFETIME_SECONDS).toBe(600);
    expect(secondsLeftUntil("2026-09-23T01:00:00Z", now)).toBe(EMAIL_CODE_LIFETIME_SECONDS);
    expect(secondsLeftUntil("soon", now)).toBe(0);
  });
});
