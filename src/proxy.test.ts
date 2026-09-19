import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";

describe("security proxy", () => {
  it("adds a unique, strict nonce policy to document responses", () => {
    const first = proxy(new NextRequest("https://my.yildizskylab.com/"));
    const second = proxy(new NextRequest("https://my.yildizskylab.com/security"));
    const firstPolicy = first.headers.get("content-security-policy");
    const secondPolicy = second.headers.get("content-security-policy");

    expect(firstPolicy).toContain("'strict-dynamic'");
    expect(firstPolicy).toContain("script-src 'self' 'nonce-");
    expect(firstPolicy).not.toContain("'unsafe-inline'");
    expect(firstPolicy).not.toEqual(secondPolicy);
  });
});
