// @vitest-environment node

import { describe, expect, it } from "vitest";
import { MAX_CREDENTIAL_LABEL_LENGTH, normalizeLabel, validCredentialLabel } from "@/lib/labels";

describe("credential label normalisation", () => {
  it("drops format characters and collapses every space kind to one ASCII space", () => {
    expect(normalizeLabel("Tele​fon")).toBe("Telefon");
    expect(normalizeLabel("﻿Mac‍Book⁠")).toBe("MacBook");
    expect(normalizeLabel("iPhone  15")).toBe("iPhone 15");
    expect(normalizeLabel("Yedek anahtar　USB")).toBe("Yedek anahtar USB");
    expect(normalizeLabel("  Telefon \t\n ")).toBe("Telefon");
    expect(normalizeLabel("a b c")).toBe("a b c");
    expect(normalizeLabel("Ünlü 🔐 anahtar")).toBe("Ünlü 🔐 anahtar");
  });

  it("rejects labels that are empty once normalised, and enforces the SPI length after normalisation", () => {
    expect(validCredentialLabel("​‍﻿")).toBeNull();
    expect(validCredentialLabel("  ")).toBeNull();
    expect(validCredentialLabel("   ")).toBeNull();
    expect(validCredentialLabel("")).toBeNull();
    expect(validCredentialLabel(42)).toBeNull();
    expect(validCredentialLabel(null)).toBeNull();
    expect(validCredentialLabel(`​${"x".repeat(MAX_CREDENTIAL_LABEL_LENGTH)} `)).toBe("x".repeat(64));
    expect(validCredentialLabel("x".repeat(MAX_CREDENTIAL_LABEL_LENGTH + 1))).toBeNull();
    expect(validCredentialLabel(`${"x".repeat(60)}   ${"y".repeat(3)}`)).toBe(`${"x".repeat(60)} yyy`);
  });
});
