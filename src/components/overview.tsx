import Link from "next/link";
import { Check, ChevronRight, CircleAlert } from "lucide-react";
import { Avatar } from "@skylab-kulubu/skylcn-ui";
import { HomeEmailDeliveryWarning } from "@/components/email-delivery-warning";
import { HomePrimaryEmailNudge } from "@/components/primary-email-nudge";
import type { AccountRoutePath } from "@/config/account-routes";
import type { AccountOverview } from "@/server/keycloak-account/types";

/**
 * Ana sayfa, as in Google Account's home: the person, the e-mail warnings and nudge, a security
 * status card with the next step for anything missing, and calm cards that lead to each section.
 */

/** ok: tamam; advice: öneri (sayılır, düğmesi var); neutral: isteğe bağlı (passkey varken doğrulama uygulaması). */
type SecurityCheck = { label: string; value: string; ok: boolean; neutral?: boolean; href: AccountRoutePath; action?: string };

function securityChecks(overview: AccountOverview): SecurityCheck[] {
  const { authentication, profile } = overview;
  const personal = profile.attributes.personalEmail;
  return [
    { label: "Parola", value: authentication.passwordConfigured ? "Tanımlı" : "Yok", ok: authentication.passwordConfigured, href: "/security", action: "Parola belirle" },
    { label: "Passkey", value: authentication.passkeyCount > 0 ? `${authentication.passkeyCount} cihaz` : "Yok", ok: authentication.passkeyCount > 0, href: "/security", action: "Passkey ekle" },
    {
      label: "Doğrulama uygulaması",
      value: authentication.otpConfigured ? "Açık" : authentication.passkeyCount > 0 ? "İsteğe bağlı" : "Yok",
      ok: authentication.otpConfigured || authentication.passkeyCount > 0,
      neutral: !authentication.otpConfigured && authentication.passkeyCount > 0,
      href: "/security",
      action: "Ekle",
    },
    { label: "Kişisel e-posta", value: personal ?? "Eklenmedi", ok: personal !== null, href: "/email", action: "Ekle" },
  ];
}

function displayName(overview: AccountOverview) {
  const { firstName, lastName, username } = overview.profile;
  return [firstName, lastName].filter(Boolean).join(" ") || username || "SKY LAB hesabı";
}

function Person({ overview }: { overview: AccountOverview }) {
  const name = displayName(overview);
  const { email, username, emailVerified } = overview.profile;
  return (
    <section className="home-person" aria-labelledby="home-person-name">
      <Avatar className="home-person__avatar" name={name} email={email} size="lg" />
      <div className="home-person__text">
        <h1 id="home-person-name">{name}</h1>
        <p>
          {email ?? "Birincil e-posta yok"}
          {username ? <span> · @{username}</span> : null}
        </p>
        {!emailVerified ? <p className="home-person__warning">E-posta doğrulanmadı</p> : null}
      </div>
    </section>
  );
}

function CheckState({ ok, neutral = false }: { ok: boolean; neutral?: boolean }) {
  if (neutral) return <span className="home-check__state home-check__state--optional" aria-label="İsteğe bağlı" />;
  return ok
    ? <Check className="home-check__state" data-ok="" aria-label="Tamam" size={16} />
    : <CircleAlert className="home-check__state" aria-label="Öneri" size={16} />;
}

/** The security status, Google Account's Security Checkup in one card. */
function SecurityStatusCard({ overview, wide = false, children }: { overview: AccountOverview; wide?: boolean; children?: React.ReactNode }) {
  const checks = securityChecks(overview);
  const open = checks.filter(({ ok }) => !ok).length;
  return (
    <section className={wide ? "card card--wide" : "card"} aria-labelledby="card-security">
      <div className="card__head">
        <h2 id="card-security">Güvenlik durumu</h2>
        <span className="pill" data-tone={open ? "warning" : "positive"}>{open ? `${open} öneri` : "Tamam"}</span>
      </div>
      <ul className="card__checks">
        {checks.map((check) => (
          <li key={check.label}>
            <CheckState ok={check.ok} neutral={check.neutral} />
            <span className="card__label">{check.label}</span>
            <span className="card__value">{check.value}</span>
            {!check.ok && check.action ? <Link className="button button--small" href={check.href}>{check.action}</Link> : null}
          </li>
        ))}
      </ul>
      {children ? <div className="card__actions">{children}</div> : null}
    </section>
  );
}

export function Overview({ overview }: { overview: AccountOverview }) {
  const { profile } = overview;
  return (
    <div className="home">
      <Person overview={overview} />
      <HomeEmailDeliveryWarning />
      <HomePrimaryEmailNudge />

      <div className="home-grid">
        <SecurityStatusCard overview={overview} wide>
          <Link className="button" href="/security">Güvenlik</Link>
          <Link className="button" href="/sessions">Cihazlar</Link>
        </SecurityStatusCard>

        <section className="card" aria-labelledby="card-personal">
          <div className="card__head"><h2 id="card-personal">Kişisel bilgiler</h2></div>
          <dl className="card__pairs">
            <div><dt>Ad</dt><dd>{displayName(overview)}</dd></div>
            <div><dt>Kullanıcı adı</dt><dd>{profile.username ? `@${profile.username}` : "Yok"}</dd></div>
            <div><dt>E-posta</dt><dd>{profile.email ?? "Yok"}</dd></div>
          </dl>
          <div className="card__actions"><Link className="button" href="/personal-info">Kişisel bilgiler</Link></div>
        </section>

        <section className="card" aria-labelledby="card-club">
          <div className="card__head"><h2 id="card-club">Kulüp profili</h2></div>
          <dl className="card__pairs">
            <div><dt>SKY numarası</dt><dd>{profile.attributes.skyNumber ?? "Yok"}</dd></div>
            <div><dt>Bölüm</dt><dd>{profile.attributes.department ?? "Yok"}</dd></div>
          </dl>
          <div className="card__actions"><Link className="button" href="/club-profile">Kulüp profili</Link></div>
        </section>

        <section className="card" aria-labelledby="card-privacy">
          <div className="card__head"><h2 id="card-privacy">Veri ve gizlilik</h2></div>
          <ul className="card__links">
            <li><Link href="/communication-preferences">İletişim tercihleri<ChevronRight aria-hidden="true" size={16} /></Link></li>
            <li><Link href="/privacy">Veri ve gizlilik<ChevronRight aria-hidden="true" size={16} /></Link></li>
          </ul>
        </section>

        <section className="card" aria-labelledby="card-apps">
          <div className="card__head"><h2 id="card-apps">Uygulamalar</h2></div>
          <ul className="card__links">
            <li><Link href="/permissions">Yetkiler<ChevronRight aria-hidden="true" size={16} /></Link></li>
            <li><Link href="/app-preferences">Uygulama ayarları<ChevronRight aria-hidden="true" size={16} /></Link></li>
          </ul>
        </section>
      </div>
    </div>
  );
}
