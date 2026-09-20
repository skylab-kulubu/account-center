import { Fingerprint, KeyRound, ShieldCheck, Smartphone } from "lucide-react";
import { AccountDataProblem } from "@/components/account-data-problem";
import { SecurityActionForm } from "@/components/security-action-form";
import { PageHeader, SettingsGroup, SettingsRow, StatusBadge } from "@/components/settings";
import { loadSecurity } from "@/server/keycloak-account/page-data";
import type { AccountActionResult } from "@/server/auth/types";

export const metadata = { title: "Giriş ve güvenlik" };

const actionLabels = {
  password: "Şifre",
  otp: "İki adımlı doğrulama",
  passkey: "Passkey",
  "delete-credential": "Giriş yöntemi",
} as const;

function ActionNotice({ result }: { result: AccountActionResult | null }) {
  if (!result) return null;
  const label = actionLabels[result.action];
  const copy = result.outcome === "success"
    ? `${label} işlemi tamamlandı ve Keycloak’taki güncel durumla doğrulandı.`
    : result.outcome === "cancelled"
      ? `${label} işlemi iptal edildi; hesabında değişiklik yapılmadı.`
      : result.outcome === "unverified"
        ? `${label} işlemi Keycloak tarafından başarılı bildirildi ancak güncel hesap durumunda doğrulanamadı.`
        : `${label} işlemi tamamlanamadı. Tekrar deneyebilirsin.`;
  return (
    <div className="action-notice" data-tone={result.outcome === "success" ? "positive" : result.outcome === "cancelled" ? "neutral" : "warning"} role="status">
      <strong>{result.outcome === "success" ? "İşlem tamamlandı" : result.outcome === "cancelled" ? "İşlem iptal edildi" : "İşlem doğrulanamadı"}</strong>
      <span>{copy}</span>
    </div>
  );
}

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
  return (
    <div className="page-stack">
      <PageHeader
        title="Giriş ve güvenlik"
        description="Şifreni, passkey’lerini ve iki adımlı doğrulamayı tek yerden yönet. Her değişiklik SKY LAB giriş ekranında yeniden doğrulama ister."
      />
      <ActionNotice result={data.ok ? data.value.actionResult : data.actionResult} />
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
