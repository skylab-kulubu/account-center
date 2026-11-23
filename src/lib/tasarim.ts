/**
 * GEÇİCİ tasarım anahtarı (Hesap merkezi yeniden tasarımı, 23 Kasım 2026).
 * `?tasarim=a|b` bir çerez yazar; çerez yoksa bugünkü görünüm ("eski") kalır.
 * Yön seçilince bu dosya, çerez ve bütün `data-tasarim` dalları silinir.
 */
export const TASARIM_COOKIE = "tasarim";
export const TASARIMLAR = ["eski", "a", "b"] as const;
export type Tasarim = (typeof TASARIMLAR)[number];

export function parseTasarim(value: unknown): Tasarim {
  return value === "a" || value === "b" ? value : "eski";
}
