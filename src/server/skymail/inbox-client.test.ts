// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { SkyMailInboxError, SkyMailInboxHttpClient } from "@/server/skymail/inbox-client";

const base = new URL("https://api.yildizskylab.com/api/skymail");
const token = "server-held-user-token";
const item = {
  id: "5d0c2f9e-0000-4000-8000-000000000001",
  type: "event.ticket-created",
  title: "Kodlama Gecesi biletin hazır",
  summary: "",
  link: "/events/6f1c",
  created_at: "2026-10-25T09:00:00Z",
  seen_at: null,
  read_at: null,
  archived_at: null,
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function failureOf(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(SkyMailInboxError);
  return (error as SkyMailInboxError).failure;
}

afterEach(() => vi.unstubAllGlobals());

describe("SkyMail inbox HTTP client", () => {
  it("requires an HTTPS base without credentials, query or fragment and keeps its path", () => {
    for (const invalid of ["http://api.yildizskylab.com/api/skymail", "https://u:p@api.yildizskylab.com", "https://api.yildizskylab.com/?x=1"]) {
      expect(() => new SkyMailInboxHttpClient(new URL(invalid))).toThrow(/SkyMail API URL/);
    }
  });

  it("lists under the base path with the person's bearer, a page size and the cursor", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ items: [item], next_cursor: "next_1" }));
    vi.stubGlobal("fetch", fetch);

    const page = await new SkyMailInboxHttpClient(base).list(token, "cursor_1");

    expect(page.items.map(({ id }) => id)).toEqual([item.id]);
    expect(page.nextCursor).toBe("next_1");
    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe("https://api.yildizskylab.com/api/skymail/v1/me/inbox?limit=30&cursor=cursor_1");
    expect(init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`);
  });

  it("marks one item and all of them by POST", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ ...item, read_at: "2026-10-25T10:00:00Z" }))
      .mockResolvedValueOnce(json({ updated: 3 }))
      .mockResolvedValueOnce(json({ unseen: 0, unread: 2 }));
    vi.stubGlobal("fetch", fetch);
    const client = new SkyMailInboxHttpClient(base);

    await expect(client.mark(token, item.id, "read")).resolves.toMatchObject({ readAt: "2026-10-25T10:00:00Z" });
    await expect(client.markAll(token, "seen-all")).resolves.toBe(3);
    await expect(client.counts(token)).resolves.toEqual({ unseen: 0, unread: 2 });
    expect(fetch.mock.calls.map(([url, init]) => `${(init as RequestInit).method} ${(url as URL).pathname}`)).toEqual([
      `POST /api/skymail/v1/me/inbox/${item.id}/read`,
      "POST /api/skymail/v1/me/inbox/seen-all",
      "GET /api/skymail/v1/me/inbox/counts",
    ]);
  });

  it("maps refusals by status and fails closed on a body it does not know", async () => {
    const client = new SkyMailInboxHttpClient(base);
    for (const [status, failure] of [[401, "unauthorized"], [403, "forbidden"], [404, "not_found"], [400, "rejected"], [503, "unavailable"]] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: "x" }, status)));
      expect(await failureOf(client.counts(token))).toBe(failure);
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ unseen: "two" })));
    expect(await failureOf(client.counts(token))).toBe("contract");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    expect(await failureOf(client.counts(token))).toBe("unavailable");
  });

  it("sends nothing for an id, action or cursor it does not take", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new SkyMailInboxHttpClient(base);
    expect(await failureOf(client.mark(token, "../admin", "read"))).toBe("invalid_input");
    expect(await failureOf(client.mark(token, item.id, "delete" as never))).toBe("invalid_input");
    expect(await failureOf(client.list(token, "a b"))).toBe("invalid_input");
    expect(fetch).not.toHaveBeenCalled();
  });
});
