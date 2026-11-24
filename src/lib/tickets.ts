/**
 * The person's own tickets ("Biletlerim"), as core answers them on
 * `GET /v1/tickets/me?include=waitlisted,cancelled` (core
 * `docs/ticket-cancellation.md`, `docs/ticket-page.md`). Shared by the BFF,
 * which parses core's answer fail-closed, and the page, which shows it.
 * The holder cancels their own ticket with `POST /v1/tickets/{id}/cancel`
 * (kontenjan-iptal-hatirlatma 03): an active ticket until its Event starts,
 * a waitlisted one until it ends.
 */

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRINTABLE = /^[^\p{Cc}]*$/u;
const DAY_MS = 24 * 60 * 60 * 1_000;

export type AccountTicketStatus = "active" | "waitlisted" | "cancelled";

export type AccountTicket = {
  id: string;
  status: AccountTicketStatus;
  /** The code printed under the QR; "" when core sends none. */
  code: string;
  /** The ticket page (`https://yildizskylab.com/bilet/…`), or null. */
  ticketUrl: string | null;
  eventName: string;
  eventStart: string | null;
  eventEnd: string | null;
  location: string;
  /** The Event was cancelled by its organizers. */
  eventCancelled: boolean;
  /** Whether the holder may cancel it now. */
  cancellable: boolean;
};

export function isTicketId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" && PRINTABLE.test(value) ? value.trim() : "";
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && RFC3339.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/** When the Event is over: its end, else a day after its start (ADR 0066); never without a date. */
export function eventEndsAt(ticket: Pick<AccountTicket, "eventStart" | "eventEnd">): number | null {
  const end = ticket.eventEnd ? Date.parse(ticket.eventEnd) : NaN;
  if (Number.isFinite(end)) return end;
  const start = ticket.eventStart ? Date.parse(ticket.eventStart) : NaN;
  return Number.isFinite(start) ? start + DAY_MS : null;
}

export function eventEnded(ticket: Pick<AccountTicket, "eventStart" | "eventEnd">, now: number): boolean {
  const end = eventEndsAt(ticket);
  return end !== null && end <= now;
}

/**
 * Core's rule (`ticket.HolderCancellable`) when its answer does not say: not
 * on a cancelled or ended Event; a waitlisted ticket any time before that,
 * an active one until the Event starts, never one with an entry.
 */
export function holderMayCancel(
  ticket: Pick<AccountTicket, "status" | "eventStart" | "eventEnd" | "eventCancelled">,
  checkedIn: boolean,
  now: number,
): boolean {
  if (ticket.eventCancelled || eventEnded(ticket, now)) return false;
  if (ticket.status === "waitlisted") return true;
  if (ticket.status !== "active" || checkedIn) return false;
  const start = ticket.eventStart ? Date.parse(ticket.eventStart) : NaN;
  return !Number.isFinite(start) || start > now;
}

/** One ticket of core's answer; null when it is not one. Members core may add later are ignored. */
export function parseTicket(value: unknown, now: number): AccountTicket | null {
  if (!isRecord(value) || !isTicketId(value.id) || !isRecord(value.event)) return null;
  const status = value.status === undefined ? "active" : value.status;
  if (status !== "active" && status !== "waitlisted" && status !== "cancelled") return null;
  const event = value.event;
  const eventName = text(event.name);
  if (!eventName) return null;
  const ticket: AccountTicket = {
    id: value.id,
    status,
    code: text(value.code),
    ticketUrl: httpsUrl(value.ticketUrl),
    eventName,
    eventStart: timestamp(event.startDate),
    eventEnd: timestamp(event.endDate),
    location: text(event.location),
    eventCancelled: event.status === "cancelled",
    cancellable: false,
  };
  const checkedIn = Array.isArray(value.checkIns) && value.checkIns.length > 0;
  ticket.cancellable =
    typeof value.cancellable === "boolean" ? value.cancellable : holderMayCancel(ticket, checkedIn, now);
  return ticket;
}

/** Core's list; null when the answer is not a list. Rows that are not tickets are left out. */
export function parseTickets(value: unknown, now: number): AccountTicket[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((row) => parseTicket(row, now)).filter((ticket): ticket is AccountTicket => ticket !== null);
}

/**
 * Upcoming: an active or waitlisted ticket of an Event that is not over or
 * cancelled, soonest first. Past: everything else, the latest first.
 */
export function groupTickets(tickets: readonly AccountTicket[], now: number) {
  const startOf = (ticket: AccountTicket) => (ticket.eventStart ? Date.parse(ticket.eventStart) : Number.POSITIVE_INFINITY);
  const upcoming: AccountTicket[] = [];
  const past: AccountTicket[] = [];
  for (const ticket of tickets) {
    const open = ticket.status !== "cancelled" && !ticket.eventCancelled && !eventEnded(ticket, now);
    (open ? upcoming : past).push(ticket);
  }
  upcoming.sort((a, b) => startOf(a) - startOf(b));
  past.sort((a, b) => (b.eventStart ? Date.parse(b.eventStart) : 0) - (a.eventStart ? Date.parse(a.eventStart) : 0));
  return { upcoming, past };
}

/** What the card says about the ticket; `ended`: its Event is over. */
export function ticketStatusLabel(ticket: Pick<AccountTicket, "status" | "eventCancelled">, ended = false): string {
  if (ticket.status === "cancelled") return "İptal edildi";
  if (ticket.eventCancelled) return "Etkinlik iptal edildi";
  if (ended) return "Etkinlik bitti";
  return ticket.status === "waitlisted" ? "Bekleme listesinde" : "Etkin";
}

/** Core's refusal codes of the holder's cancel. */
export const TICKET_CANCEL_CODES = [
  "ticket_cancel_closed",
  "ticket_checked_in",
  "ticket_in_competition",
  "event_ended",
] as const;
export type TicketCancelCode = (typeof TICKET_CANCEL_CODES)[number];

export function isTicketCancelCode(value: unknown): value is TicketCancelCode {
  return typeof value === "string" && (TICKET_CANCEL_CODES as readonly string[]).includes(value);
}
