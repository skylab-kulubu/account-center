// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreTicketsError, CoreTicketsHttpClient } from "@/server/core/tickets-client";

const baseUrl = new URL("https://api.yildizskylab.com");
const accessToken = "server-held-user-token";
const ID = "5d0c2f9e-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-12-01T12:00:00Z");

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function problem(status: number, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ type: "about:blank", title: "x", status, ...extra }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

async function failureOf(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CoreTicketsError);
  return error as CoreTicketsError;
}

afterEach(() => vi.unstubAllGlobals());

describe("Core tickets HTTP client", () => {
  it("requires a canonical credential-free HTTPS core origin", () => {
    expect(() => new CoreTicketsHttpClient(new URL("http://api.yildizskylab.com"))).toThrow(/Core API URL/);
  });

  it("reads the person's tickets with the waiting list and the cancelled ones", async () => {
    const fetch = vi.fn().mockResolvedValue(json([
      { id: ID, status: "waitlisted", code: "K7M2-QX9F", event: { name: "Atölye", startDate: "2026-12-03T15:00:00Z", status: "published" } },
    ]));
    vi.stubGlobal("fetch", fetch);
    const tickets = await new CoreTicketsHttpClient(baseUrl, () => NOW).mine(accessToken);
    expect(tickets).toMatchObject([{ id: ID, status: "waitlisted", cancellable: true }]);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.yildizskylab.com/v1/tickets/me?include=waitlisted,cancelled"),
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      }),
    );
  });

  it("calls an answer that is not a list a contract failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ tickets: [] })));
    expect((await failureOf(new CoreTicketsHttpClient(baseUrl).mine(accessToken))).failure).toBe("contract");
  });

  it("cancels the person's own ticket", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: ID, status: "cancelled" }));
    vi.stubGlobal("fetch", fetch);
    await new CoreTicketsHttpClient(baseUrl).cancel(accessToken, ID);
    expect(fetch).toHaveBeenCalledWith(
      new URL(`https://api.yildizskylab.com/v1/tickets/${ID}/cancel`),
      expect.objectContaining({ method: "POST", body: null }),
    );
  });

  it("maps core's refusals and never sends an id it does not take", async () => {
    const client = new CoreTicketsHttpClient(baseUrl);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(problem(409, { code: "ticket_cancel_closed" })));
    expect(await failureOf(client.cancel(accessToken, ID))).toMatchObject({ failure: "refused", code: "ticket_cancel_closed" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(problem(409, { code: "something_else" })));
    expect(await failureOf(client.cancel(accessToken, ID))).toMatchObject({ failure: "refused", code: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(problem(403)));
    expect((await failureOf(client.cancel(accessToken, ID))).failure).toBe("forbidden");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(problem(404)));
    expect((await failureOf(client.cancel(accessToken, ID))).failure).toBe("not_found");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect((await failureOf(client.cancel(accessToken, ID))).failure).toBe("unavailable");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await failureOf(client.cancel(accessToken, "../users/me"))).failure).toBe("invalid_input");
    expect(fetch).not.toHaveBeenCalled();
  });
});
