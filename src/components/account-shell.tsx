"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge } from "@skylab-kulubu/skylcn-ui";
import {
  ChevronLeft,
  LogOut,
} from "lucide-react";
import { Background } from "@/components/background";
import { SkyLabMark } from "@/components/skylab-mark";
import { accountRoutes, matchAccountRoute } from "@/config/account-routes";
import type { AccountRoute } from "@/config/account-routes";
import { INBOX_SEEN_EVENT } from "@/lib/inbox";
import { refreshBrowserSession } from "@/lib/session-refresh";

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

/**
 * The inbox's unseen count for the navigation badge (`GET /api/account/inbox/counts`), read when
 * the shell opens and when the window comes back; cleared when the inbox page marks all seen.
 * Off (null) without SkyMail, and on any failure: a badge is a hint, never an error.
 */
function useInboxUnseen(enabled: boolean, csrfToken: string) {
  const [unseen, setUnseen] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // After the session refresh the shell sends at the same moments (mount, focus): a read beside a
    // rotating refresh would carry the handle the refresh is replacing (iletişim-servisi 07 review).
    const read = () => {
      void refreshBrowserSession(csrfToken)
        .catch(() => undefined)
        .then(() => fetch("/api/account/inbox/counts", { cache: "no-store", credentials: "same-origin" }))
        .then(async (response) => (response.ok ? ((await response.json()) as { counts?: { unseen?: unknown } }) : null))
        .then((body) => {
          const value = body?.counts?.unseen;
          if (!cancelled) setUnseen(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);
        })
        .catch(() => undefined);
    };
    const seen = () => setUnseen(0);
    read();
    window.addEventListener("focus", read);
    window.addEventListener(INBOX_SEEN_EVENT, seen);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", read);
      window.removeEventListener(INBOX_SEEN_EVENT, seen);
    };
  }, [enabled, csrfToken]);
  return unseen;
}

function DesktopNavigation({
  currentRoute,
  csrfToken,
  inboxUnseen,
}: {
  currentRoute: AccountRoute | null;
  csrfToken: string;
  inboxUnseen: number | null;
}) {
  return (
    <aside className="account-sidebar">
      <Link className="brand" href="/" aria-label="SKY LAB Hesap Merkezi ana sayfa">
        <SkyLabMark className="brand__mark" size={34} />
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
              {href === "/notifications" && inboxUnseen ? (
                <Badge className="account-nav__badge" tone="brand">
                  {inboxUnseen > 99 ? "99+" : inboxUnseen}
                  <span className="sr-only"> yeni bildirim</span>
                </Badge>
              ) : null}
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
        <SkyLabMark className="mobile-header__mark" size={30} />
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
  embedded = false,
  inboxEnabled = false,
}: Readonly<{
  children: React.ReactNode;
  logoutCsrfToken: string;
  /** SkyMail is configured (`SKYMAIL_API_URL`): the inbox's badge is read. */
  inboxEnabled?: boolean;
  /** Opened inside SkyApp's WebView, whose own top bar handles back and close. */
  embedded?: boolean;
}>) {
  const pathname = usePathname();
  const router = useRouter();
  const currentRoute = matchAccountRoute(pathname);
  const inboxUnseen = useInboxUnseen(inboxEnabled, logoutCsrfToken);

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
    <div className="account-root" data-embedded={embedded ? "skyapp" : undefined}>
      <a className="skip-link" href="#main-content">İçeriğe geç</a>
      <Background />
      <div className="account-frame">
        <DesktopNavigation currentRoute={currentRoute} csrfToken={logoutCsrfToken} inboxUnseen={inboxUnseen} />
        {embedded ? null : <MobileHeader currentRoute={currentRoute} csrfToken={logoutCsrfToken} />}
        <main className="account-content" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
