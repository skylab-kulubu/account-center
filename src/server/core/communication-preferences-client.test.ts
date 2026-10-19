// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoreCommunicationPreferencesError,
  CoreCommunicationPreferencesHttpClient,
  parseCoreScreen,
} from "@/server/core/communication-preferences-client";

const baseUrl = new URL("https://api.yildizskylab.com");
const accessToken = "server-held-user-token";
const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "tests/fixtures/core-communication-preferences.json"), "utf8"),
) as Record<string, unknown>;
const weblab = "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d01";
const airlab = "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d04";

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function problem(status: number, code?: string, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ type: "about:blank", title: "x", status, ...(code ? { code } : {}) }), {
    status,
    headers: { "content-type": "application/problem+json", ...headers },
  });
}

async function failureOf(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CoreCommunicationPreferencesError);
  return error as CoreCommunicationPreferencesError;
}

afterEach(() => vi.unstubAllGlobals());

describe("Core communication preferences HTTP client", () => {
  it("requires a canonical credential-free HTTPS core origin", () => {
    for (const invalid of ["http://api.yildizskylab.com", "https://u:p@api.yildizskylab.com", "https://api.yildizskylab.com/v1"]) {
      expect(() => new CoreCommunicationPreferencesHttpClient(new URL(invalid))).toThrow(/Core API URL/);
    }
  });

  it("reads core's screen with the session bearer and keeps the e-mail cells", async () => {
    const fetch = vi.fn().mockResolvedValue(json(fixture));
    vi.stubGlobal("fetch", fetch);

    const view = await new CoreCommunicationPreferencesHttpClient(baseUrl).read(accessToken);

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.yildizskylab.com/v1/users/me/communication-preferences"),
      expect.objectContaining({
        method: "GET",
        body: null,
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/json", authorization: "Bearer server-held-user-token" },
      }),
    );
    expect(view.master).toEqual({ explicit: null, enabled: true, origin: "default", from: null, effective: true });
    expect(view.club.haber).toEqual({ explicit: false, enabled: false, origin: "explicit", from: null, effective: false });
    const [own] = view.teams;
    expect(own?.code).toBe("WEBLAB");
    expect(own?.children.map(({ code }) => code)).toEqual(["FRONT", "BACK"]);
    // BACK: the person is not in it, its News reaches them from WEBLAB ("üst ekipten").
    expect(own?.children[1]?.kinds.duyuru).toMatchObject({ origin: "default", from: weblab, enabled: true });
    expect(view.following[0]?.children[0]?.kinds.haber).toMatchObject({ origin: "inherited", from: airlab });
    expect(view.following[1]).toMatchObject({ hidden: true, displayName: "Gizli ekip", code: "", path: "" });
    expect(view.followable.map(({ code }) => code)).toEqual(["ROBOLAB", "SKYSEC"]);
    expect(view.tracking).toEqual({ enabled: true, effective: true });
  });

  it("reads a core before the tracking switch as one without it", () => {
    const older = { ...fixture };
    delete older.tracking;
    expect(parseCoreScreen(older).tracking).toBeNull();
  });

  it("ignores channels and members it does not know", () => {
    const withPush = JSON.parse(JSON.stringify(fixture).replaceAll(
      '"email":{',
      '"push":{"explicit":null,"enabled":false,"origin":"default","effective":false},"email":{',
    )) as Record<string, unknown>;
    const view = parseCoreScreen({ ...withPush, channels: ["email", "push"], future: { x: 1 } });
    expect(view.master.enabled).toBe(true);
  });

  it.each([
    ["no e-mail channel", { ...fixture, channels: ["push"] }],
    ["a cell without e-mail", { ...fixture, master: { push: {} } }],
    ["teams that are not a list", { ...fixture, teams: {} }],
    ["no followable list", { ...fixture, followable: undefined }],
    ["a tracking switch without its state", { ...fixture, tracking: { mode: "opt_out" } }],
  ])("fails closed on %s", (_, body) => {
    expect(() => parseCoreScreen(body)).toThrow(CoreCommunicationPreferencesError);
  });

  it("writes the browser's changes on the e-mail channel and answers the new screen", async () => {
    const fetch = vi.fn().mockResolvedValue(json(fixture));
    vi.stubGlobal("fetch", fetch);

    await new CoreCommunicationPreferencesHttpClient(baseUrl).update(accessToken, {
      items: [
        { category: `team:${weblab}:duyuru`, enabled: false },
        { category: "club:haber", enabled: null },
      ],
    });

    const [, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer server-held-user-token",
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      items: [
        { category: `team:${weblab}:duyuru`, channel: "email", enabled: false },
        { category: "club:haber", channel: "email", enabled: null },
      ],
    });
  });

  it.each([
    [{ items: [], tracking: false }, { tracking: { enabled: false } }],
    [{ items: [], tracking: true }, { tracking: { enabled: true } }],
    [
      { items: [{ category: "all", enabled: false }], tracking: false },
      { items: [{ category: "all", channel: "email", enabled: false }], tracking: { enabled: false } },
    ],
  ])("writes the tracking switch as core's own member %#", async (update, body) => {
    const fetch = vi.fn().mockResolvedValue(json(fixture));
    vi.stubGlobal("fetch", fetch);

    await new CoreCommunicationPreferencesHttpClient(baseUrl).update(accessToken, update);

    const [, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it("answers a tracking-only change core wrote while Keycloak was down as the switch alone", async () => {
    const partial = {
      channels: ["email"], master: {}, club: { duyuru: {}, haber: {} }, teams: [], following: [], followable: [],
      tracking: { enabled: false, effective: false, mode: "opt_out" },
      partial: true,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(partial)));

    await expect(new CoreCommunicationPreferencesHttpClient(baseUrl).update(accessToken, { items: [], tracking: false }))
      .resolves.toEqual({ partial: true, tracking: { enabled: false } });
  });

  it.each([
    ["a change with items", { items: [{ category: "all", enabled: false }], tracking: false }, { enabled: false }],
    ["a switch without its value", { items: [], tracking: false }, { mode: "opt_out" }],
  ])("fails closed on a partial answer to %s", async (_, update, tracking) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...fixture, tracking, partial: true })));
    const error = await failureOf(new CoreCommunicationPreferencesHttpClient(baseUrl).update(accessToken, update));
    expect(error.failure).toBe("contract");
  });

  it.each([
    ["no change", { items: [] }],
    ["a malformed category", { items: [{ category: "team:a b:duyuru", enabled: true }] }],
    ["the same category twice", { items: [{ category: "all", enabled: true }, { category: "all", enabled: false }] }],
    ["a value that is not a choice", { items: [{ category: "all", enabled: "yes" }] }],
    ["a tracking value that is not a choice", { items: [], tracking: null }],
  ])("refuses %s before calling core", async (_, update) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const failure = await failureOf(new CoreCommunicationPreferencesHttpClient(baseUrl).update(accessToken, update as never));
    expect(failure.failure).toBe("invalid_input");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [problem(503, "communication_preferences_unavailable"), "off", null],
    [problem(503, "communication_preference_teams_unavailable", { "retry-after": "30" }), "teams_unavailable", 30],
    [problem(503), "unavailable", null],
    [problem(400, "communication_preference_team_unknown"), "team_unknown", null],
    [problem(400, "communication_preference_invalid"), "rejected", null],
    [problem(401), "unauthorized", null],
    [problem(403, "communication_preference_person_only"), "forbidden", null],
    [problem(403, "communication_preference_subject_inactive"), "subject_inactive", null],
    [problem(500), "unavailable", null],
    [new Response(null, { status: 204 }), "contract", null],
    [new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }), "contract", null],
  ])("maps core's answer %# by status and code", async (response, failure, retryAfter) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const error = await failureOf(new CoreCommunicationPreferencesHttpClient(baseUrl).read(accessToken));
    expect(error.failure).toBe(failure);
    expect(error.retryAfterSeconds).toBe(retryAfter);
  });

  it("reports an unreachable core without its address or the token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:443 Bearer server-held-user-token")));
    const error = await failureOf(new CoreCommunicationPreferencesHttpClient(baseUrl).read(accessToken));
    expect(error.failure).toBe("unavailable");
    expect(error.message).not.toMatch(/10\.0\.0\.1|server-held/);
  });
});
