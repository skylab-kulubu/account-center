import Link from "next/link";
import {
  AtSign,
  Hash,
  Nfc,
  Phone,
} from "lucide-react";
import { AccountDataProblem } from "@/components/account-data-problem";
import { ClubProfileEditor } from "@/components/club-profile-editor";
import { AccountPageHeader, SettingsGroup, SettingsRow, StatusBadge } from "@/components/settings";
import { SkyPassWalletCard } from "@/components/skypass-wallet-card";
import { StudentCardRow } from "@/components/student-card-row";
import { TeamPageConsentSection } from "@/components/team-page-consent";
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
          SKY numarası, öğrenci kartı, telefon ve kulüp bilgileri burada görünmez.
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

      {!data.identity.ok ? <AccountDataProblem problem={data.identity.problem} retryHref="/club-profile" /> : null}

      {clubNotice ? (
        <div className="settings-section">
          <ClubProfileNotice state={clubNotice} />
        </div>
      ) : null}

      <SettingsGroup title="Üyelik">
        <SettingsRow
          icon={<Hash aria-hidden="true" size={19} />}
          title="SKY numarası"
          description={skyNumber ?? (club ? "Henüz verilmedi" : coreCopy)}
        />
        {club ? <StudentCardRow initialLinked={club.studentCardLinked} csrfToken={data.csrfToken} /> : (
          <SettingsRow
            icon={<Nfc aria-hidden="true" size={19} />}
            title="Öğrenci kartı"
            description={coreCopy}
          />
        )}
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
            ? club.phone ?? "Kayıtlı değil"
            : coreCopy}
          trailing={<StatusBadge>Yönetim ekibi günceller</StatusBadge>}
        />
      </SettingsGroup>

      {club && data.skyPassWallet.status === "ready" ? (
        <SkyPassWalletCard initialIssued={data.skyPassWallet.issued} csrfToken={data.csrfToken} />
      ) : null}

      {club ? <ClubProfileEditor initial={club} csrfToken={data.csrfToken} /> : null}

      {data.teamPage.status === "shown" ? (
        <TeamPageConsentSection csrfToken={data.csrfToken} initial={data.teamPage.value} returnTo={route.href} />
      ) : null}
    </div>
  );
}
