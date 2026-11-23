"use client";

import { AccountPageHeader as EskiBaslik } from "@/components/settings";
import { useTasarim } from "@/components/tasarim-baglam";
import { accountRoute, accountShortLabels } from "@/config/account-routes";
import type { AccountRoutePath } from "@/config/account-routes";

export function SayfaBasligi({ href }: { href: AccountRoutePath }) {
  const tasarim = useTasarim();
  if (tasarim === "eski") return <EskiBaslik route={accountRoute(href)} />;
  return (
    <header className="sayfa-basligi">
      <h1>{accountShortLabels[href]}</h1>
    </header>
  );
}
