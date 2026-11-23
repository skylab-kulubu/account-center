"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@skylab-kulubu/skylcn-ui";
import { ChevronLeft } from "lucide-react";
import { SIGN_OUT_FORM_ID } from "@/components/account-menu";
import { Background } from "@/components/background";
import { EnvironmentBadge, EnvironmentStrip } from "@/components/environment-strip";
import { SkyLabMark } from "@/components/skylab-mark";
import { accountRoutes, matchAccountRoute } from "@/config/account-routes";
import type { AccountRoute } from "@/config/account-routes";
import { INBOX_SEEN_EVENT } from "@/lib/inbox";
import { refreshBrowserSession } from "@/lib/session-refresh";

export const SESSION_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

/** The sign-out the account menu submits (`SIGN_OUT_FORM_ID`): a same-origin POST with the session's CSRF token. */
function SignOutForm({ csrfToken }: { csrfToken: string }) {
  return (
    <form id={SIGN_OUT_FORM_ID} action="/api/auth/logout" method="post" hidden>
      <input type="hidden" name="csrfToken" value={csrfToken} />
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
  inboxEnabled,
  inboxUnseen,
}: {
  currentRoute: AccountRoute | null;
  /** Without SkyMail (`SKYMAIL_API_URL` unset) the page would only say it is off: it is left out of the menu. */
  inboxEnabled: boolean;
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
        {accountRoutes.filter(({ href }) => inboxEnabled || href !== "/notifications").map(({ href, navigationLabel, icon: Icon, tone }) => {
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
    </aside>
  );
}

/**
 * The top bar, as in every SKY LAB product: the sandbox badge and the account menu at the top
 * right. On phones it is the whole sticky header: back (or the mark on the overview), the page's
 * name, then the badge and the avatar. On desktop only the right end shows; the sidebar carries
 * the brand.
 */
function TopBar({ currentRoute, account, sandbox }: { currentRoute: AccountRoute | null; account: ReactNode; sandbox: boolean }) {
  return (
    <header className="account-topbar">
      <span className="account-topbar__lead">
        {currentRoute?.href === "/" ? (
          <SkyLabMark className="account-topbar__mark" size={30} />
        ) : (
          <Link className="account-topbar__back" href="/" aria-label="Hesap Merkezi özetine dön">
            <ChevronLeft aria-hidden="true" size={22} />
          </Link>
        )}
      </span>
      <span className="account-topbar__title">{currentRoute?.navigationLabel ?? "Hesap Merkezi"}</span>
      <span className="account-topbar__actions">
        <EnvironmentBadge sandbox={sandbox} />
        {account}
      </span>
    </header>
  );
}

export function AccountShell({
  children,
  logoutCsrfToken,
  embedded = false,
  inboxEnabled = false,
  account = null,
  sandbox = false,
}: Readonly<{
  children: React.ReactNode;
  logoutCsrfToken: string;
  /** The account menu at the top right (`ShellAccount`, streamed in by the layout). */
  account?: ReactNode;
  /** This Account Center serves the sandbox (`isSandbox`): a strip at the top and a badge beside the account. */
  sandbox?: boolean;
  /** SkyMail is configured (`SKYMAIL_API_URL`): the inbox's badge is read. */
  inboxEnabled?: boolean;
  /** Opened inside SkyApp's WebView, whose own top bar handles back, close and the account: no top bar here. */
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
      <EnvironmentStrip sandbox={sandbox} withLabel={embedded} />
      <a className="skip-link" href="#main-content">İçeriğe geç</a>
      <Background />
      <SignOutForm csrfToken={logoutCsrfToken} />
      <div className="account-frame">
        <DesktopNavigation
          currentRoute={currentRoute}
          inboxEnabled={inboxEnabled}
          inboxUnseen={inboxUnseen}
        />
        {embedded ? null : <TopBar currentRoute={currentRoute} account={account} sandbox={sandbox} />}
        <main className="account-content" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
