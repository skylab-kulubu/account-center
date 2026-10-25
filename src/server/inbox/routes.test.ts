// @vitest-environment node

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as LIST } from "@/app/api/account/inbox/route";
import { GET as COUNTS } from "@/app/api/account/inbox/counts/route";
import { POST as MARK } from "@/app/api/account/inbox/items/[id]/[action]/route";
import { POST as READ_ALL } from "@/app/api/account/inbox/read-all/route";
import { POST as SEEN_ALL } from "@/app/api/account/inbox/seen-all/route";
import type { InboxPage } from "@/lib/inbox";
import { AccountReauthenticationRequiredError } from "@/server/keycloak-account/service";
import { SkyMailInboxError } from "@/server/skymail/inbox-client";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authenticateMutation: vi.fn(),
  revokeLocalSession: vi.fn(),
  accessToken: vi.fn(),
  list: vi.fn(),
  counts: vi.fn(),
  mark: vi.fn(),
  markAll: vi.fn(),
  services: {} as Record<string, unknown>,
}));

vi.mock("@/server/auth/services", () => ({ getAuthServices: () => mocks.services }));

const activeSession = { id: "local-session-id", subject: "authenticated-subject", absoluteExpiresAt: new Date("2026-10-25T20:00:00Z") };
const ITEM_ID = "5d0c2f9e-0000-4000-8000-000000000001";
const item = {
  id: ITEM_ID,
  type: "event.ticket-created",
  title: "Kodlama Gecesi biletin hazır",
  summary: "",
  link: "/events/6f1c",
  createdAt: "2026-10-25T09:00:00Z",
  seenAt: null,
  readAt: null,
};
const page: InboxPage = { items: [item], nextCursor: null };

function buildServices(options: { skymail?: boolean } = {}) {
  return {
    config: { appUrl: new URL("https://my.yildizskylab.com") },
    sessionAccess: { authenticate: mocks.authenticate, authenticateMutation: mocks.authenticateMutation },
    sessions: { revokeSession: mocks.revokeLocalSession, csrfToken: () => "session-bound-csrf" },
    account: { accessToken: mocks.accessToken },
    skymailInbox: options.skymail === false ? null : { list: mocks.list, counts: mocks.counts, mark: mocks.mark, markAll: mocks.markAll },
  };
}

function get(path: string) {
  return new NextRequest(`https://my.yildizskylab.com${path}`, {
    headers: { cookie: "__Host-sky-account=opaque-browser-handle" },
  });
}

function post(path: string, options: { origin?: string; csrf?: string } = {}) {
  return new NextRequest(`https://my.yildizskylab.com${path}`, {
    method: "POST",
    headers: {
      cookie: "__Host-sky-account=opaque-browser-handle",
      origin: options.origin ?? "https://my.yildizskylab.com",
      "sec-fetch-site": "same-origin",
      "x-csrf-token": options.csrf ?? "session-bound-csrf",
    },
  });
}

const params = (id: string, action: string) => ({ params: Promise.resolve({ id, action }) });

