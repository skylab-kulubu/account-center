import { SectionCard, SectionRow } from "@/components/section-card";
import { AccountPageHeader } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";
import { PRIVACY_NOTICE_URL } from "@/lib/communication-preferences";
import { CONSENT_TEXT_URL } from "@/lib/promotional-consent";

const route = accountRoute("/privacy");

export const metadata = { title: route.documentTitle };

/** Veri ve gizlilik: the mail the person receives, the published texts, and closing the account. */
export default function PrivacyPage() {
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      <SectionCard id="privacy-mail" title="Postalar">
        <SectionRow href="/communication-preferences" label="İletişim tercihleri" value="Duyuru, haber, tanıtım" />
      </SectionCard>
      <SectionCard id="privacy-texts" title="KVKK">
        <SectionRow href={PRIVACY_NOTICE_URL} label="KVKK aydınlatma metni" external />
        <SectionRow href={CONSENT_TEXT_URL} label="Açık rıza metni" external />
      </SectionCard>
      <SectionCard id="privacy-account" title="Hesap">
        <SectionRow href="/delete-account" label="Hesabı sil" tone="danger" />
      </SectionCard>
    </div>
  );
}
