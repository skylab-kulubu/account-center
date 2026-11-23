import { SectionCard, SectionRow } from "@/components/section-card";
import { AccountPageHeader } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";
import { appPreferenceLabel } from "@/lib/app-preferences";
import { loadAppPreferencesPage } from "@/server/app-preferences/page-data";
import { loadPermissions } from "@/server/permissions/page-data";

const route = accountRoute("/apps");

export const metadata = { title: route.documentTitle };

function list(names: readonly string[], empty: string) {
  return names.length ? names.join(", ") : empty;
}

/** Uygulamalar: what the person may do in SKY LAB's apps, and the view settings the apps keep. */
export default async function AppsPage() {
  const [permissions, preferences] = await Promise.all([loadPermissions(), loadAppPreferencesPage()]);
  const view = permissions.ok ? permissions.value : null;
  const saved = preferences.summary.status === "ready" ? preferences.summary.items : null;
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      <SectionCard id="apps-permissions" title="Yetkiler">
        <SectionRow href="/permissions" label="Takımlar" value={view ? list(view.teams.map(({ name }) => name), "Yok") : "Okunamadı"} />
        <SectionRow
          href="/permissions"
          label="Uygulama yetkileri"
          value={view ? list(view.applications.map(({ name }) => name), "Yok") : "Okunamadı"}
        />
      </SectionCard>
      <SectionCard id="apps-preferences" title="Uygulama ayarları">
        <SectionRow
          href="/app-preferences"
          label="Kayıtlı ayarlar"
          value={saved ? list(saved.map(({ app }) => appPreferenceLabel(app)), "Yok") : "Okunamadı"}
        />
      </SectionCard>
    </div>
  );
}
