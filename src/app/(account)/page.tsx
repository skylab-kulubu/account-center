import { AccountDataProblem } from "@/components/account-data-problem";
import { Overview } from "@/components/overview";
import { accountRoute } from "@/config/account-routes";
import { loadOverview } from "@/server/keycloak-account/page-data";

const route = accountRoute("/");

export const metadata = { title: route.documentTitle };

export default async function OverviewPage() {
  const data = await loadOverview();
  if (!data.ok) {
    return (
      <div className="page-stack">
        <h1 className="sr-only">{route.title}</h1>
        <AccountDataProblem problem={data.problem} retryHref="/" />
      </div>
    );
  }
  return <Overview overview={data.value} />;
}
