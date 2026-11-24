// @vitest-environment node

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as CANCEL } from "@/app/api/account/tickets/[id]/cancel/route";
import { CoreTicketsError } from "@/server/core/tickets-client";

const mocks = vi.hoisted(() => ({
  authenticateMutation: vi.fn(),
  revokeLocalSession: vi.fn(),
  accessToken: vi.fn(),
  mine: vi.fn(),
  cancel: vi.fn(),
  services: {} as Record<string, unknown>,
}));

vi.mock("@/server/auth/services", () => ({ getAuthServices: () => mocks.services }));

const activeSession = { id: "local-session-id", subject: "authenticated-subject", absoluteExpiresAt: new Date("2026-12-25T20:00:00Z") };
const ID = "5d0c2f9e-0000-4000-8000-000000000001";

function buildServices(options: { core?: boolean } = {}) {
  return {
    config: { appUrl: new URL("https://my.yildizskylab.com") },
    sessionAccess: { authenticateMutation: mocks.authenticateMutation },
    sessions: { revokeSession: mocks.revokeLocalSession, csrfToken: () => "session-bound-csrf" },
    account: { accessToken: mocks.accessToken },
    coreTickets: options.core === false ? null : { mine: mocks.mine, cancel: mocks.cancel },
  };
}

function post(id: string, options: { origin?: string; csrf?: string } = {}) {
  return new NextRequest(`https://my.yildizskylab.com/api/account/tickets/${id}/cancel`, {
    method: "POST",
    headers: {
      cookie: "__Host-sky-account=opaque-browser-handle",
      origin: options.origin ?? "https://my.yildizskylab.com",
      "sec-fetch-site": "same-origin",
      "x-csrf-token": options.csrf ?? "session-bound-csrf",
    },
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("ticket cancel BFF route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.services = buildServices();
    mocks.authenticateMutation.mockResolvedValue({ status: "active", value: { session: activeSession } });
    mocks.accessToken.mockResolvedValue("server-held-user-token");
    mocks.cancel.mockResolvedValue(undefined);
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("cancels with the session's token behind the exact origin and the CSRF proof", async () => {
    const response = await CANCEL(post(ID), params(ID));
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.cancel).toHaveBeenCalledWith("server-held-user-token", ID);
    expect(mocks.authenticateMutation).toHaveBeenCalledWith("opaque-browser-handle", "session-bound-csrf", { allowRotation: true });
  });

  it("refuses another origin, a wrong CSRF proof and an id it does not take before core", async () => {
    expect((await CANCEL(post(ID, { origin: "https://attacker.invalid" }), params(ID))).status).toBe(403);
    mocks.authenticateMutation.mockResolvedValueOnce({ status: "forbidden" });
    expect((await CANCEL(post(ID, { csrf: "wrong" }), params(ID))).status).toBe(403);
    expect((await CANCEL(post("x"), params("../users/me"))).status).toBe(400);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("says why core refused it, in Turkish with core's code", async () => {
    mocks.cancel.mockRejectedValueOnce(new CoreTicketsError("refused", "ticket_cancel_closed"));
    const response = await CANCEL(post(ID), params(ID));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "ticket_cancel_closed", title: "Etkinlik başladı" });
  });

  it("retries once with a refreshed token when core refuses the bearer, and keeps the session", async () => {
    mocks.cancel.mockRejectedValueOnce(new CoreTicketsError("unauthorized")).mockResolvedValueOnce(undefined);
    expect((await CANCEL(post(ID), params(ID))).status).toBe(204);
    expect(mocks.accessToken).toHaveBeenLastCalledWith(activeSession, { forceRefresh: true });
    mocks.cancel.mockRejectedValue(new CoreTicketsError("unauthorized"));
    expect((await CANCEL(post(ID), params(ID))).status).toBe(401);
    expect(mocks.revokeLocalSession).not.toHaveBeenCalled();
  });

  it("says the page is off without core", async () => {
    mocks.services = buildServices({ core: false });
    const response = await CANCEL(post(ID), params(ID));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "tickets_disabled" });
  });
});
