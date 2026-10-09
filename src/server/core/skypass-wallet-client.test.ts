// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoreSkyPassWalletError,
  CoreSkyPassWalletHttpClient,
  isCoreSkyPassWalletError,
} from "@/server/core/skypass-wallet-client";

const baseUrl = new URL("https://api.yildizskylab.com");
const accessToken = "server-held-user-token";
const saveUrl = "https://pay.google.com/gp/v/save/eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJza3lsYWIifQ.c2lnbmF0dXJl";

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function problem(status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ type: "about:blank", title: "x", status, ...extra }), {
    status,
    headers: { "content-type": "application/problem+json", ...headers },
  });
}

async function failureOf(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CoreSkyPassWalletError);
  return error as CoreSkyPassWalletError;
}

afterEach(() => vi.unstubAllGlobals());

describe("Core SkyPass Wallet HTTP client", () => {
  it("requires a canonical credential-free HTTPS core origin", () => {
    for (const invalid of ["http://api.yildizskylab.com", "https://u:p@api.yildizskylab.com", "https://api.yildizskylab.com/v1"]) {
      expect(() => new CoreSkyPassWalletHttpClient(new URL(invalid))).toThrow(/Core API URL/);
    }
  });

  it("reads the wallet status with the session bearer only", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ google: { available: true, issued: false }, apple: { available: false } }));
    vi.stubGlobal("fetch", fetch);

    await expect(new CoreSkyPassWalletHttpClient(baseUrl).status(accessToken))
      .resolves.toEqual({ google: { available: true, issued: false } });
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.yildizskylab.com/v1/skypass/wallet"),
      expect.objectContaining({
        method: "GET",
        body: null,
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/json", authorization: "Bearer server-held-user-token" },
      }),
    );
  });

  it("fails closed on a status body that is not the documented one", async () => {
    for (const body of [{}, { google: { available: "yes", issued: false } }, { google: { available: true } }]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)));
      expect((await failureOf(new CoreSkyPassWalletHttpClient(baseUrl).status(accessToken))).failure).toBe("contract");
    }
  });

  it("answers the save link of a POST without a body", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ saveUrl }));
    vi.stubGlobal("fetch", fetch);

    await expect(new CoreSkyPassWalletHttpClient(baseUrl).googleSaveUrl(accessToken)).resolves.toBe(saveUrl);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.yildizskylab.com/v1/skypass/wallet/google"),
      expect.objectContaining({ method: "POST", body: null, redirect: "error" }),
    );
  });

  it("refuses a save link that is not Google's, without putting the value in the error", async () => {
    for (const candidate of [
      "https://evil.example/gp/v/save/a.b.c",
      "http://pay.google.com/gp/v/save/a.b.c",
      "https://pay.google.com/gp/v/save/a.b.c?next=https://evil.example",
      "https://pay.google.com/gp/v/save/not-a-jwt",
      "javascript:alert(1)",
      `https://pay.google.com/gp/v/save/${"a".repeat(9_000)}.b.c`,
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ saveUrl: candidate })));
      const error = await failureOf(new CoreSkyPassWalletHttpClient(baseUrl).googleSaveUrl(accessToken));
      expect(error.failure).toBe("contract");
      expect(`${error.message} ${error.stack}`).not.toContain("gp/v/save");
    }
  });

  it("ends a pass with DELETE and accepts only 204", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await expect(new CoreSkyPassWalletHttpClient(baseUrl).revokeGoogle(accessToken)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.yildizskylab.com/v1/skypass/wallet/google"),
      expect.objectContaining({ method: "DELETE" }),
    );

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({})));
    expect((await failureOf(new CoreSkyPassWalletHttpClient(baseUrl).revokeGoogle(accessToken))).failure).toBe("contract");
  });

  it("maps core's documented answers by status and code", async () => {
    const cases: Array<[Response, string, number | null]> = [
      [problem(401), "unauthorized", null],
      [problem(403), "forbidden", null],
      [problem(404), "not_found", null],
      [problem(409), "ended", null],
      [problem(429, { code: "skypass_wallet_link_rate_limited", retryAfterSeconds: 42 }), "rate_limited", 42],
      [problem(429, {}, { "retry-after": "17" }), "rate_limited", 17],
      [problem(429, { retryAfterSeconds: 999_999 }), "rate_limited", 3_600],
      [problem(502, { code: "skypass_google_wallet_unavailable" }, { "retry-after": "30" }), "google_unavailable", 30],
      [problem(503, { code: "skypass_google_wallet_off" }), "off", null],
      [problem(503), "unavailable", null],
      [problem(502), "unavailable", null],
      [new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }), "unavailable", null],
      [problem(400), "rejected", null],
    ];
    for (const [response, failure, seconds] of cases) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      const error = await failureOf(new CoreSkyPassWalletHttpClient(baseUrl).googleSaveUrl(accessToken));
      expect([error.failure, error.retryAfterSeconds]).toEqual([failure, seconds]);
    }
  });

  it("reports a network failure as unavailable and refuses a malformed bearer before any call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    expect((await failureOf(new CoreSkyPassWalletHttpClient(baseUrl).status(accessToken))).failure).toBe("unavailable");

    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await failureOf(new CoreSkyPassWalletHttpClient(baseUrl).status("bad token"))).failure).toBe("invalid_input");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("isCoreSkyPassWalletError", () => {
  it("recognises the error of another bundle's copy of the class by its brand", () => {
    const foreign = Object.assign(new Error("x"), { [Symbol.for("skylab.account-center.core-skypass-wallet-error")]: true, failure: "ended" });
    expect(isCoreSkyPassWalletError(new CoreSkyPassWalletError("ended"))).toBe(true);
    expect(isCoreSkyPassWalletError(foreign)).toBe(true);
    expect(isCoreSkyPassWalletError(new Error("x"))).toBe(false);
    expect(isCoreSkyPassWalletError(null)).toBe(false);
  });
});
