import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";

describe("security proxy", () => {
  it("adds a unique, strict nonce policy to document responses", () => {
    const headers = { cookie: "__Host-sky-account=opaque-session" };
    const first = proxy(new NextRequest("https://my.yildizskylab.com/", { headers }));
    const second = proxy(new NextRequest("https://my.yildizskylab.com/security", { headers }));
    const firstPolicy = first.headers.get("content-security-policy");
    const secondPolicy = second.headers.get("content-security-policy");

    expect(firstPolicy).toContain("'strict-dynamic'");
    expect(firstPolicy).toContain("script-src 'self' 'nonce-");
    expect(firstPolicy).not.toContain("'unsafe-inline'");
    expect(firstPolicy).not.toEqual(secondPolicy);
  });

  it("optimistically redirects a protected page without a session cookie", () => {
    const response = proxy(new NextRequest("https://my.yildizskylab.com/security"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://my.yildizskylab.com/login?returnTo=%2Fsecurity",
    );
  });

  it("keeps the login page public", () => {
    const response = proxy(new NextRequest("https://my.yildizskylab.com/login"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("keeps only the fixed handoff consumption route public", () => {
    const response = proxy(new NextRequest(
      `https://my.yildizskylab.com/handoff?code=${"p".repeat(43)}`,
    ));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    "/v1/native-handoff",
    "/internal/v1/native-handoff/redeem",
  ])("does not require a browser cookie for the authenticated machine endpoint %s", (path) => {
    const response = proxy(new NextRequest(`https://my.yildizskylab.com${path}`, { method: "POST" }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
