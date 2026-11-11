// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreAppPreferencesError, CoreAppPreferencesHttpClient } from "@/server/core/app-preferences-client";

const baseUrl = new URL("https://api.yildizskylab.com");
const accessToken = "server-held-user-token";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function problem(status: number, code?: string) {
  return new Response(JSON.stringify({ type: "about:blank", title: "x", status, ...(code ? { code } : {}) }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

async function failureOf(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CoreAppPreferencesError);
  return (error as CoreAppPreferencesError).failure;
}

afterEach(() => vi.unstubAllGlobals());

describe("Core app preferences HTTP client", () => {
  it("requires a canonical credential-free HTTPS core origin", () => {
    for (const invalid of ["http://api.yildizskylab.com", "https://u:p@api.yildizskylab.com", "https://api.yildizskylab.com/v1"]) {
      expect(() => new CoreAppPreferencesHttpClient(new URL(invalid))).toThrow(/Core API URL/);
    }
  });

  it("reads the summary with the session bearer and keeps app, keys and time only", async () => {
    const fetch = vi.fn().mockResolvedValue(json({
      items: [{ app: "forms", keys: 2, updatedAt: "2026-11-08T10:00:00Z", value: { secret: true } }],
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(new CoreAppPreferencesHttpClient(baseUrl).summary(accessToken)).resolves.toEqual([
      { app: "forms", keys: 2, updatedAt: "2026-11-08T10:00:00Z" },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.yildizskylab.com/v1/users/me/app-preferences"),
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/json", authorization: "Bearer server-held-user-token" },
      }),
    );
  });

  it.each([
    [null],
    [{}],
    [{ items: {} }],
    [{ items: [{ app: "Forms", keys: 1, updatedAt: "2026-11-08T10:00:00Z" }] }],
    [{ items: [{ app: "forms", keys: 0, updatedAt: "2026-11-08T10:00:00Z" }] }],
    [{ items: [{ app: "forms", keys: 1, updatedAt: "dün" }] }],
    [{ items: [
      { app: "forms", keys: 1, updatedAt: "2026-11-08T10:00:00Z" },
      { app: "forms", keys: 2, updatedAt: "2026-11-08T10:00:00Z" },
    ] }],
  ])("refuses a summary it does not recognise: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)));
    expect(await failureOf(new CoreAppPreferencesHttpClient(baseUrl).summary(accessToken))).toBe("contract");
  });

  it("resets one app with DELETE and accepts 204", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await expect(new CoreAppPreferencesHttpClient(baseUrl).reset(accessToken, "forms")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.yildizskylab.com/v1/users/me/app-preferences/forms"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("never sends an app name outside core's rule", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const app of ["", "Forms", "../users", "forms/key", "a"]) {
      expect(await failureOf(new CoreAppPreferencesHttpClient(baseUrl).reset(accessToken, app))).toBe("invalid_input");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [problem(401), "unauthorized"],
    [problem(404), "off"],
    [problem(404, "app_preference_unknown_app"), "off"],
    [problem(403, "app_preference_wrong_client"), "forbidden"],
    [problem(403, "app_preference_subject_inactive"), "subject_inactive"],
    [problem(429, "app_preference_rate_limited"), "rate_limited"],
    [problem(400), "rejected"],
    [problem(502), "unavailable"],
  ])("maps a refusal by status and code", async (response, failure) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(await failureOf(new CoreAppPreferencesHttpClient(baseUrl).reset(accessToken, "forms"))).toBe(failure);
  });

  it("reports a network failure as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    expect(await failureOf(new CoreAppPreferencesHttpClient(baseUrl).summary(accessToken))).toBe("unavailable");
  });
});
