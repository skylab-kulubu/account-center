import { AccountDataProblem } from "@/components/account-data-problem";
import { HomeEmailDeliveryWarning } from "@/components/email-delivery-warning";
import { HomePrimaryEmailNudge } from "@/components/primary-email-nudge";
import { Overview } from "@/components/overview";
import { accountRoute } from "@/config/account-routes";
import { loadProfilePictureUrl } from "@/server/account-shell/identity";
import { loadOverview } from "@/server/keycloak-account/page-data";

const route = accountRoute("/");

export const metadata = { title: route.documentTitle };

export default async function OverviewPage() {
  // The photo comes from the same core read the account menu makes (shared per render).
  const [data, pictureUrl] = await Promise.all([loadOverview(), loadProfilePictureUrl()]);
  if (!data.ok) {
    return (
      <div className="page-stack">
        <h1 className="sr-only">{route.title}</h1>
        <AccountDataProblem problem={data.problem} retryHref="/" />
        <HomeEmailDeliveryWarning />
        <HomePrimaryEmailNudge />
      </div>
    );
  }
  return <Overview overview={data.value} pictureUrl={pictureUrl} />;
}
