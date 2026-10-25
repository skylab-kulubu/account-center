import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxList, InboxNotice } from "@/components/inbox-list";
import type { InboxItem } from "@/lib/inbox";

const unread: InboxItem = {
  id: "5d0c2f9e-0000-4000-8000-000000000001",
  type: "event.ticket-created",
  title: "Kodlama Gecesi biletin hazır",
  summary: "10.11.2026 18:30 · D-Blok",
  link: "/events/6f1c",
  createdAt: "2026-10-25T09:00:00Z",
  seenAt: null,
  readAt: null,
};
const read: InboxItem = {
  ...unread,
  id: "5d0c2f9e-0000-4000-8000-000000000002",
  type: "core.certificate",
  title: "Katılım sertifikan hazır",
  summary: "",
  link: "https://yildizskylab.com/sertifika/AB12",
  readAt: "2026-10-24T09:00:00Z",
  seenAt: "2026-10-24T09:00:00Z",
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetch = vi.fn().mockImplementation(async (url: string) => {
    if (url.endsWith("/read")) return respond({ item: { ...unread, readAt: "2026-10-25T10:00:00Z" } });
    if (url.endsWith("/archive")) return respond({ item: unread });
    if (url.endsWith("/read-all") || url.endsWith("/seen-all")) return respond({ updated: 1 });
    return respond({ page: { items: [{ ...read, id: "5d0c2f9e-0000-4000-8000-000000000003", title: "Geçen haftanın bildirimi" }], nextCursor: null } });
  });
  vi.stubGlobal("fetch", fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const posts = () => fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST").map(([url]) => url);

describe("InboxList", () => {
  it("marks everything seen on open, with the CSRF proof, and says so to the shell", async () => {
    const seen = vi.fn();
    window.addEventListener("account-center:inbox-seen", seen);
    render(<InboxList csrfToken="csrf-proof" initial={{ items: [unread, read], nextCursor: null }} />);
    await waitFor(() => expect(seen).toHaveBeenCalled());
    window.removeEventListener("account-center:inbox-seen", seen);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/account/inbox/seen-all");
    expect(init.headers).toMatchObject({ "x-csrf-token": "csrf-proof" });
  });

  it("shows unread items marked, opens only yildizskylab.com links and keeps the retention note", () => {
    render(<InboxList csrfToken="csrf-proof" initial={{ items: [unread, read], nextCursor: null }} />);
    expect(screen.getByText("Okunmadı")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Katılım sertifikan hazır/ })).toHaveAttribute("href", "https://yildizskylab.com/sertifika/AB12");
    // sky-app's in-app path has no web page: no link.
    expect(screen.queryByRole("link", { name: /Kodlama Gecesi/ })).toBeNull();
    expect(screen.getByText("Bildirimler 90 gün tutulur.")).toBeInTheDocument();
  });

  it("marks one read, archives one and marks all read", async () => {
    render(<InboxList csrfToken="csrf-proof" initial={{ items: [unread, read], nextCursor: null }} />);
    fireEvent.click(screen.getByRole("button", { name: "Kodlama Gecesi biletin hazır: okundu yap" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Kodlama Gecesi biletin hazır: okunmadı yap" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Katılım sertifikan hazır: arşivle" }));
    await waitFor(() => expect(screen.queryByText("Katılım sertifikan hazır")).toBeNull());

    expect(screen.getByRole("button", { name: /Hepsini okundu yap/ })).toBeDisabled();
    expect(posts()).toEqual([
      "/api/account/inbox/seen-all",
      `/api/account/inbox/items/${unread.id}/read`,
      `/api/account/inbox/items/${read.id}/archive`,
    ]);
  });

  it("marks all read in one request", async () => {
    render(<InboxList csrfToken="csrf-proof" initial={{ items: [unread], nextCursor: null }} />);
    fireEvent.click(screen.getByRole("button", { name: /Hepsini okundu yap/ }));
    await waitFor(() => expect(screen.queryByText("Okunmadı")).toBeNull());
    expect(posts()).toContain("/api/account/inbox/read-all");
  });

  it("loads older items by the cursor", async () => {
    render(<InboxList csrfToken="csrf-proof" initial={{ items: [unread], nextCursor: "next_1" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Daha eski bildirimler" }));
    expect((await screen.findAllByText("Geçen haftanın bildirimi")).length).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledWith("/api/account/inbox?cursor=next_1", expect.anything());
    expect(screen.queryByRole("button", { name: "Daha eski bildirimler" })).toBeNull();
  });

  it("says a failure without losing the list", async () => {
    render(<InboxList csrfToken="csrf-proof" initial={{ items: [unread], nextCursor: null }} />);
    await act(async () => {});
    fetch.mockResolvedValueOnce(respond({ title: "x" }, 503));
    fireEvent.click(screen.getByRole("button", { name: "Kodlama Gecesi biletin hazır: okundu yap" }));
    expect(await screen.findByText(/İşlem tamamlanamadı/)).toBeInTheDocument();
    expect(screen.getByText("Kodlama Gecesi biletin hazır")).toBeInTheDocument();
  });

  it("is empty with the sentence the ticket asks for", () => {
    render(<InboxList csrfToken="csrf-proof" initial={{ items: [], nextCursor: null }} />);
    expect(screen.getByText("Henüz bildirimin yok.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Hepsini okundu yap/ })).toBeNull();
  });
});

describe("InboxNotice", () => {
  it("says the inbox is off without a retry, and offers a login on a 401", () => {
    const { container } = render(<InboxNotice problem={{ title: "Bildirimler bu ortamda kapalı", detail: "x", status: 503, code: "inbox_disabled" }} />);
    expect(within(container).queryByRole("link")).toBeNull();
    cleanup();
    render(<InboxNotice problem={{ title: "Yeniden giriş", detail: "x", status: 401 }} />);
    expect(screen.getByRole("link", { name: "Yeniden giriş yap" })).toHaveAttribute("href", "/login?returnTo=%2Fnotifications");
  });

  it("says a session whose token does not name SkyMail yet sees the inbox after its next login", () => {
    render(<InboxNotice problem={{ title: "Bildirimler bu oturumda henüz açık değil", detail: "x", status: 503, code: "inbox_not_enabled" }} />);
    expect(screen.getByText("Bildirimler bu oturumda henüz açık değil")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Yeniden giriş yap" })).toHaveAttribute("href", "/login?returnTo=%2Fnotifications");
  });
});
