import { TicketList, TicketsNotice } from "@/components/ticket-list";
import { accountRoute } from "@/config/account-routes";
import { AccountPageHeader } from "@/components/settings";
import { loadTicketsPage } from "@/server/tickets/page-data";

const route = accountRoute("/tickets");

export const metadata = { title: route.documentTitle };

export default async function TicketsPage() {
  const data = await loadTicketsPage();
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      {data.tickets.status === "ready" ? (
        <TicketList csrfToken={data.csrfToken} initial={data.tickets.value} />
      ) : (
        <TicketsNotice problem={data.tickets.problem} />
      )}
    </div>
  );
}
