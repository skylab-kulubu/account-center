import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TicketList, TicketsNotice } from "@/components/ticket-list";
import type { AccountTicket } from "@/lib/tickets";

const base: AccountTicket = {
  id: "5d0c2f9e-0000-4000-8000-000000000001",
  status: "active",
  code: "K7M2-QX9F",
  ticketUrl: "https://yildizskylab.com/bilet/K7M2QXZFABCDEFGHJKLMNPQRST",
  eventName: "Yapay Zekâ Atölyesi",
  eventStart: "2099-12-03T15:00:00Z",
  eventEnd: "2099-12-03T18:00:00Z",
  location: "B-112",
  eventCancelled: false,
  cancellable: true,
};
const waiting: AccountTicket = { ...base, id: "5d0c2f9e-0000-4000-8000-000000000002", status: "waitlisted", eventName: "Hackathon", code: "" };
const past: AccountTicket = {
  ...base,
  id: "5d0c2f9e-0000-4000-8000-000000000003",
  eventName: "Geçen ayın atölyesi",
  eventStart: "2020-01-03T15:00:00Z",
  eventEnd: "2020-01-03T18:00:00Z",
  cancellable: false,
};

let fetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TicketList", () => {
  it("lists upcoming tickets with their actions and past ones without", () => {
    render(<TicketList csrfToken="csrf" initial={[past, waiting, base]} />);
    expect(screen.getByRole("heading", { name: "Yaklaşan" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Geçmiş" })).toBeInTheDocument();
    expect(screen.getByText("Bekleme listesinde")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Listeden çık/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /İptal et/ })).toHaveLength(1);
    const open = screen.getByRole("link", { name: "Yapay Zekâ Atölyesi: bileti aç" });
    expect(open).toHaveAttribute("href", base.ticketUrl);
    expect(screen.getAllByText("K7M2-QX9F", { selector: ".tickets__code" })).toHaveLength(2);
  });

  it("says when there is no ticket to come", () => {
    render(<TicketList csrfToken="csrf" initial={[]} />);
    expect(screen.getByText("Yaklaşan biletin yok.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Geçmiş" })).toBeNull();
  });

  it("cancels after asking, with the CSRF proof, and moves the ticket under past", async () => {
    render(<TicketList csrfToken="csrf" initial={[base]} />);
    fireEvent.click(screen.getByRole("button", { name: /İptal et/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Bilet iptal edilsin mi?")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Bileti iptal et" }));
    await waitFor(() => expect(screen.getByText("Bilet iptal edildi.")).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith(
      `/api/account/tickets/${base.id}/cancel`,
      expect.objectContaining({ method: "POST", headers: { "x-csrf-token": "csrf" } }),
    );
    expect(screen.getByText("İptal edildi")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /İptal et/ })).toBeNull();
  });

  it("says why core refused, inside the question", async () => {
    fetch.mockResolvedValue(new Response(JSON.stringify({ title: "Etkinlik başladı", detail: "Bilet artık iptal edilemez.", status: 409 }), {
      status: 409,
      headers: { "content-type": "application/problem+json" },
    }));
    render(<TicketList csrfToken="csrf" initial={[base]} />);
    fireEvent.click(screen.getByRole("button", { name: /İptal et/ }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Bileti iptal et" }));
    expect(await within(dialog).findByText("Etkinlik başladı. Bilet artık iptal edilemez.")).toBeInTheDocument();
  });
});

describe("TicketsNotice", () => {
  it("offers a retry, or nothing when the page is off here", () => {
    const { unmount } = render(<TicketsNotice problem={{ title: "Biletlere şu anda ulaşılamıyor", detail: "x", status: 503 }} />);
    expect(screen.getByRole("link", { name: "Yeniden dene" })).toHaveAttribute("href", "/tickets");
    unmount();
    render(<TicketsNotice problem={{ title: "Biletler bu ortamda kapalı", detail: "x", status: 503, code: "tickets_disabled" }} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
