"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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

function isActivePath(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

function DesktopNavigation({ pathname }: { pathname: string }) {
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

      <button className="account-sidebar__sign-out" type="button" disabled>
        <LogOut aria-hidden="true" size={17} />
        <span>Çıkış yap</span>
      </button>
    </aside>
  );
}

function MobileHeader({ pathname }: { pathname: string }) {
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
      <span className="mobile-header__balance" aria-hidden="true" />
    </header>
  );
}

export function AccountShell({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();

  return (
    <div className="account-root">
      <a className="skip-link" href="#main-content">İçeriğe geç</a>
      <Background />
      <div className="account-frame">
        <DesktopNavigation pathname={pathname} />
        <MobileHeader pathname={pathname} />
        <main className="account-content" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
