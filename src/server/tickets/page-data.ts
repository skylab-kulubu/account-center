import "server-only";

import { redirect } from "next/navigation";
import type { AccountTicket } from "@/lib/tickets";
import { currentAccountSession } from "@/server/access-gate/current-session";
import { getAuthServices } from "@/server/auth/services";
import { ticketsDisabledProblem, toTicketsProblem } from "@/server/tickets/problem";
import type { TicketsProblem } from "@/server/tickets/problem";
import { ticketsServiceFor } from "@/server/tickets/service";

export type TicketsPageData = {
  tickets: { status: "ready"; value: AccountTicket[] } | { status: "problem"; problem: TicketsProblem };
  csrfToken: string;
};

/** The person's tickets for the active session; core down, or off here, answers a problem the page shows. */
export async function loadTicketsPage(): Promise<TicketsPageData> {
  const services = getAuthServices();
  const authorization = await currentAccountSession();
  if (authorization.status === "blocked") redirect("/api/auth/session/end");
  if (authorization.status === "unavailable") redirect("/api/auth/unavailable");
  if (authorization.status !== "active") redirect("/login");
  const session = authorization.value.session;
  const csrfToken = services.sessions.csrfToken(session.id);
  const tickets = ticketsServiceFor(services);
  if (!tickets) return { tickets: { status: "problem", problem: ticketsDisabledProblem }, csrfToken };
  try {
    return { tickets: { status: "ready", value: await tickets.mine(session) }, csrfToken };
  } catch (error) {
    return { tickets: { status: "problem", problem: toTicketsProblem(error) }, csrfToken };
  }
}
