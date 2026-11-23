import { SectionCard, SectionRow } from "@/components/section-card";
import { SecurityManager } from "@/components/security-manager";
import { AccountPageHeader } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";
import { loadOverview } from "@/server/keycloak-account/page-data";

const route = accountRoute("/security");

export const metadata = { title: route.documentTitle };

/**
 * Güvenlik, as on Google Account's Security page: the sign-in methods, the devices and the
 * linked accounts (the status card sits on Ana sayfa). The credential inventory and every change run in the browser against
 * `/api/account/security/*` behind Sudo mode, so the person never leaves `my.` for a password,
 * passkey or verification-app change. When the profile cannot be read, the linked account's state
 * is left out and the rest still shows.
 */
export default async function SecurityPage() {
  const overview = await loadOverview();
  const school = overview.ok ? overview.value.profile.attributes.schoolEmail : null;
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      <SecurityManager />
      <SectionCard id="security-devices" title="Cihazlar">
        <SectionRow href="/sessions" label="Oturum açık cihazlar" />
      </SectionCard>
      <SectionCard id="security-linked" title="Bağlı hesaplar">
        <SectionRow href="/identity" label="YTÜ Microsoft hesabı" value={overview.ok ? (school ? "Bağlı" : "Bağlı değil") : undefined} />
      </SectionCard>
    </div>
  );
}
