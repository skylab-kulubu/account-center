import { describe, expect, it } from "vitest";
import { groupTickets, holderMayCancel, parseTicket, parseTickets, ticketStatusLabel } from "@/lib/tickets";

const NOW = Date.parse("2026-12-01T12:00:00Z");
const ID = "5d0c2f9e-0000-4000-8000-000000000001";

const row = (extra: Record<string, unknown> = {}, event: Record<string, unknown> = {}) => ({
  id: ID,
  eventId: "6f1c0000-0000-4000-8000-000000000002",
  status: "active",
  code: "K7M2-QX9F",
  ticketUrl: "https://yildizskylab.com/bilet/K7M2QXZFABCDEFGHJKLMNPQRST",
  checkIns: [],
  event: {
    id: "6f1c0000-0000-4000-8000-000000000002",
    name: "Yapay Zekâ Atölyesi",
    startDate: "2026-12-03T15:00:00Z",
    endDate: "2026-12-03T18:00:00Z",
    location: "B-112",
    status: "published",
    ...event,
  },
  ...extra,
});

describe("tickets", () => {
  it("reads core's ticket and ignores what it does not know", () => {
    expect(parseTicket(row({ qrToken: "x" }), NOW)).toEqual({
      id: ID,
      status: "active",
      code: "K7M2-QX9F",
      ticketUrl: "https://yildizskylab.com/bilet/K7M2QXZFABCDEFGHJKLMNPQRST",
      eventName: "Yapay Zekâ Atölyesi",
      eventStart: "2026-12-03T15:00:00Z",
      eventEnd: "2026-12-03T18:00:00Z",
      location: "B-112",
      eventCancelled: false,
      cancellable: true,
    });
  });

  it("refuses rows that are not tickets and keeps the rest", () => {
    expect(parseTickets({}, NOW)).toBeNull();
    expect(parseTickets([row(), row({ id: "x" }), row({ status: "lost" }), row({}, { name: "" })], NOW)).toHaveLength(1);
    expect(parseTicket(row({ ticketUrl: "http://yildizskylab.com/bilet/x" }), NOW)?.ticketUrl).toBeNull();
    // An older core sends no status: the ticket is active
    expect(parseTicket(row({ status: undefined }), NOW)?.status).toBe("active");
  });

  it("follows core's cancellable when it says, else core's rule", () => {
    expect(parseTicket(row({ cancellable: false }), NOW)?.cancellable).toBe(false);
    const base = { status: "active" as const, eventStart: "2026-12-03T15:00:00Z", eventEnd: "2026-12-03T18:00:00Z", eventCancelled: false };
    expect(holderMayCancel(base, false, NOW)).toBe(true);
    expect(holderMayCancel(base, true, NOW)).toBe(false);
    // Started: active no, waitlisted yes until the end
    const started = Date.parse("2026-12-03T16:00:00Z");
    expect(holderMayCancel(base, false, started)).toBe(false);
    expect(holderMayCancel({ ...base, status: "waitlisted" }, false, started)).toBe(true);
    expect(holderMayCancel({ ...base, status: "waitlisted" }, false, Date.parse("2026-12-03T18:00:00Z"))).toBe(false);
    expect(holderMayCancel({ ...base, eventCancelled: true }, false, NOW)).toBe(false);
    expect(holderMayCancel({ ...base, status: "cancelled" }, false, NOW)).toBe(false);
    // No date: never starts, never ends
    expect(holderMayCancel({ ...base, eventStart: null, eventEnd: null }, false, NOW)).toBe(true);
  });

  it("puts upcoming tickets first by date and the rest under past", () => {
    const tickets = parseTickets(
      [
        row({ id: "00000000-0000-4000-8000-000000000001" }, { name: "Sonra", startDate: "2026-12-10T15:00:00Z", endDate: undefined }),
        row({ id: "00000000-0000-4000-8000-000000000002", status: "waitlisted" }, { name: "Önce" }),
        row({ id: "00000000-0000-4000-8000-000000000003", status: "cancelled" }, { name: "İptal" }),
        row({ id: "00000000-0000-4000-8000-000000000004" }, { name: "Bitti", startDate: "2026-11-01T15:00:00Z", endDate: "2026-11-01T18:00:00Z" }),
        row({ id: "00000000-0000-4000-8000-000000000005" }, { name: "Etkinlik iptal", status: "cancelled" }),
      ],
      NOW,
    )!;
    const { upcoming, past } = groupTickets(tickets, NOW);
    expect(upcoming.map(({ eventName }) => eventName)).toEqual(["Önce", "Sonra"]);
    expect(past.map(({ eventName }) => eventName).sort()).toEqual(["Bitti", "Etkinlik iptal", "İptal"].sort());
    expect(past.every(({ cancellable }) => !cancellable)).toBe(true);
  });

  it("says the status in plain words", () => {
    expect(ticketStatusLabel({ status: "active", eventCancelled: false })).toBe("Etkin");
    expect(ticketStatusLabel({ status: "waitlisted", eventCancelled: false })).toBe("Bekleme listesinde");
    expect(ticketStatusLabel({ status: "cancelled", eventCancelled: false })).toBe("İptal edildi");
    expect(ticketStatusLabel({ status: "active", eventCancelled: true })).toBe("Etkinlik iptal edildi");
    expect(ticketStatusLabel({ status: "active", eventCancelled: false }, true)).toBe("Etkinlik bitti");
  });
});
