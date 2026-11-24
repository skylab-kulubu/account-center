"use client";

import { ExternalLink, Ticket, TicketX } from "lucide-react";
import { Button, ConfirmDialog, ListItem, ListPanel, Notice } from "@skylab-kulubu/skylcn-ui";
import Link from "next/link";
import { useMemo, useState } from "react";
import { StatusBadge } from "@/components/settings";
import { groupTickets, ticketStatusLabel } from "@/lib/tickets";
import type { AccountTicket } from "@/lib/tickets";

const ROUTE = "/api/account/tickets";

const DAY = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Istanbul",
});

function when(value: string | null) {
  if (!value) return "Tarihsiz";
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? "Tarihsiz" : DAY.format(at);
}

type Problem = { title: string; detail: string; status: number; code?: string };

/** Why the tickets are not shown: off in this environment (no core), or a failure worth a retry or a fresh login. */
export function TicketsNotice({ problem }: { problem: Problem }) {
  const off = problem.code === "tickets_disabled";
  return (
    <Notice
      action={off ? undefined : problem.status === 401 ? (
        <Button render={<Link href="/login?returnTo=%2Ftickets" />} size="sm" variant="link">Yeniden giriş yap</Button>
      ) : (
        <Button render={<Link href="/tickets" />} size="sm" variant="link">Yeniden dene</Button>
      )}
      title={problem.title}
      tone={off ? "info" : "warning"}
    >
      {problem.detail}
    </Notice>
  );
}

class CancelFailure extends Error {
  constructor(readonly problem: Problem | null) {
    super("Ticket cancel failed.");
  }
}

async function cancel(ticket: AccountTicket, csrfToken: string) {
  const response = await fetch(`${ROUTE}/${encodeURIComponent(ticket.id)}/cancel`, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "x-csrf-token": csrfToken },
  });
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as Problem | null;
  throw new CancelFailure(body && typeof body.title === "string" ? body : null);
}

function failureMessage(error: unknown) {
  const problem = error instanceof CancelFailure ? error.problem : null;
  return problem ? `${problem.title}. ${problem.detail}` : "Bilet iptal edilemedi. Biraz sonra yeniden dene.";
}

function TicketRow({ ticket, onCancel }: { ticket: AccountTicket; onCancel?: (ticket: AccountTicket) => void }) {
  const tone = ticket.status === "active" && !ticket.eventCancelled ? "positive" : ticket.status === "waitlisted" ? "warning" : "neutral";
  return (
    <ListItem
      className="tickets__item"
      title={ticket.eventName}
      subtitle={
        <>
          <span>{when(ticket.eventStart)}{ticket.location ? ` · ${ticket.location}` : ""}</span>
          {ticket.code ? <span className="tickets__code">{ticket.code}</span> : null}
        </>
      }
      leading={<StatusBadge tone={tone}>{ticketStatusLabel(ticket)}</StatusBadge>}
      trailing={
        <span className="tickets__actions">
          {ticket.ticketUrl ? (
            <Button
              render={<a href={ticket.ticketUrl} rel="noreferrer" target="_blank" />}
              size="sm"
              variant="ghost"
              aria-label={`${ticket.eventName}: bileti aç`}
            >
              <ExternalLink aria-hidden="true" />
              Bileti aç
            </Button>
          ) : null}
          {onCancel && ticket.cancellable ? (
            <Button size="sm" type="button" variant="ghost" onClick={() => onCancel(ticket)}>
              <TicketX aria-hidden="true" />
              {ticket.status === "waitlisted" ? "Listeden çık" : "İptal et"}
            </Button>
          ) : null}
        </span>
      }
    />
  );
}

/**
 * The person's tickets: upcoming (soonest first, with "İptal et" or "Listeden
 * çık" while core allows it) and past (cancelled and over, no actions). Each
 * opens its ticket page on the club site.
 */
export function TicketList({ initial, csrfToken }: { initial: AccountTicket[]; csrfToken: string }) {
  const [tickets, setTickets] = useState(initial);
  const [asking, setAsking] = useState<AccountTicket | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // The moment the page opened splits upcoming from past; a ticket does not move while it is open
  const [now] = useState(() => Date.now());
  const { upcoming, past } = useMemo(() => groupTickets(tickets, now), [tickets, now]);
  const waitlisted = asking?.status === "waitlisted";

  return (
    <section className="settings-section tickets" aria-label="Biletler">
      <div aria-live="polite">
        {done ? <Notice tone="success" role={undefined}>{done}</Notice> : null}
      </div>

      <h2 className="tickets__heading">Yaklaşan</h2>
      <ListPanel
        emptyIcon={Ticket}
        framed
        status={upcoming.length === 0 ? { kind: "empty", message: "Yaklaşan biletin yok." } : { kind: "ready" }}
      >
        {upcoming.map((ticket) => (
          <TicketRow key={ticket.id} onCancel={setAsking} ticket={ticket} />
        ))}
      </ListPanel>

      {past.length > 0 ? (
        <>
          <h2 className="tickets__heading">Geçmiş</h2>
          <ListPanel framed status={{ kind: "ready" }}>
            {past.map((ticket) => (
              <TicketRow key={ticket.id} ticket={ticket} />
            ))}
          </ListPanel>
        </>
      ) : null}

      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        title={waitlisted ? "Bekleme listesinden çıkılsın mı?" : "Bilet iptal edilsin mi?"}
        description={asking ? `${asking.eventName} · ${when(asking.eventStart)}` : undefined}
        consequences={[
          waitlisted ? "Sıran silinir." : "Biletin iptal edilir, QR kodu kapıda geçmez.",
          "Geri almak için düzenleyene yazman gerekir.",
        ]}
        actionLabel={waitlisted ? "Listeden çık" : "Bileti iptal et"}
        destructive
        failureMessage={failureMessage}
        onAction={async () => {
          if (!asking) return;
          const target = asking;
          await cancel(target, csrfToken);
          setTickets((current) => current.map((row) => (row.id === target.id ? { ...row, status: "cancelled", cancellable: false } : row)));
          setDone(target.status === "waitlisted" ? "Bekleme listesinden çıktın." : "Bilet iptal edildi.");
        }}
      />
    </section>
  );
}
