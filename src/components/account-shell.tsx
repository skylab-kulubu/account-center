"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  ChevronLeft,
  LogOut,
} from "lucide-react";
import { Background } from "@/components/background";
import { SkyLabMark } from "@/components/skylab-mark";
import { accountRoutes, matchAccountRoute } from "@/config/account-routes";
import type { AccountRoute } from "@/config/account-routes";

export const SESSION_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

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

function DesktopNavigation({ currentRoute, csrfToken }: { currentRoute: AccountRoute | null; csrfToken: string }) {
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
        {accountRoutes.map(({ href, navigationLabel, icon: Icon, tone }) => {
          const active = currentRoute?.href === href;
          return (
            <Link
              key={href}
              className="account-nav__item"
              data-active={active || undefined}
              data-tone={tone}
              href={href}
              aria-current={active ? "page" : undefined}
            >
              <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
              <span>{navigationLabel}</span>
            </Link>
          );
        })}
      </nav>

      <LogoutForm csrfToken={csrfToken} />
    </aside>
  );
}

function MobileHeader({ currentRoute, csrfToken }: { currentRoute: AccountRoute | null; csrfToken: string }) {
  return (
    <header className="mobile-header">
      {currentRoute?.href === "/" ? (
        <SkyLabMark animated={false} className="mobile-header__mark" size={30} />
      ) : (
        <Link className="mobile-header__back" href="/" aria-label="Hesap Merkezi özetine dön">
          <ChevronLeft aria-hidden="true" size={22} />
        </Link>
      )}
      <span>{currentRoute?.navigationLabel ?? "Hesap Merkezi"}</span>
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
  const currentRoute = matchAccountRoute(pathname);

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

  return (
    <div className="account-root">
      <a className="skip-link" href="#main-content">İçeriğe geç</a>
      <Background />
      <div className="account-frame">
        <DesktopNavigation currentRoute={currentRoute} csrfToken={logoutCsrfToken} />
        <MobileHeader currentRoute={currentRoute} csrfToken={logoutCsrfToken} />
        <main className="account-content" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

let refreshInFlight: Promise<Response> | undefined;

function refreshBrowserSession(csrfToken: string) {
  refreshInFlight ??= fetch("/api/auth/session/refresh", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "x-csrf-token": csrfToken },
  }).finally(() => {
    refreshInFlight = undefined;
  });
  return refreshInFlight;
}
