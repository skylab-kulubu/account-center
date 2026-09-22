import { AccountDataProblem } from "@/components/account-data-problem";
import {
  ApplicationsSection,
  PrivilegeSection,
  TeamsSection,
  TechnicalDetails,
} from "@/components/permissions-view";
import { AccountPageHeader } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";
import { loadPermissions } from "@/server/permissions/page-data";

const route = accountRoute("/permissions");

export const metadata = { title: route.documentTitle };

export default async function PermissionsPage() {
  const data = await loadPermissions();
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      {data.ok ? (
        <>
          <TeamsSection teams={data.value.teams} problem={data.teamsProblem} />
          <PrivilegeSection privileges={data.value.privileges} membership={data.value.membership} />
          <ApplicationsSection applications={data.value.applications} />
          <TechnicalDetails technical={data.value.technical} />
        </>
      ) : <AccountDataProblem problem={data.problem} retryHref="/permissions" />}
      <aside className="read-only-note" aria-label="Yetkileri değiştirme">
        Bu görünüm salt okunurdur; takım, rol ve uygulama yetkileri Superadmin’den yönetilir. Değişiklik için yönetim ekibiyle iletişime geç.
      </aside>
    </div>
  );
}
