import Link from "next/link";
import { AtSign } from "lucide-react";
import { CommunicationPreferencesEditor } from "@/components/communication-preferences-editor";
import { CommunicationPreferencesNotice } from "@/components/communication-preferences-notice";
import { PromotionalConsentSection } from "@/components/promotional-consent";
import { accountRoute } from "@/config/account-routes";
import { preferenceFocus } from "@/lib/communication-preferences";
import { loadCommunicationPreferencesPage } from "@/server/communication-preferences/page-data";
import { AccountPageHeader } from "@/components/settings";

const route = accountRoute("/communication-preferences");

export const metadata = { title: route.documentTitle };

export default async function CommunicationPreferencesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const focusCategory = preferenceFocus(parameters.kanal, parameters.kategori);
  const data = await loadCommunicationPreferencesPage();
  const state = data.preferences;

  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />


      {state.status === "ready" ? (
        <CommunicationPreferencesEditor csrfToken={data.csrfToken} focusCategory={focusCategory} initial={state.value} />
      ) : (
        <div className="settings-section">
          <CommunicationPreferencesNotice focusCategory={focusCategory} problem={state.problem} />
        </div>
      )}

      {data.promotional.status === "shown" ? (
        <PromotionalConsentSection
          csrfToken={data.csrfToken}
          initial={data.promotional.value}
          returnTo={route.href}
        />
      ) : null}

      <section className="settings-section" aria-labelledby="preferences-address-heading">
        <div className="settings-section__heading">
          <h2 id="preferences-address-heading">Postaların gittiği adres</h2>
        </div>
        <div className="preferences-address">
          <span className="settings-row__icon" aria-hidden="true">
            <AtSign size={19} />
          </span>
          <p>
            {data.primaryEmail
              ? <>Postalar birincil adresine gider: <strong>{data.primaryEmail}</strong>.</>
              : "Postalar birincil e-posta adresine gider."}{" "}
            Mezun olunca okul adresin kapanır; almaya devam etmek için kişisel adresini birincil yap.{" "}
            <Link href="/email">E-posta ayarları</Link>
          </p>
        </div>
      </section>
    </div>
  );
}
