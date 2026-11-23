import {
  Bell,
  House,
  IdCard,
  LayoutGrid,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Account Center's pages. Six sections, as in Google Account (Ana sayfa, Kişisel bilgiler,
 * Güvenlik, Veri ve gizlilik, Bildirimler, Uygulamalar); each section has its own page and may
 * hold sub-pages. Sub-pages keep the addresses they always had (`/identity`, `/email`, …), so
 * every existing link, mail and the YTÜ and Sudo mode returns land where they did; only the menu
 * places them under their section.
 */
export type AccountRoutePath =
  | "/"
  | "/personal-info"
  | "/identity"
  | "/email"
  | "/club-profile"
  | "/security"
  | "/sessions"
  | "/privacy"
  | "/communication-preferences"
  | "/delete-account"
  | "/notifications"
  | "/apps"
  | "/permissions"
  | "/app-preferences";

export type AccountSectionPath = "/" | "/personal-info" | "/security" | "/privacy" | "/notifications" | "/apps";

export type AccountRoute = Readonly<{
  href: AccountRoutePath;
  /** The section the page belongs to; a section's own page names itself. */
  section: AccountSectionPath;
  documentTitle: string;
  title: string;
  tone?: "default" | "danger";
}>;

export type AccountSection = Readonly<{
  href: AccountSectionPath;
  label: string;
  icon: LucideIcon;
}>;

export const accountSections = [
  { href: "/", label: "Ana sayfa", icon: House },
  { href: "/personal-info", label: "Kişisel bilgiler", icon: IdCard },
  { href: "/security", label: "Güvenlik", icon: ShieldCheck },
  { href: "/privacy", label: "Veri ve gizlilik", icon: SlidersHorizontal },
  { href: "/notifications", label: "Bildirimler", icon: Bell },
  { href: "/apps", label: "Uygulamalar", icon: LayoutGrid },
] as const satisfies readonly AccountSection[];

export const accountRoutes = [
  { href: "/", section: "/", documentTitle: "Ana sayfa", title: "Ana sayfa" },
  { href: "/personal-info", section: "/personal-info", documentTitle: "Kişisel bilgiler", title: "Kişisel bilgiler" },
  { href: "/identity", section: "/personal-info", documentTitle: "Kimlik", title: "Kimlik" },
  { href: "/email", section: "/personal-info", documentTitle: "E-posta", title: "E-posta" },
  { href: "/club-profile", section: "/personal-info", documentTitle: "Kulüp profili", title: "Kulüp profili" },
  { href: "/security", section: "/security", documentTitle: "Güvenlik", title: "Güvenlik" },
  { href: "/sessions", section: "/security", documentTitle: "Cihazlar", title: "Cihazlar" },
  { href: "/privacy", section: "/privacy", documentTitle: "Veri ve gizlilik", title: "Veri ve gizlilik" },
  {
    href: "/communication-preferences",
    section: "/privacy",
    documentTitle: "İletişim tercihleri",
    title: "İletişim tercihleri",
  },
  { href: "/delete-account", section: "/privacy", documentTitle: "Hesabı sil", title: "Hesabı sil", tone: "danger" },
  { href: "/notifications", section: "/notifications", documentTitle: "Bildirimler", title: "Bildirimler" },
  { href: "/apps", section: "/apps", documentTitle: "Uygulamalar", title: "Uygulamalar" },
  { href: "/permissions", section: "/apps", documentTitle: "Yetkiler", title: "Yetkiler" },
  { href: "/app-preferences", section: "/apps", documentTitle: "Uygulama ayarları", title: "Uygulama ayarları" },
] as const satisfies readonly AccountRoute[];

export function accountRoute(path: AccountRoutePath): AccountRoute {
  const route = accountRoutes.find(({ href }) => href === path);
  if (!route) {
    throw new Error(`Missing account route metadata for ${path}`);
  }
  return route;
}

export function accountSection(path: AccountSectionPath): AccountSection {
  return accountSections.find(({ href }) => href === path)!;
}

export function matchAccountRoute(pathname: string): AccountRoute | null {
  return accountRoutes.find(({ href }) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`),
  ) ?? null;
}
