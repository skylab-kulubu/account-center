import { describe, expect, it, vi } from "vitest";
import {
  detailOf,
  errorOf,
  groupSecret,
  parseSudoChallenge,
  retryAfterOf,
  runWithSudo,
  securityRequest,
} from "@/lib/security-client";

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

const challenge = { error: "sudo_required", reason: "missing", methods: ["password"], fallback: null };

describe("runWithSudo", () => {
  it("returns a successful answer without asking for sudo", async () => {
    const ensureSudo = vi.fn(async () => true);
    const send = vi.fn(async () => json({ credential: { label: "Telefon" } }, 201));
    const outcome = await runWithSudo(send, ensureSudo);
    expect(outcome).toMatchObject({ kind: "ok", body: { credential: { label: "Telefon" } } });
    expect("status" in outcome).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ensureSudo).not.toHaveBeenCalled();
  });

  it("treats 204 as success without reading a body", async () => {
    const outcome = await runWithSudo(async () => new Response(null, { status: 204 }), async () => true);
    expect(outcome).toMatchObject({ kind: "ok", body: null });
  });

  it("opens the dialog once on 428 and retries after a verified proof", async () => {
    const ensureSudo = vi.fn(async () => true);
    const send = vi.fn()
      .mockResolvedValueOnce(json(challenge, 428))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const outcome = await runWithSudo(send, ensureSudo);
    expect(outcome.kind).toBe("ok");
    expect(ensureSudo).toHaveBeenCalledWith({ challenged: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("stops when the person dismisses the dialog and never loops on a second 428", async () => {
    const dismissed = await runWithSudo(async () => json(challenge, 428), async () => false);
    expect(dismissed).toEqual({ kind: "sudo_cancelled" });

    const send = vi.fn(async () => json({ ...challenge, reason: "expired" }, 428));
    const looped = await runWithSudo(send, async () => true);
    expect(looped).toMatchObject({ kind: "error", status: 428 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("reports the Microsoft-only proof gap instead of reopening the dialog", async () => {
    const ensureSudo = vi.fn(async () => true);
    const outcome = await runWithSudo(
      async () => json({ ...challenge, reason: "spi_token_required", methods: [], fallback: "microsoft" }, 428),
      ensureSudo,
    );
    expect(outcome).toEqual({ kind: "spi_token_required" });
    expect(ensureSudo).not.toHaveBeenCalled();
    const afterRetry = vi.fn()
      .mockResolvedValueOnce(json(challenge, 428))
      .mockResolvedValueOnce(json({ ...challenge, reason: "spi_token_required" }, 428));
    expect(await runWithSudo(afterRetry, async () => true)).toEqual({ kind: "spi_token_required" });
  });

  it("returns the problem body and status for other failures", async () => {
    const outcome = await runWithSudo(
      async () => json({ error: "password_policy", detail: "Geçersiz Şifre: En az 12 karakter uzunluğunda olmalı.", policy: "invalidPasswordMinLengthMessage", params: [12] }, 400),
      async () => true,
    );
    expect(outcome).toMatchObject({ kind: "error", status: 400, body: { error: "password_policy", params: [12] } });
  });
});

describe("security request helpers", () => {
  it("sends same-origin JSON with the CSRF proof and no caching", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await securityRequest({ method: "POST", path: "/api/account/security/password", csrfToken: "csrf", body: { newPassword: "x", logoutOtherSessions: true } });
      await securityRequest({ method: "DELETE", path: "/api/account/security/credentials/ref", csrfToken: "csrf" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/account/security/password", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: { "x-csrf-token": "csrf", "content-type": "application/json" },
      body: JSON.stringify({ newPassword: "x", logoutOtherSessions: true }),
    }));
    const deletion = fetchMock.mock.calls[1]![1]!;
    expect(deletion.method).toBe("DELETE");
    expect(deletion.headers).toEqual({ "x-csrf-token": "csrf" });
    expect("body" in deletion).toBe(false);
  });

  it("parses challenge bodies strictly and reads details, errors and retry hints defensively", () => {
    expect(parseSudoChallenge(challenge)).toEqual(challenge);
    expect(parseSudoChallenge({ ...challenge, reason: "later" })).toBeNull();
    expect(parseSudoChallenge({ ...challenge, methods: "password" })).toBeNull();
    expect(parseSudoChallenge("sudo_required")).toBeNull();
    expect(detailOf({ detail: "Kod yanlış." }, "fallback")).toBe("Kod yanlış.");
    expect(detailOf({ detail: "" }, "fallback")).toBe("fallback");
    expect(detailOf({ detail: "x".repeat(513) }, "fallback")).toBe("fallback");
    expect(detailOf(null, "fallback")).toBe("fallback");
    expect(errorOf({ error: "duplicate_label" })).toBe("duplicate_label");
    expect(errorOf({ error: 42 })).toBe("");
    expect(retryAfterOf({ retryAfter: 12.2 }, new Response(null))).toBe(13);
    expect(retryAfterOf({ retryAfter: 10 ** 9 }, new Response(null))).toBe(24 * 60 * 60);
    expect(retryAfterOf({}, new Response(null, { headers: { "retry-after": "45" } }))).toBe(45);
    expect(retryAfterOf({}, new Response(null))).toBeUndefined();
  });

  it("groups a Base32 secret in fours for manual entry", () => {
    expect(groupSecret("OR4DE4DRNFXDKZTQJZUFMSBSKR4G2Z3B")).toBe("OR4D E4DR NFXD KZTQ JZUF MSBS KR4G 2Z3B");
    expect(groupSecret("ABCDEFG===")).toBe("ABCD EFG");
    expect(groupSecret("")).toBe("");
  });
});
