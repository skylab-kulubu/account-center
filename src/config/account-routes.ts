import {
  CircleUserRound,
  KeyRound,
  LayoutDashboard,
  MonitorSmartphone,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type AccountRoutePath =
  | "/"
  | "/personal-information"
  | "/security"
  | "/sessions"
  | "/permissions"
  | "/delete-account";

export type AccountRoute = Readonly<{
  href: AccountRoutePath;
  navigationLabel: string;
  documentTitle: string;
  eyebrow?: string;
  title: string;
  description: string;
  icon: LucideIcon;
  tone?: "default" | "danger";
}>;

export const accountRoutes = [
  {
    href: "/",
    navigationLabel: "Özet",
    documentTitle: "Hesap özeti",
    eyebrow: "SKY LAB",
    title: "Hesabın, tek ve güvenli bir merkezde.",
    description: "Kimlik bilgilerini, giriş yöntemlerini ve açık oturumlarını buradan yönetebilirsin.",
    icon: LayoutDashboard,
    tone: "default",
  },
  {
    href: "/personal-information",
    navigationLabel: "Kişisel bilgiler",
    documentTitle: "Kişisel bilgiler",
    title: "Kişisel bilgiler",
    description: "SKY LAB kimliğindeki adını ve birincil e-posta adresini yalnızca görüntüleyebilirsin.",
    icon: CircleUserRound,
    tone: "default",
  },
  {
    href: "/security",
    navigationLabel: "Giriş ve güvenlik",
    documentTitle: "Giriş ve güvenlik",
    title: "Giriş ve güvenlik",
    description: "Şifreni, passkey’lerini ve iki adımlı doğrulamayı tek yerden yönet. Her değişiklik yeniden doğrulama ister.",
    icon: KeyRound,
    tone: "default",
  },
  {
    href: "/sessions",
    navigationLabel: "Oturumlar ve cihazlar",
    documentTitle: "Oturumlar ve cihazlar",
    title: "Oturumlar ve cihazlar",
    description: "Hesabının açık olduğu cihazları gör ve tanımadığın oturumların erişimini kaldır.",
    icon: MonitorSmartphone,
    tone: "default",
  },
  {
    href: "/permissions",
    navigationLabel: "Yetkilerim",
    documentTitle: "Yetkilerim",
    title: "Yetkilerim",
    description: "Takımlarını, yetki seviyeni ve SKY LAB uygulamalarında neler yapabildiğini burada görebilirsin. Bu görünüm salt okunurdur.",
    icon: ShieldCheck,
    tone: "default",
  },
  {
    href: "/delete-account",
    navigationLabel: "Hesabı sil",
    documentTitle: "Hesabı sil",
    title: "Hesabı sil",
    description: "Bu işlem geri alınamaz. Devam etmeden önce hesabına ve kayıtlarına ne olacağını açıkça göreceksin.",
    icon: Trash2,
    tone: "danger",
  },
] as const satisfies readonly AccountRoute[];

export function accountRoute(path: AccountRoutePath): AccountRoute {
  const route = accountRoutes.find(({ href }) => href === path);
  if (!route) {
    throw new Error(`Missing account route metadata for ${path}`);
  }
  return route;
}

export function matchAccountRoute(pathname: string): AccountRoute | null {
  return accountRoutes.find(({ href }) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`),
  ) ?? null;
}
