import { describe, expect, it } from "vitest";
import { isSandbox } from "@/lib/environment";

describe("isSandbox", () => {
  it("reads the sandbox from Account Center's own address or its realm", () => {
    expect(isSandbox({ appUrl: "https://sandbox-my.yildizskylab.com" })).toBe(true);
    expect(isSandbox({ appUrl: new URL("https://sandbox.my.yildizskylab.com") })).toBe(true);
    expect(isSandbox({ issuer: "https://e.yildizskylab.com/realms/e-skylab-sandbox" })).toBe(true);
    expect(isSandbox({ appUrl: "https://my.yildizskylab.com", issuer: "https://e.yildizskylab.com/realms/e-skylab-sandbox/" })).toBe(true);
  });

  it("never marks production or a value it cannot read", () => {
    expect(isSandbox({ appUrl: "https://my.yildizskylab.com", issuer: "https://e.yildizskylab.com/realms/e-skylab" })).toBe(false);
    expect(isSandbox({ appUrl: "https://my.sandbox-like.example", issuer: "https://e.yildizskylab.com/realms/sandbox-notes/x" })).toBe(false);
    expect(isSandbox({})).toBe(false);
    expect(isSandbox({ appUrl: "not a url", issuer: "" })).toBe(false);
  });
});
