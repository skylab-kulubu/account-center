import { AccountDataProblem } from "@/components/account-data-problem";
import { AppPreferencesList } from "@/components/app-preferences-list";
import { AccountPageHeader } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";
import { loadAppPreferencesPage } from "@/server/app-preferences/page-data";

const route = accountRoute("/app-preferences");

export const metadata = { title: route.documentTitle };

export default async function AppPreferencesPage() {
  const data = await loadAppPreferencesPage();
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      {data.summary.status === "ready"
        ? <AppPreferencesList csrfToken={data.csrfToken} initial={data.summary.items} />
        : <AccountDataProblem problem={data.summary.problem} retryHref={route.href} />}
    </div>
  );
}
