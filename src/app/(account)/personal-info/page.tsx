import { AccountDataProblem } from "@/components/account-data-problem";
import { SectionCard, SectionRow } from "@/components/section-card";
import { AccountPageHeader } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";
import { loadOverview } from "@/server/keycloak-account/page-data";

const route = accountRoute("/personal-info");

export const metadata = { title: route.documentTitle };

/**
 * Kişisel bilgiler: the identity, the e-mails and the club profile, each row leading to its page.
 * When the profile cannot be read the rows still lead there, without their values.
 */
export default async function PersonalInfoPage() {
  const data = await loadOverview();
  const profile = data.ok ? data.value.profile : null;
  const name = profile ? [profile.firstName, profile.lastName].filter(Boolean).join(" ") || "Yok" : undefined;
  const school = profile?.attributes.schoolEmail ?? null;
  const value = (text: string | null | undefined, empty: string) => (profile ? text ?? empty : undefined);
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      {!data.ok ? <AccountDataProblem problem={data.problem} retryHref={route.href} /> : null}
      <SectionCard id="personal-identity" title="Kimlik">
        <SectionRow href="/identity" label="Ad" value={name} />
        <SectionRow href="/identity" label="Kullanıcı adı" value={value(profile?.username ? `@${profile.username}` : null, "Yok")} />
        <SectionRow href="/identity" label="YTÜ hesabı" value={profile ? (school ? "Bağlı" : "Bağlı değil") : undefined} />
      </SectionCard>
      <SectionCard id="personal-email" title="E-posta">
        <SectionRow href="/email" label="Okul e-postası" value={value(school, "Yok")} />
        <SectionRow href="/email" label="Kişisel e-posta" value={value(profile?.attributes.personalEmail, "Eklenmedi")} />
        <SectionRow href="/email" label="Birincil e-posta" value={value(profile?.email, "Yok")} />
      </SectionCard>
      <SectionCard id="personal-club" title="Kulüp profili">
        <SectionRow href="/club-profile" label="SKY numarası" value={value(profile?.attributes.skyNumber, "Yok")} />
        <SectionRow href="/club-profile" label="Bölüm" value={value(profile?.attributes.department, "Yok")} />
        <SectionRow href="/club-profile" label="Öğrenci kartı, fotoğraf, LinkedIn" />
      </SectionCard>
    </div>
  );
}
