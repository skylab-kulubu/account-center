"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  ChevronLeft,
  CircleUserRound,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MonitorSmartphone,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Background } from "@/components/background";
import { SkyLabMark } from "@/components/skylab-mark";

type NavigationItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

const navigation: NavigationItem[] = [
  { href: "/", label: "Özet", icon: LayoutDashboard },
  { href: "/personal-information", label: "Kişisel bilgiler", icon: CircleUserRound },
  { href: "/security", label: "Giriş ve güvenlik", icon: KeyRound },
  { href: "/sessions", label: "Oturumlar ve cihazlar", icon: MonitorSmartphone },
  { href: "/delete-account", label: "Hesabı sil", icon: Trash2 },
];

export const SESSION_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

function isActivePath(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

function LogoutForm({ csrfToken, compact = false }: { csrfToken: string; compact?: boolean }) {
  return (
    <form className={compact ? "mobile-header__sign-out" : "account-sidebar__sign-out-form"} action="/api/auth/logout" method="post">
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <button className={compact ? "mobile-header__sign-out-button" : "account-sidebar__sign-out"} type="submit">
        <LogOut aria-hidden="true" size={compact ? 19 : 17} />
        {compact ? <span className="sr-only">Çıkış yap</span> : <span>Çıkış yap</span>}
      </button>
    </form>
  );
}

function DesktopNavigation({ pathname, csrfToken }: { pathname: string; csrfToken: string }) {
  return (
    <aside className="account-sidebar">
      <Link className="brand" href="/" aria-label="SKY LAB Hesap Merkezi ana sayfa">
        <SkyLabMark animated={false} className="brand__mark" size={34} />
        <span>
          <strong>SKY LAB</strong>
          <small>Hesap Merkezi</small>
        </span>
      </Link>

      <nav className="account-nav" aria-label="Hesap ayarları">
        {navigation.map(({ href, label, icon: Icon }) => {
          const active = isActivePath(pathname, href);
          return (
            <Link
              key={href}
              className="account-nav__item"
              data-active={active || undefined}
              href={href}
              aria-current={active ? "page" : undefined}
            >
              <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>

      <LogoutForm csrfToken={csrfToken} />
    </aside>
  );
}

function MobileHeader({ pathname, csrfToken }: { pathname: string; csrfToken: string }) {
  const current = navigation.find((item) => isActivePath(pathname, item.href));
  return (
    <header className="mobile-header">
      {pathname === "/" ? (
        <SkyLabMark animated={false} className="mobile-header__mark" size={30} />
      ) : (
        <Link className="mobile-header__back" href="/" aria-label="Hesap Merkezi özetine dön">
          <ChevronLeft aria-hidden="true" size={22} />
        </Link>
      )}
      <span>{current?.label ?? "Hesap Merkezi"}</span>
      <LogoutForm csrfToken={csrfToken} compact />
    </header>
  );
}

export function AccountShell({
  children,
  logoutCsrfToken,
}: Readonly<{ children: React.ReactNode; logoutCsrfToken: string }>) {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const refresh = () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      void fetch("/api/auth/session/refresh", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "x-csrf-token": logoutCsrfToken },
        signal: controller.signal,
      })
        .then((response) => {
          if (response.status === 401) router.replace("/login");
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
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
      controller.abort();
    };
  }, [logoutCsrfToken, router]);

  return (
    <div className="account-root">
      <a className="skip-link" href="#main-content">İçeriğe geç</a>
      <Background />
      <div className="account-frame">
        <DesktopNavigation pathname={pathname} csrfToken={logoutCsrfToken} />
        <MobileHeader pathname={pathname} csrfToken={logoutCsrfToken} />
        <main className="account-content" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
