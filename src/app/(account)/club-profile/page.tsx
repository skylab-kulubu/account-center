import Link from "next/link";
import {
  AtSign,
  CircleUserRound,
  Hash,
  Nfc,
  Phone,
} from "lucide-react";
import { AccountDataProblem } from "@/components/account-data-problem";
import { ClubProfileEditor } from "@/components/club-profile-editor";
import { AccountPageHeader, SettingsGroup, SettingsRow, StatusBadge } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";
import { loadClubProfilePage } from "@/server/club-profile/page-data";
import type { ClubProfileState } from "@/server/club-profile/page-data";
import type { ClubProfileProblem } from "@/server/club-profile/problem";

const route = accountRoute("/club-profile");

export const metadata = { title: route.documentTitle };

function ClubProfileNotice({ state }: { state: Exclude<ClubProfileState, { status: "ready" }> }) {
  if (state.status === "disabled") {
    return (
      <div className="club-profile-notice" data-tone="neutral" role="status">
        <strong>Kulüp profili bu ortamda kapalı</strong>
        <span>
          Bu ortamda core bağlantısı tanımlı değil; SKY numarası, öğrenci kartı, telefon ve kulüp bilgileri burada görünmez.
          Kimlik bilgilerin bundan etkilenmez.
        </span>
      </div>
    );
  }
  const problem: ClubProfileProblem = state.problem;
  return (
    <div className="club-profile-notice" role="status">
      <strong>{problem.title}</strong>
      <span>{problem.detail}</span>
      <span>
        {problem.status === 401
          ? <Link href="/login?returnTo=%2Fclub-profile">Yeniden giriş yap</Link>
          : <Link href="/club-profile">Yeniden dene</Link>}
      </span>
    </div>
  );
}

export default async function ClubProfilePage() {
  const data = await loadClubProfilePage();
  const club = data.clubProfile.status === "ready" ? data.clubProfile.value : null;
  const identity = data.identity.ok ? data.identity.value : null;
  const coreCopy = data.clubProfile.status === "disabled" ? "Bu ortamda kapalı" : "Şu anda görüntülenemiyor";
  const skyNumber = club?.skyNumber ?? identity?.skyNumber ?? null;
  const schoolEmail = club?.schoolEmail ?? identity?.schoolEmail ?? null;
  const identityNeedsLogin = !data.identity.ok && data.identity.problem.status === 401;
  const clubState = data.clubProfile;
  /** One re-login card is enough when both reads failed on the same session token. */
  const clubNotice = clubState.status === "ready" ||
    (clubState.status === "problem" && clubState.problem.status === 401 && identityNeedsLogin)
    ? null
    : clubState;

  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />

      {data.identity.ok && identity ? (
        <section className="identity-card" aria-labelledby="club-identity-heading">
          <span className="identity-card__avatar" aria-hidden="true">
            <CircleUserRound size={27} strokeWidth={1.6} />
          </span>
          <span className="identity-card__copy">
            <span id="club-identity-heading">{identity.displayName ?? "SKY LAB hesabı"}</span>
            <small>{identity.email ?? "Birincil e-posta tanımlı değil"}</small>
          </span>
          <StatusBadge>SKY LAB kimliği</StatusBadge>
        </section>
      ) : !data.identity.ok ? <AccountDataProblem problem={data.identity.problem} retryHref="/club-profile" /> : null}

      {clubNotice ? (
        <div className="settings-section">
          <ClubProfileNotice state={clubNotice} />
        </div>
      ) : null}

      <SettingsGroup title="Üyelik" description="Bu alanlar kulüp kayıtlarından gelir ve buradan değiştirilemez.">
        <SettingsRow
          icon={<Hash aria-hidden="true" size={19} />}
          title="SKY numarası"
          description={skyNumber ?? (club ? "Henüz verilmedi" : coreCopy)}
          trailing={<StatusBadge>Core</StatusBadge>}
        />
        <SettingsRow
          icon={<Nfc aria-hidden="true" size={19} />}
          title="Öğrenci kartı"
          description={club
            ? "Kartını sky-app’teki SkyPass ekranından bağlayabilir ya da değiştirebilirsin; kapıda o kartla giriş yaparsın."
            : coreCopy}
          trailing={club ? (
            <StatusBadge tone={club.studentCardLinked ? "positive" : "warning"}>
              {club.studentCardLinked ? "Öğrenci kartı bağlı" : "Öğrenci kartı bağlı değil"}
            </StatusBadge>
          ) : <StatusBadge>Core</StatusBadge>}
        />
        <SettingsRow
          icon={<AtSign aria-hidden="true" size={19} />}
          title="Okul e-postası"
          description={schoolEmail ?? "Kayıtlı değil"}
          trailing={<StatusBadge>YTÜ hesabından gelir</StatusBadge>}
        />
        <SettingsRow
          icon={<Phone aria-hidden="true" size={19} />}
          title="Telefon"
          description={club
            ? `${club.phone ?? "Kayıtlı değil"} · Yönetim ekibi günceller; doğrulama geldiğinde buradan düzenleyebileceksin.`
            : coreCopy}
          trailing={<StatusBadge>Salt okunur</StatusBadge>}
        />
      </SettingsGroup>

      {club ? <ClubProfileEditor initial={club} csrfToken={data.csrfToken} /> : null}

      <aside className="read-only-note" aria-label="Kulüp profili sınırları">
        Ad ve soyad kimlik bilgilerinde yönetilir; SKY numarası, öğrenci kartı ve telefon kulüp kayıtlarıdır. Bu sayfadaki
        değişiklikler yeniden doğrulama istemez.
      </aside>
    </div>
  );
}
