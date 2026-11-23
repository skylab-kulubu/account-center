import "server-only";

import { cookies } from "next/headers";
import { parseTasarim, TASARIM_COOKIE } from "@/lib/tasarim";
import type { Tasarim } from "@/lib/tasarim";

/** GEÇİCİ: sunucu bileşenlerinde açık tasarım yönü. */
export async function currentTasarim(): Promise<Tasarim> {
  return parseTasarim((await cookies()).get(TASARIM_COOKIE)?.value);
}
