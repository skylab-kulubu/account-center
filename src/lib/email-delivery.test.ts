import { describe, expect, it } from "vitest";
import { parseUndeliverable } from "@/lib/email-delivery";

describe("parseUndeliverable", () => {
  it("keeps the known kinds once, in a fixed order, and drops anything else", () => {
    expect(parseUndeliverable(["personal", "primary", "personal", "other", 3, null])).toEqual(["primary", "personal"]);
    expect(parseUndeliverable(["school"])).toEqual(["school"]);
  });

  it("reads a missing or malformed member as no warning", () => {
    expect(parseUndeliverable(undefined)).toEqual([]);
    expect(parseUndeliverable("primary")).toEqual([]);
    expect(parseUndeliverable({ primary: true })).toEqual([]);
  });
});
