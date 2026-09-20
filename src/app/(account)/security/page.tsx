import { Fingerprint, KeyRound, ShieldCheck, Smartphone } from "lucide-react";
import { AccountActionNotice } from "@/components/account-action-notice";
import { AccountDataProblem } from "@/components/account-data-problem";
import { SecurityActionForm } from "@/components/security-action-form";
import { AccountPageHeader, SettingsGroup, SettingsRow, StatusBadge } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";
import { loadSecurity } from "@/server/keycloak-account/page-data";

const route = accountRoute("/security");

export const metadata = { title: route.documentTitle };

function formattedDate(value: string | null) {
  if (!value) return "Eklenme tarihi bilinmiyor";
  return `Eklenme: ${new Intl.DateTimeFormat("tr-TR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value))}`;
}

export default async function SecurityPage({
  searchParams,
}: {
  searchParams?: Promise<{ result?: string }>;
}) {
  const feedback = await (searchParams ?? Promise.resolve({ result: undefined }));
  const data = await loadSecurity(feedback.result);
  const actionResult = data.ok ? data.value.actionResult : data.actionResult;
  const actionCsrfToken = data.ok ? data.value.actionCsrfToken : data.actionCsrfToken;
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      <AccountActionNotice
        result={actionResult}
        reference={actionResult ? feedback.result : undefined}
        csrfToken={actionCsrfToken}
      />
      {data.ok ? (
        <>
          <SettingsGroup title="Giriş yöntemleri" description="Yeni yöntem ekleme ve şifre değişikliği güvenli Keycloak akışında tamamlanır.">
            <SettingsRow
              icon={<KeyRound aria-hidden="true" size={19} />}
              title="Şifre"
              description="Şifreni değiştirmeden önce kimliğini yeniden doğrula."
              trailing={
                <div className="security-row-actions">
                  <StatusBadge tone={data.value.passwordConfigured ? "positive" : "warning"}>
                    {data.value.passwordConfigured ? "Ayarlı" : "Ayarlı değil"}
                  </StatusBadge>
                  <SecurityActionForm
                    action="password"
                    csrfToken={data.value.actionCsrfToken}
                    label={data.value.passwordConfigured ? "Şifreyi değiştir" : "Şifre oluştur"}
                  >
                    {data.value.passwordConfigured ? "Değiştir" : "Oluştur"}
                  </SecurityActionForm>
                </div>
              }
            />
            <SettingsRow
              icon={<Fingerprint aria-hidden="true" size={19} />}
              title="Passkey’ler"
              description="Parmak izi, yüz tanıma veya cihaz kilidiyle güvenli giriş yap."
              trailing={
                <div className="security-row-actions">
                  <StatusBadge tone={data.value.passkeyCount > 0 ? "positive" : "warning"}>
                    {data.value.passkeyCount > 0 ? `${data.value.passkeyCount} kayıtlı` : "Ayarlı değil"}
                  </StatusBadge>
                  <SecurityActionForm action="passkey" csrfToken={data.value.actionCsrfToken} label="Yeni passkey ekle">Ekle</SecurityActionForm>
                </div>
              }
            />
            <SettingsRow
              icon={<ShieldCheck aria-hidden="true" size={19} />}
              title="İki adımlı doğrulama"
              description="Doğrulama uygulamasından alınan tek kullanımlık kodlarla hesabını koru."
              trailing={
                <div className="security-row-actions">
                  <StatusBadge tone={data.value.otpConfigured ? "positive" : "warning"}>
                    {data.value.otpConfigured ? "Ayarlı" : "Ayarlı değil"}
                  </StatusBadge>
                  <SecurityActionForm action="otp" csrfToken={data.value.actionCsrfToken} label="Doğrulama uygulaması ekle">Ekle</SecurityActionForm>
                </div>
              }
            />
          </SettingsGroup>

          {data.value.credentials.length > 0 ? (
            <SettingsGroup title="Kayıtlı güvenlik yöntemleri" description="Kaldırma işlemi de yeniden doğrulama ve yöntem sahipliği kontrolünden geçer.">
              {data.value.credentials.map((credential) => (
                <SettingsRow
                  key={credential.deletionReference}
                  icon={credential.kind === "passkey"
                    ? <Fingerprint aria-hidden="true" size={19} />
                    : <Smartphone aria-hidden="true" size={19} />}
                  title={credential.label}
                  description={credential.kind === "passkey"
                    ? `Passkey · ${formattedDate(credential.createdAt)}`
                    : `Doğrulama uygulaması · ${formattedDate(credential.createdAt)}`}
                  trailing={
                    <SecurityActionForm
                      action="delete-credential"
                      credential={credential.deletionReference}
                      csrfToken={data.value.actionCsrfToken}
                      label={`${credential.label} yöntemini kaldır`}
                      tone="danger"
                    >
                      Kaldır
                    </SecurityActionForm>
                  }
                />
              ))}
            </SettingsGroup>
          ) : null}
        </>
      ) : <AccountDataProblem problem={data.problem} retryHref="/security" />}
      <p className="page-hint">
        Hesap Merkezi seni hiçbir zaman Keycloak Hesap Konsolu’na veya yerleşik hesap silme ekranına göndermez.
      </p>
    </div>
  );
}
