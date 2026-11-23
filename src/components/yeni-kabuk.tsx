"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { ChevronLeft } from "lucide-react";
import { SESSION_REFRESH_INTERVAL_MS, useInboxUnseen } from "@/components/account-shell";
import { EnvironmentBadge, EnvironmentStrip } from "@/components/environment-strip";
import { CIKIS_FORMU_ID } from "@/components/hesap-menusu";
import { SkyLabMark } from "@/components/skylab-mark";
import { accountNavGroups, accountRoute, accountShortLabels, matchAccountRoute } from "@/config/account-routes";
import type { AccountRoutePath } from "@/config/account-routes";
import { refreshBrowserSession } from "@/lib/session-refresh";

/**
 * GEÇİCİ: tasarım yönleri A ve B'nin kabuğu.
 * Üst çubuk her ürünle aynı: solda SKY LAB işareti ve ürün adı, sağda hesap menüsü (avatar).
 * A: solda simgeli menü (Microsoft My Account / Google Hesabı); telefonda menü üst çubuğun
 *    altında kaydırılan sekmeler.
 * B: solda başlıklı yazı menüsü (GitHub ayarları); telefonda Özet listesi menüdür, alt sayfada
 *    üst çubukta geri oku ve sayfa adı (Apple Hesabı / iOS Ayarlar).
 */
function NavItem({
  href,
  yon,
  active,
  badge,
}: {
  href: AccountRoutePath;
  yon: "a" | "b";
  active: boolean;
  badge: number | null;
}) {
  const route = accountRoute(href);
  const Icon = route.icon;
  return (
    <Link
      className="yk-menu__oge"
      data-active={active || undefined}
      data-tone={route.tone}
      href={href}
      aria-current={active ? "page" : undefined}
    >
      {yon === "a" ? <Icon aria-hidden="true" size={18} strokeWidth={1.8} /> : null}
      <span>{accountShortLabels[href]}</span>
      {badge ? (
        <span className="yk-sayac">
          {badge > 99 ? "99+" : badge}
          <span className="sr-only"> yeni bildirim</span>
        </span>
      ) : null}
    </Link>
  );
}

export function YeniKabuk({
  yon,
  children,
  logoutCsrfToken,
  account,
  embedded = false,
  inboxEnabled = false,
  sandbox = false,
}: Readonly<{
  yon: "a" | "b";
  /** Sandbox: üstte sarı şerit, hesap düğmesinin solunda rozet (H1 #138). */
  sandbox?: boolean;
  children: React.ReactNode;
  logoutCsrfToken: string;
  account: React.ReactNode;
  embedded?: boolean;
  inboxEnabled?: boolean;
}>) {
  const pathname = usePathname();
  const router = useRouter();
  const current = matchAccountRoute(pathname);
  const unseen = useInboxUnseen(inboxEnabled, logoutCsrfToken);
  const tabs = useRef<HTMLElement>(null);

  // The same session refresh as AccountShell: on open, every five minutes, on focus.
  useEffect(() => {
    const refresh = () => {
      void refreshBrowserSession(logoutCsrfToken)
        .then((response) => {
          if (response.status === 401) router.replace("/login");
        })
        .catch(() => undefined);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    const timer = window.setInterval(refresh, SESSION_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [logoutCsrfToken, router]);

  // A, telefon: açık sekme görünür olsun
  useEffect(() => {
    tabs.current?.querySelector<HTMLElement>("[data-active]")?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [pathname]);

  const visible = (href: AccountRoutePath) => inboxEnabled || href !== "/notifications";
  const badgeFor = (href: AccountRoutePath) => (href === "/notifications" ? unseen : null);
  const onHome = current?.href === "/";

  return (
    <div className="yk" data-yon={yon} data-embedded={embedded ? "skyapp" : undefined} data-ozet={onHome || undefined}>
      <EnvironmentStrip sandbox={sandbox} withLabel={embedded} />
      <a className="skip-link" href="#main-content">İçeriğe geç</a>
      <form id={CIKIS_FORMU_ID} action="/api/auth/logout" method="post" hidden>
        <input type="hidden" name="csrfToken" value={logoutCsrfToken} />
      </form>

      {embedded ? null : (
        <header className="yk-ust">
          <div className="yk-ust__sol">
            {yon === "b" && !onHome ? (
              <Link className="yk-geri" href="/" aria-label="Özete dön">
                <ChevronLeft aria-hidden="true" size={22} />
              </Link>
            ) : null}
            <Link className="yk-marka" href="/" aria-label="Hesap merkezi, özet">
              <SkyLabMark className="yk-marka__isaret" size={26} />
              <span className="yk-marka__ad">SKY LAB</span>
              <span className="yk-marka__urun">Hesap</span>
            </Link>
            {yon === "b" && !onHome && current ? <span className="yk-ust__baslik">{accountShortLabels[current.href]}</span> : null}
          </div>
          <div className="yk-ust__sag">
            <EnvironmentBadge sandbox={sandbox} />
            {account}
          </div>
        </header>
      )}

      {yon === "a" && !embedded ? (
        <nav className="yk-sekmeler" aria-label="Hesap sayfaları" ref={tabs}>
          {accountNavGroups.flatMap(({ items }) => items).filter(visible).map((href) => (
            <NavItem key={href} href={href} yon="b" active={current?.href === href} badge={badgeFor(href)} />
          ))}
        </nav>
      ) : null}

      <div className="yk-govde">
        <nav className="yk-menu" aria-label="Hesap ayarları">
          {accountNavGroups.map(({ title, items }, index) => (
            <div className="yk-menu__grup" key={title ?? index}>
              {title && yon === "b" ? <p className="yk-menu__baslik">{title}</p> : null}
              {items.filter(visible).map((href) => (
                <NavItem key={href} href={href} yon={yon} active={current?.href === href} badge={badgeFor(href)} />
              ))}
            </div>
          ))}
        </nav>
        <main className="yk-icerik" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
