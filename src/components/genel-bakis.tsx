import Link from "next/link";
import { Check, ChevronRight, CircleAlert } from "lucide-react";
import { Avatar } from "@skylab-kulubu/skylcn-ui";
import { HomeEmailDeliveryWarning } from "@/components/email-delivery-warning";
import { HomePrimaryEmailNudge } from "@/components/primary-email-nudge";
import { accountNavGroups, accountShortLabels } from "@/config/account-routes";
import type { AccountRoutePath } from "@/config/account-routes";
import type { AccountOverview } from "@/server/keycloak-account/types";

/**
 * GEÇİCİ: tasarım yönleri A ve B'nin Özet sayfası. Bugünkü Özet'teki bilgi kaybolmaz:
 * kimlik kartı, e-posta uyarıları ve önerisi, güvenlik önerisi, bütün sayfalara giriş.
 * Kaldırılan yalnız tekrar (menünün kopyası olan açıklamalı satırlar) ve süs cümleleri.
 */

/** ok: tamam; advice: öneri (sayılır, düğmesi var); neutral: isteğe bağlı (passkey varken doğrulama uygulaması). */
type Kontrol = { label: string; value: string; ok: boolean; neutral?: boolean; href: AccountRoutePath; action?: string };

function securityChecks(overview: AccountOverview): Kontrol[] {
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

function KisiBasligi({ overview, size }: { overview: AccountOverview; size: "a" | "b" }) {
  const name = displayName(overview);
  const { email, username, emailVerified } = overview.profile;
  return (
    <section className={`ozet-kisi ozet-kisi--${size}`} aria-labelledby="ozet-kisi-ad">
      <Avatar className="ozet-kisi__avatar" name={name} email={email} size="lg" />
      <div className="ozet-kisi__metin">
        <h1 id="ozet-kisi-ad">{name}</h1>
        <p>
          {email ?? "Birincil e-posta yok"}
          {username ? <span> · @{username}</span> : null}
        </p>
        {!emailVerified ? <p className="ozet-kisi__uyari">E-posta doğrulanmadı</p> : null}
      </div>
    </section>
  );
}

function Durum({ ok, neutral = false }: { ok: boolean; neutral?: boolean }) {
  if (neutral) return <span className="ozet-durum ozet-durum--bos" aria-label="İsteğe bağlı" />;
  return ok
    ? <Check className="ozet-durum" data-ok="" aria-label="Tamam" size={16} />
    : <CircleAlert className="ozet-durum" aria-label="Öneri" size={16} />;
}

/** A: Google Hesabı / Microsoft My Account ana sayfası — ortada kişi, altında sakin kartlar. */
export function GenelBakisA({ overview }: { overview: AccountOverview }) {
  const checks = securityChecks(overview);
  const open = checks.filter(({ ok }) => !ok).length;
  const { profile } = overview;
  return (
    <div className="ozet-a">
      <KisiBasligi overview={overview} size="a" />
      <HomeEmailDeliveryWarning />
      <HomePrimaryEmailNudge />

      <div className="ozet-a__izgara">
        <section className="kart kart--genis" aria-labelledby="kart-guvenlik">
          <div className="kart__bas">
            <h2 id="kart-guvenlik">Güvenlik durumu</h2>
            <span className="rozet" data-tone={open ? "warning" : "positive"}>{open ? `${open} öneri` : "Tamam"}</span>
          </div>
          <ul className="kart__liste">
            {checks.map((check) => (
              <li key={check.label}>
                <Durum ok={check.ok} neutral={check.neutral} />
                <span className="kart__etiket">{check.label}</span>
                <span className="kart__deger">{check.value}</span>
                {!check.ok && check.action ? <Link className="dugme dugme--kucuk" href={check.href}>{check.action}</Link> : null}
              </li>
            ))}
          </ul>
          <div className="kart__alt">
            <Link className="dugme" href="/security">Parola ve passkey</Link>
            <Link className="dugme" href="/sessions">Cihazlar</Link>
          </div>
        </section>

        <section className="kart" aria-labelledby="kart-kisisel">
          <div className="kart__bas"><h2 id="kart-kisisel">Kimlik</h2></div>
          <dl className="kart__ciftler">
            <div><dt>Ad</dt><dd>{displayName(overview)}</dd></div>
            <div><dt>Kullanıcı adı</dt><dd>{profile.username ? `@${profile.username}` : "Yok"}</dd></div>
          </dl>
          <div className="kart__alt"><Link className="dugme" href="/identity">Düzenle</Link></div>
        </section>

        <section className="kart" aria-labelledby="kart-eposta">
          <div className="kart__bas"><h2 id="kart-eposta">E-posta</h2></div>
          <dl className="kart__ciftler">
            <div><dt>Okul</dt><dd>{profile.attributes.schoolEmail ?? "Bağlı değil"}</dd></div>
            <div><dt>Kişisel</dt><dd>{profile.attributes.personalEmail ?? "Eklenmedi"}</dd></div>
          </dl>
          <div className="kart__alt"><Link className="dugme" href="/email">Yönet</Link></div>
        </section>

        <section className="kart" aria-labelledby="kart-kulup">
          <div className="kart__bas"><h2 id="kart-kulup">Kulüp profili</h2></div>
          <dl className="kart__ciftler">
            <div><dt>SKY numarası</dt><dd>{profile.attributes.skyNumber ?? "Yok"}</dd></div>
            <div><dt>Bölüm</dt><dd>{profile.attributes.department ?? "Yok"}</dd></div>
          </dl>
          <div className="kart__alt"><Link className="dugme" href="/club-profile">Düzenle</Link></div>
        </section>

        <section className="kart" aria-labelledby="kart-bildirim">
          <div className="kart__bas"><h2 id="kart-bildirim">Bildirimler ve posta</h2></div>
          <ul className="kart__baglantilar">
            <li><Link href="/notifications">Bildirimler<ChevronRight aria-hidden="true" size={16} /></Link></li>
            <li><Link href="/communication-preferences">Posta tercihleri<ChevronRight aria-hidden="true" size={16} /></Link></li>
          </ul>
        </section>
      </div>

      <nav className="ozet-a__alt" aria-label="Diğer hesap sayfaları">
        <Link href="/permissions">Yetkiler</Link>
        <Link href="/app-preferences">Uygulama ayarları</Link>
        <Link href="/delete-account" data-tone="danger">Hesabı sil</Link>
      </nav>
    </div>
  );
}

/** B: Apple Hesabı / GitHub ayarları — kişi satırı, öneri satırı, gruplu liste (telefonda menünün kendisi). */
export function GenelBakisB({ overview, inboxEnabled }: { overview: AccountOverview; inboxEnabled: boolean }) {
  const checks = securityChecks(overview);
  const { profile, authentication } = overview;
  const previews: Partial<Record<AccountRoutePath, string>> = {
    "/identity": profile.username ? `@${profile.username}` : displayName(overview),
    "/club-profile": profile.attributes.skyNumber ? `SKY ${profile.attributes.skyNumber}` : "",
    "/email": profile.attributes.personalEmail ? "2 adres" : "1 adres",
    "/security": [authentication.passwordConfigured ? "Parola" : null, authentication.passkeyCount ? `${authentication.passkeyCount} passkey` : null, authentication.otpConfigured ? "Uygulama" : null].filter(Boolean).join(", "),
  };
  const advice = checks.filter(({ ok }) => !ok);
  return (
    <div className="ozet-b">
      <KisiBasligi overview={overview} size="b" />
      <HomeEmailDeliveryWarning />
      <HomePrimaryEmailNudge />

      {advice.length ? (
        <section className="liste-grubu" aria-labelledby="ozet-oneri">
          <h2 className="liste-grubu__baslik" id="ozet-oneri">Öneriler</h2>
          <ul className="liste">
            {advice.map((check) => (
              <li key={check.label} className="liste__satir">
                <Durum ok={false} />
                <span className="liste__etiket">{check.label}</span>
                <span className="liste__deger">{check.value}</span>
                <Link className="dugme dugme--kucuk" href={check.href}>{check.action}</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {accountNavGroups.filter(({ title }) => title).map(({ title, items }) => (
        <section className="liste-grubu" key={title} aria-label={title ?? undefined}>
          <h2 className="liste-grubu__baslik">{title}</h2>
          <ul className="liste">
            {items.filter((href) => inboxEnabled || href !== "/notifications").map((href) => (
              <li key={href}>
                <Link className="liste__satir liste__satir--baglanti" href={href} data-tone={href === "/delete-account" ? "danger" : undefined}>
                  <span className="liste__etiket">{accountShortLabels[href]}</span>
                  <span className="liste__deger">{previews[href] ?? ""}</span>
                  <ChevronRight className="liste__ok" aria-hidden="true" size={16} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
