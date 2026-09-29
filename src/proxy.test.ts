import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE_PICTURE_ORIGIN } from "@/config/club-profile";
import { config, proxy } from "@/proxy";

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

  it("allows images only from the same origin, inline data and the profile picture origin", () => {
    const headers = { cookie: "__Host-sky-account=opaque-session" };
    const policy = proxy(new NextRequest("https://my.yildizskylab.com/club-profile", { headers }))
      .headers.get("content-security-policy");

    expect(DEFAULT_PROFILE_PICTURE_ORIGIN).toBe("https://cdn.yildizskylab.com");
    expect(policy).toContain(`img-src 'self' data: blob: ${DEFAULT_PROFILE_PICTURE_ORIGIN};`);
    expect(policy).toContain("connect-src 'self'");
    expect(policy).not.toMatch(/connect-src[^;]*cdn\.yildizskylab\.com/);
  });

  it("takes the profile picture origin from PROFILE_PICTURE_ORIGIN when it is set", async () => {
    vi.stubEnv("PROFILE_PICTURE_ORIGIN", "https://media.yildizskylab.com");
    vi.resetModules();
    try {
      const { proxy: configuredProxy } = await import("@/proxy");
      const policy = configuredProxy(new NextRequest("https://my.yildizskylab.com/club-profile", {
        headers: { cookie: "__Host-sky-account=opaque-session" },
      })).headers.get("content-security-policy");
      expect(policy).toContain("img-src 'self' data: blob: https://media.yildizskylab.com;");
      expect(policy).not.toContain("cdn.yildizskylab.com");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
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

  it("keeps the receipt-backed deletion status page public after the account is blocked", () => {
    const response = proxy(new NextRequest("https://my.yildizskylab.com/account-deletion"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    ["GET", `/handoff?code=${"p".repeat(43)}`],
    ["POST", "/v1/native-handoff"],
  ])("leaves the retired native handoff path %s %s to the router's 404 instead of the login page", (method, path) => {
    const response = proxy(new NextRequest(`https://my.yildizskylab.com${path}`, { method }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("internal paths", () => {
  const edgeHeaders = {
    "x-forwarded-for": "203.0.113.7",
    "x-forwarded-host": "my.yildizskylab.com",
    "x-forwarded-proto": "https",
    "x-real-ip": "203.0.113.7",
    forwarded: "for=203.0.113.7;proto=https",
  };

  it.each([
    ["GET", "/internal", {}],
    ["GET", "/internal/", {}],
    ["GET", "/internal/v1/x", {}],
    ["POST", "/internal/v1/native-handoff/redeem", {}],
    ["GET", "/internal/v1/x", edgeHeaders],
    ["POST", "/internal/v1/native-handoff/redeem", edgeHeaders],
    ["GET", "/internal/v1/x", { cookie: "__Host-sky-account=opaque-session" }],
    ["DELETE", "/internal/v1/x?next=/security", { ...edgeHeaders, cookie: "__Host-sky-account=opaque-session" }],
  ])("answers %s %s with a bare, uncached 404 before the session check", async (method, path, headers) => {
    const response = proxy(new NextRequest(`https://my.yildizskylab.com${path}`, { method, headers }));

    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("only claims the /internal segment itself", () => {
    const response = proxy(new NextRequest("https://my.yildizskylab.com/internals"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://my.yildizskylab.com/login?returnTo=%2Finternals");
  });

  it.each([
    ["/internal", {}],
    ["/internal/v1/x", {}],
    ["/internal/v1/x", { "next-router-prefetch": "1" }],
    ["/internal/v1/x", { purpose: "prefetch" }],
  ])("runs for %s even on a prefetch request (%o)", (url, headers) => {
    expect(unstable_doesMiddlewareMatch({ config, url, headers })).toBe(true);
  });
});

describe("well-known paths", () => {
  it.each([
    "/.well-known/assetlinks.json",
    "/.well-known/apple-app-site-association",
    "/.well-known/security.txt",
    "/.well-known",
  ])("leaves %s to the app instead of the login page", (path) => {
    const response = proxy(new NextRequest(`https://my.yildizskylab.com${path}`));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });

  it("still redirects a look-alike path outside /.well-known", () => {
    const response = proxy(new NextRequest("https://my.yildizskylab.com/.well-knownx"));
    expect(response.status).toBe(307);
  });
});
