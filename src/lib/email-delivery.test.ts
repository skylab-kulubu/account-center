import { describe, expect, it } from "vitest";
import { parseUndeliverable, shownUndeliverable, undeliverableRows } from "@/lib/email-delivery";

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

describe("undeliverableRows and shownUndeliverable", () => {
  const schoolPrimary = { email: "a@std.yildiz.edu.tr", primary: "school", schoolEmail: "a@std.yildiz.edu.tr", personalEmail: "a@example.com" } as const;

  it("puts the primary on the primary address's row", () => {
    expect(undeliverableRows(schoolPrimary, ["primary"])).toEqual({ school: true, personal: false, legacy: false });
    expect(undeliverableRows({ ...schoolPrimary, primary: "personal", email: "a@example.com" }, ["primary"]))
      .toEqual({ school: false, personal: true, legacy: false });
    expect(undeliverableRows({ ...schoolPrimary, primary: "none", email: "old@example.com", personalEmail: null }, ["primary"]))
      .toEqual({ school: false, personal: false, legacy: true });
  });

  it("keeps only the kinds that land on a row", () => {
    const orphan = { ...schoolPrimary, primary: "none", email: "old@example.com" } as const;
    expect(shownUndeliverable(orphan, ["primary"])).toEqual([]);
    expect(shownUndeliverable(orphan, ["primary", "personal"])).toEqual(["personal"]);
    expect(shownUndeliverable(schoolPrimary, ["primary", "school"])).toEqual(["primary", "school"]);
  });
});
