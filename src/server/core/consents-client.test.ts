// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreConsentError, CoreConsentsHttpClient, parseConsentList } from "@/server/core/consents-client";

const baseUrl = new URL("https://api.yildizskylab.com");
const accessToken = "server-held-user-token";
const grant = { purpose: "promotional", textVersion: "tanitim-v1", source: "self" } as const;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function problem(status: number, code?: string, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ type: "about:blank", title: "x", status, ...(code ? { code } : {}) }), {
    status,
    headers: { "content-type": "application/problem+json", ...headers },
  });
}

async function failureOf(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CoreConsentError);
  return error as CoreConsentError;
}

afterEach(() => vi.unstubAllGlobals());

describe("Core consents HTTP client", () => {
  it("requires a canonical credential-free HTTPS core origin", () => {
    for (const invalid of ["http://api.yildizskylab.com", "https://u:p@api.yildizskylab.com", "https://api.yildizskylab.com/v1"]) {
      expect(() => new CoreConsentsHttpClient(new URL(invalid))).toThrow(/Core API URL/);
    }
  });

  it("reads the person's list with the session bearer and keeps purpose and status only", async () => {
    const fetch = vi.fn().mockResolvedValue(json({
      items: [
        { id: "a", purpose: "promotional", status: "withdrawn", subject: "account", source: "self", textVersion: "tanitim-v1", grantedAt: "x" },
        { id: "b", purpose: "event_invitations", status: "active", subject: "address", source: "forms", textVersion: "davet-v2", grantedAt: "x" },
      ],
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(new CoreConsentsHttpClient(baseUrl).list(accessToken)).resolves.toEqual([
      { purpose: "promotional", status: "withdrawn" },
      { purpose: "event_invitations", status: "active" },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.yildizskylab.com/v1/users/me/consents"),
      expect.objectContaining({
        method: "GET",
        body: null,
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/json", authorization: "Bearer server-held-user-token" },
      }),
    );
  });

  it("refuses a list it does not recognise", () => {
    for (const value of [null, {}, { items: {} }, { items: [{ purpose: "promotional", status: "revoked" }] }, { items: [{ status: "active" }] }]) {
      expect(() => parseConsentList(value)).toThrow(CoreConsentError);
    }
  });

  it("grants with the purpose, the text version and the source named, and wants an active answer", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ status: "active" }, 201));
    vi.stubGlobal("fetch", fetch);
    const client = new CoreConsentsHttpClient(baseUrl);

    await client.grant(accessToken, grant);

    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe("https://api.yildizskylab.com/v1/users/me/consents");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ purpose: "promotional", textVersion: "tanitim-v1", source: "self" });

    fetch.mockResolvedValueOnce(json({ status: "pending" }, 201));
    expect((await failureOf(client.grant(accessToken, grant))).failure).toBe("contract");
  });

  it("withdraws by purpose and returns how many grants ended", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ withdrawn: 2 }));
    vi.stubGlobal("fetch", fetch);

    await expect(new CoreConsentsHttpClient(baseUrl).withdraw(accessToken, "promotional")).resolves.toBe(2);
    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe("https://api.yildizskylab.com/v1/users/me/consents/promotional");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeNull();
  });

  it("never sends a malformed purpose, text version, source or bearer", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new CoreConsentsHttpClient(baseUrl);

    expect((await failureOf(client.withdraw(accessToken, "../x"))).failure).toBe("invalid_input");
    expect((await failureOf(client.grant(accessToken, { ...grant, textVersion: "x y" }))).failure).toBe("invalid_input");
    expect((await failureOf(client.grant(accessToken, { ...grant, source: "forms" as "self" }))).failure).toBe("invalid_input");
    expect((await failureOf(client.list("bad token"))).failure).toBe("invalid_input");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [problem(401), "unauthorized"],
    [problem(403, "consent_person_only"), "forbidden"],
    [problem(404), "off"],
    [problem(503, "consents_unavailable"), "off"],
    [problem(503, "consent_addresses_unavailable", { "retry-after": "5" }), "addresses_unavailable"],
    [problem(400, "consent_text_unknown"), "rejected"],
    [problem(500), "unavailable"],
    [new Response(null, { status: 204 }), "contract"],
  ])("maps %#", async (response, failure) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const error = await failureOf(new CoreConsentsHttpClient(baseUrl).list(accessToken));
    expect(error.failure).toBe(failure);
    if (failure === "addresses_unavailable") expect(error.retryAfterSeconds).toBe(5);
  });

  it("reports a network failure as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    expect((await failureOf(new CoreConsentsHttpClient(baseUrl).list(accessToken))).failure).toBe("unavailable");
  });
});
