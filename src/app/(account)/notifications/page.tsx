import { InboxList, InboxNotice } from "@/components/inbox-list";
import { AccountPageHeader } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";
import { loadInboxPage } from "@/server/inbox/page-data";

const route = accountRoute("/notifications");

export const metadata = { title: route.documentTitle };

export default async function NotificationsPage() {
  const data = await loadInboxPage();
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      {data.inbox.status === "ready" ? (
        <InboxList csrfToken={data.csrfToken} initial={data.inbox.value} />
      ) : (
        <InboxNotice problem={data.inbox.problem} />
      )}
    </div>
  );
}
