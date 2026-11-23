import { AccountDataProblem } from "@/components/account-data-problem";
import { SectionCard, SectionRow } from "@/components/section-card";
import { AccountPageHeader } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";
import { loadOverview } from "@/server/keycloak-account/page-data";

const route = accountRoute("/personal-info");

export const metadata = { title: route.documentTitle };

/** Kişisel bilgiler: the identity, the e-mails and the club profile, each row leading to its page. */
export default async function PersonalInfoPage() {
  const data = await loadOverview();
  if (!data.ok) {
    return (
      <div className="page-stack">
        <AccountPageHeader route={route} />
        <AccountDataProblem problem={data.problem} retryHref={route.href} />
      </div>
    );
  }
  const { profile } = data.value;
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null;
  const school = profile.attributes.schoolEmail;
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      <SectionCard id="personal-identity" title="Kimlik">
        <SectionRow href="/identity" label="Ad" value={name ?? "Yok"} />
        <SectionRow href="/identity" label="Kullanıcı adı" value={profile.username ? `@${profile.username}` : "Yok"} />
        <SectionRow href="/identity" label="YTÜ hesabı" value={school ? "Bağlı" : "Bağlı değil"} />
      </SectionCard>
      <SectionCard id="personal-email" title="E-posta">
        <SectionRow href="/email" label="Okul e-postası" value={school ?? "Yok"} />
        <SectionRow href="/email" label="Kişisel e-posta" value={profile.attributes.personalEmail ?? "Eklenmedi"} />
        <SectionRow href="/email" label="Birincil e-posta" value={profile.email ?? "Yok"} />
      </SectionCard>
      <SectionCard id="personal-club" title="Kulüp profili">
        <SectionRow href="/club-profile" label="SKY numarası" value={profile.attributes.skyNumber ?? "Yok"} />
        <SectionRow href="/club-profile" label="Bölüm" value={profile.attributes.department ?? "Yok"} />
        <SectionRow href="/club-profile" label="Öğrenci kartı, fotoğraf, LinkedIn" />
      </SectionCard>
    </div>
  );
}