/** A JWT-shaped token (unsigned: the BFF reads its audience only, SkyMail checks it). */
function token(name: string, aud: string[] = ["account", "core", "skymail"]) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part({ sub: name, aud })}.c2ln`;
}
const USER_TOKEN = token("server-held-user-token");

describe("inbox BFF routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.services = buildServices();
    mocks.authenticate.mockResolvedValue({ status: "active", value: { session: activeSession } });
    mocks.authenticateMutation.mockResolvedValue({ status: "active", value: { session: activeSession } });
    mocks.revokeLocalSession.mockResolvedValue(true);
    mocks.accessToken.mockResolvedValue(USER_TOKEN);
    mocks.list.mockResolvedValue(page);
    mocks.counts.mockResolvedValue({ unseen: 1, unread: 1 });
    mocks.mark.mockResolvedValue({ ...item, readAt: "2026-10-25T10:00:00Z" });
    mocks.markAll.mockResolvedValue(1);
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("lists with the session's token, uncached, and passes the cursor on", async () => {
    const first = await LIST(get("/api/account/inbox"));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    await expect(first.json()).resolves.toEqual({ page });
    expect(mocks.list).toHaveBeenCalledWith(USER_TOKEN, undefined);

    await LIST(get("/api/account/inbox?cursor=next_1"));
    expect(mocks.list).toHaveBeenLastCalledWith(USER_TOKEN, "next_1");
  });

  it("refuses a cursor it does not take without calling SkyMail", async () => {
    expect((await LIST(get("/api/account/inbox?cursor=a%20b"))).status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("answers the badge's counts", async () => {
    const response = await COUNTS(get("/api/account/inbox/counts"));
    await expect(response.json()).resolves.toEqual({ counts: { unseen: 1, unread: 1 } });
  });

  it("marks an item and all items behind the exact origin and the CSRF proof", async () => {
    const marked = await MARK(post(`/api/account/inbox/items/${ITEM_ID}/read`), params(ITEM_ID, "read"));
    expect(marked.status).toBe(200);
    await expect(marked.json()).resolves.toMatchObject({ item: { readAt: "2026-10-25T10:00:00Z" } });
    expect(mocks.mark).toHaveBeenCalledWith(USER_TOKEN, ITEM_ID, "read");
    expect(mocks.authenticateMutation).toHaveBeenCalledWith("opaque-browser-handle", "session-bound-csrf", { allowRotation: false });

    await expect((await READ_ALL(post("/api/account/inbox/read-all"))).json()).resolves.toEqual({ updated: 1 });
    await SEEN_ALL(post("/api/account/inbox/seen-all"));
    expect(mocks.markAll.mock.calls.map(([, action]) => action)).toEqual(["read-all", "seen-all"]);
  });

  it("refuses another origin, a wrong CSRF proof and an unknown action before SkyMail", async () => {
    expect((await READ_ALL(post("/api/account/inbox/read-all", { origin: "https://attacker.invalid" }))).status).toBe(403);
    mocks.authenticateMutation.mockResolvedValueOnce({ status: "forbidden" });
    expect((await READ_ALL(post("/api/account/inbox/read-all", { csrf: "wrong" }))).status).toBe(403);
    expect((await MARK(post(`/api/account/inbox/items/${ITEM_ID}/delete`), params(ITEM_ID, "delete"))).status).toBe(400);
    expect((await MARK(post("/api/account/inbox/items/x/read"), params("../x", "read"))).status).toBe(400);
    expect(mocks.markAll).not.toHaveBeenCalled();
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it("retries once with a refreshed token when SkyMail refuses the bearer", async () => {
    mocks.list.mockRejectedValueOnce(new SkyMailInboxError("unauthorized")).mockResolvedValueOnce(page);
    const FRESH = token("fresh-token");
    mocks.accessToken.mockResolvedValueOnce(token("stale-token")).mockResolvedValueOnce(FRESH);

    expect((await LIST(get("/api/account/inbox"))).status).toBe(200);
    expect(mocks.accessToken).toHaveBeenLastCalledWith(activeSession, { forceRefresh: true });
    expect(mocks.list).toHaveBeenLastCalledWith(FRESH, undefined);
  });

  it("sends no token without the skymail audience, forces no refresh and keeps the session", async () => {
    mocks.accessToken.mockResolvedValue(token("old-session", ["account", "core"]));
    const badge = await COUNTS(get("/api/account/inbox/counts"));
    expect(badge.status).toBe(200);
    await expect(badge.json()).resolves.toEqual({ counts: null });
    const list = await LIST(get("/api/account/inbox"));
    expect(list.status).toBe(503);
    await expect(list.json()).resolves.toMatchObject({ code: "inbox_not_enabled" });
    expect(mocks.counts).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.accessToken).toHaveBeenCalledTimes(2);
    expect(mocks.revokeLocalSession).not.toHaveBeenCalled();
  });

  it("keeps the local session on a SkyMail 401 but ends it on a Keycloak one", async () => {
    mocks.list.mockRejectedValue(new SkyMailInboxError("unauthorized"));
    const skymail = await LIST(get("/api/account/inbox"));
    expect(skymail.status).toBe(401);
    expect(mocks.revokeLocalSession).not.toHaveBeenCalled();

    mocks.accessToken.mockRejectedValue(new AccountReauthenticationRequiredError());
    const keycloak = await LIST(get("/api/account/inbox"));
    expect(keycloak.status).toBe(401);
    expect(mocks.revokeLocalSession).toHaveBeenCalledWith(activeSession.id);
  });

  it("answers the badge null on any failure, ending no session", async () => {
    for (const error of [new SkyMailInboxError("unavailable"), new SkyMailInboxError("contract"), new AccountReauthenticationRequiredError()]) {
      mocks.counts.mockRejectedValueOnce(error);
      const response = await COUNTS(get("/api/account/inbox/counts"));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ counts: null });
    }
    mocks.accessToken.mockRejectedValueOnce(new AccountReauthenticationRequiredError());
    expect((await COUNTS(get("/api/account/inbox/counts"))).status).toBe(200);
    expect(mocks.revokeLocalSession).not.toHaveBeenCalled();
  });

  it("maps SkyMail's failures to problems without its body", async () => {
    for (const [failure, status] of [["unavailable", 503], ["contract", 502], ["not_found", 404], ["forbidden", 403]] as const) {
      mocks.list.mockRejectedValueOnce(new SkyMailInboxError(failure));
      const response = await LIST(get("/api/account/inbox"));
      expect(response.status, failure).toBe(status);
      expect(response.headers.get("content-type")).toBe("application/problem+json");
    }
  });

  it("is off without SkyMail and says so", async () => {
    mocks.services = buildServices({ skymail: false });
    const read = await LIST(get("/api/account/inbox"));
    expect(read.status).toBe(503);
    await expect(read.json()).resolves.toMatchObject({ code: "inbox_disabled" });
    expect((await SEEN_ALL(post("/api/account/inbox/seen-all"))).status).toBe(503);
  });

  it("asks for a session first", async () => {
    mocks.authenticate.mockResolvedValue({ status: "missing" });
    expect((await LIST(get("/api/account/inbox"))).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
