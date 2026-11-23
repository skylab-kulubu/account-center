"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { EnvironmentBadge, EnvironmentStrip } from "@/components/environment-strip";
import { SIGN_OUT_FORM_ID } from "@/components/account-menu";
import { SkyLabMark } from "@/components/skylab-mark";
import { accountSections, matchAccountRoute } from "@/config/account-routes";
import type { AccountSectionPath } from "@/config/account-routes";
import { INBOX_SEEN_EVENT } from "@/lib/inbox";
import { refreshBrowserSession } from "@/lib/session-refresh";

export const SESSION_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * The inbox's unseen count for the navigation badge (`GET /api/account/inbox/counts`), read when
 * the shell opens and when the window comes back; cleared when the inbox page marks all seen.
 * Off (null) without SkyMail, and on any failure: a badge is a hint, never an error.
 */
export function useInboxUnseen(enabled: boolean, csrfToken: string) {
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

/** The sign-out the account menu submits (`SIGN_OUT_FORM_ID`): a same-origin POST with the session's CSRF token. */
function SignOutForm({ csrfToken }: { csrfToken: string }) {
  return (
    <form id={SIGN_OUT_FORM_ID} action="/api/auth/logout" method="post" hidden>
      <input type="hidden" name="csrfToken" value={csrfToken} />
    </form>
  );
}

function SectionLink({
  href,
  active,
  badge,
  withIcon,
}: {
  href: AccountSectionPath;
  active: boolean;
  badge: number | null;
  withIcon: boolean;
}) {
  const section = accountSections.find((candidate) => candidate.href === href)!;
  const Icon = section.icon;
  return (
    <Link className="shell-nav__link" data-active={active || undefined} href={href} aria-current={active ? "page" : undefined}>
      {withIcon ? <Icon aria-hidden="true" size={18} strokeWidth={1.8} /> : null}
      <span className="shell-nav__label">{section.label}</span>
      {badge ? (
        <span className="shell-nav__badge">
          {badge > 99 ? "99+" : badge}
          <span className="sr-only"> yeni bildirim</span>
        </span>
      ) : null}
    </Link>
  );
}

/**
 * Account Center's frame, as in Google Account and Microsoft My Account. The top bar is the one
 * every SKY LAB product draws: the mark and the product name at the top left, the sandbox badge
 * and the account button at the top right. Below it the six sections: a menu at the left on wide
 * screens, tabs under the top bar on phones (Google Account's mobile web). Inside SkyApp's
 * WebView, whose own bar carries back, close and the account, the top bar is left out and the
 * tabs stay.
 */
export function AccountShell({
  children,
  logoutCsrfToken,
  account = null,
  embedded = false,
  inboxEnabled = false,
  sandbox = false,
}: Readonly<{
  children: React.ReactNode;
  logoutCsrfToken: string;
  /** The account button and menu at the top right (`ShellAccount`, streamed in by the layout). */
  account?: ReactNode;
  /** Opened inside SkyApp's WebView, whose own top bar handles back, close and the account. */
  embedded?: boolean;
  /** SkyMail is configured (`SKYMAIL_API_URL`): Bildirimler is shown and its badge read. */
  inboxEnabled?: boolean;
  /** This Account Center serves the sandbox: a strip at the top and a badge beside the account. */
  sandbox?: boolean;
}>) {
  const pathname = usePathname();
  const router = useRouter();
  const current = matchAccountRoute(pathname)?.section ?? null;
  const unseen = useInboxUnseen(inboxEnabled, logoutCsrfToken);
  const tabs = useRef<HTMLElement>(null);

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

  // Phones: keep the open section's tab in view
  useEffect(() => {
    tabs.current?.querySelector<HTMLElement>("[data-active]")?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [pathname]);

  const sections = accountSections
    .map(({ href }) => href)
    .filter((href) => inboxEnabled || href !== "/notifications");
  const badgeFor = (href: AccountSectionPath) => (href === "/notifications" ? unseen : null);

  return (
    <div className="shell" data-embedded={embedded ? "skyapp" : undefined}>
      <EnvironmentStrip sandbox={sandbox} withLabel={embedded} />
      <a className="skip-link" href="#main-content">İçeriğe geç</a>
      <SignOutForm csrfToken={logoutCsrfToken} />

      {embedded ? null : (
        <header className="shell-bar">
          <Link className="shell-brand" href="/" aria-label="Hesap, ana sayfa">
            <SkyLabMark className="shell-brand__mark" size={26} />
            <span className="shell-brand__name">SKY LAB</span>
            <span className="shell-brand__product">Hesap</span>
          </Link>
          <div className="shell-bar__end">
            <EnvironmentBadge sandbox={sandbox} />
            {account}
          </div>
        </header>
      )}

      <nav className="shell-tabs" aria-label="Hesap bölümleri" ref={tabs}>
        {sections.map((href) => (
          <SectionLink key={href} href={href} active={current === href} badge={badgeFor(href)} withIcon={false} />
        ))}
      </nav>

      <div className="shell-body">
        <nav className="shell-nav" aria-label="Hesap ayarları">
          {sections.map((href) => (
            <SectionLink key={href} href={href} active={current === href} badge={badgeFor(href)} withIcon />
          ))}
        </nav>
        <main className="shell-content" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
