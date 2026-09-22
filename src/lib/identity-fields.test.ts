// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  checkPersonName,
  checkUsername,
  MAX_PERSON_NAME_LENGTH,
  personNameMessage,
  USERNAME_MAX_LENGTH,
  USERNAME_PATTERN,
  usernameMessage,
} from "@/lib/identity-fields";

describe("person name rules", () => {
  it("folds runs of ordinary spaces, trims and keeps letters of every script", () => {
    expect(checkPersonName("  Ada   Augusta ")).toEqual({ ok: true, value: "Ada Augusta" });
    expect(checkPersonName("Şükrü Çağrı")).toEqual({ ok: true, value: "Şükrü Çağrı" });
    expect(checkPersonName("Ünlü-Kaya O'Neil")).toEqual({ ok: true, value: "Ünlü-Kaya O'Neil" });
    expect(checkPersonName("x".repeat(MAX_PERSON_NAME_LENGTH))).toEqual({ ok: true, value: "x".repeat(64) });
    expect(checkPersonName(` ${"x".repeat(MAX_PERSON_NAME_LENGTH)} `)).toEqual({ ok: true, value: "x".repeat(64) });
  });

  it("rejects invisible characters instead of silently normalising them", () => {
    expect(checkPersonName("Ada​Lovelace")).toEqual({ ok: false, reason: "invisible_characters" });
    expect(checkPersonName("Ada Lovelace")).toEqual({ ok: false, reason: "invisible_characters" });
    expect(checkPersonName("﻿Ada")).toEqual({ ok: false, reason: "invisible_characters" });
    expect(checkPersonName("Ada Lovelace")).toEqual({ ok: false, reason: "invisible_characters" });
    expect(checkPersonName("Ada\tLovelace")).toEqual({ ok: false, reason: "invisible_characters" });
    expect(checkPersonName("Ada　Lovelace")).toEqual({ ok: false, reason: "invisible_characters" });
  });

  it("rejects Keycloak's prohibited person-name characters", () => {
    for (const character of ["<", ">", "&", '"', "$", "%", "!", "#", "?", "§", ";", "*", "~", "/", "\\", "|", "^", "=", "[", "]", "{", "}", "(", ")", "`"]) {
      expect(checkPersonName(`Ada${character}`), character).toEqual({ ok: false, reason: "prohibited_characters" });
    }
  });

  it("rejects empty and over-long values after normalisation", () => {
    expect(checkPersonName("")).toEqual({ ok: false, reason: "empty" });
    expect(checkPersonName("   ")).toEqual({ ok: false, reason: "empty" });
    expect(checkPersonName(undefined)).toEqual({ ok: false, reason: "empty" });
    expect(checkPersonName(42)).toEqual({ ok: false, reason: "empty" });
    expect(checkPersonName("x".repeat(MAX_PERSON_NAME_LENGTH + 1))).toEqual({ ok: false, reason: "too_long" });
    expect(checkPersonName(`${"x".repeat(60)}     yyyy`)).toEqual({ ok: false, reason: "too_long" });
  });

  it("words every rule in Turkish with the field label", () => {
    expect(personNameMessage("firstName", "empty")).toBe("Ad boş olamaz.");
    expect(personNameMessage("lastName", "too_long")).toBe("Soyad en fazla 64 karakter olabilir.");
    expect(personNameMessage("firstName", "invisible_characters")).toMatch(/^Ad görünmez/);
    expect(personNameMessage("lastName", "prohibited_characters")).toMatch(/^Soyad şu karakterleri içeremez: < >/);
  });
});

describe("username rules", () => {
  it("lower-cases and trims, then enforces the SPI pattern", () => {
    expect(checkUsername(" Ada.Lovelace_01 ")).toEqual({ ok: true, value: "ada.lovelace_01" });
    expect(checkUsername("abc")).toEqual({ ok: true, value: "abc" });
    expect(checkUsername("a".repeat(USERNAME_MAX_LENGTH))).toEqual({ ok: true, value: "a".repeat(30) });
    expect(USERNAME_PATTERN.test("ada.lovelace_01")).toBe(true);
  });

  it("names the first broken rule", () => {
    expect(checkUsername("")).toEqual({ ok: false, reason: "empty" });
    expect(checkUsername("   ")).toEqual({ ok: false, reason: "empty" });
    expect(checkUsername(null)).toEqual({ ok: false, reason: "empty" });
    expect(checkUsername("ab")).toEqual({ ok: false, reason: "too_short" });
    expect(checkUsername("a".repeat(USERNAME_MAX_LENGTH + 1))).toEqual({ ok: false, reason: "too_long" });
    expect(checkUsername("ada lovelace")).toEqual({ ok: false, reason: "invalid_characters" });
    expect(checkUsername("ada-lovelace")).toEqual({ ok: false, reason: "invalid_characters" });
    expect(checkUsername("ada@lovelace")).toEqual({ ok: false, reason: "invalid_characters" });
    expect(checkUsername("şükrü")).toEqual({ ok: false, reason: "invalid_characters" });
    expect(checkUsername("İbrahim")).toEqual({ ok: false, reason: "invalid_characters" });
  });

  it("words every rule in Turkish", () => {
    expect(usernameMessage("empty")).toBe("Kullanıcı adı boş olamaz.");
    expect(usernameMessage("too_short")).toBe("Kullanıcı adı en az 3 karakter olmalı.");
    expect(usernameMessage("too_long")).toBe("Kullanıcı adı en fazla 30 karakter olabilir.");
    expect(usernameMessage("invalid_characters")).toMatch(/küçük harf \(a-z\), rakam, nokta ve alt çizgi/);
  });
});
