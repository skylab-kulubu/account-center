import { SayfaBasligi } from "@/components/sayfa-basligi-istemci";
import type { AccountRoute } from "@/config/account-routes";

/**
 * Sayfa başlığı. GEÇİCİ: A ve B'de yalnız kısa ad, açıklama paragrafı yok
 * (sayfanın ne olduğunu başlık ve içerik söyler). Eskide bugünkü başlık.
 * Sunucu sayfaları rotanın kendisini verir; istemciye yalnız adresi geçer.
 */
export function AccountPageHeader({ route }: { route: AccountRoute }) {
  return <SayfaBasligi href={route.href} />;
}
