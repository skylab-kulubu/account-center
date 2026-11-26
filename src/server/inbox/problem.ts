import "server-only";

import { InboxInputError } from "@/server/inbox/service";
import type { AccountProblem } from "@/server/keycloak-account/problem";
import { toAccountProblem } from "@/server/keycloak-account/problem";
import { SkyNotifyInboxError } from "@/server/skynotify/inbox-client";

export type InboxProblem = AccountProblem & { code?: "inbox_disabled" | "inbox_not_enabled" };

const PROBLEM_BASE = "https://my.yildizskylab.com/problems/";

/** `SKYNOTIFY_API_URL` is unset in this environment. */
export const inboxDisabledProblem: InboxProblem = {
  type: `${PROBLEM_BASE}inbox-disabled`,
  title: "Bildirimler bu ortamda kapalı",
  status: 503,
  detail: "Bu ortamda SkyNotify bağlantısı tanımlı değil; bildirimler burada görünmez.",
  code: "inbox_disabled",
};

export function toInboxProblem(error: unknown): InboxProblem {
  if (error instanceof InboxInputError) {
    return {
      type: `${PROBLEM_BASE}inbox-invalid`,
      title: "İstek okunamadı",
      status: 400,
      detail: "İstek beklenen biçimde değil. Sayfayı yenileyip yeniden dene.",
    };
  }
  if (!(error instanceof SkyNotifyInboxError)) return toAccountProblem(error);
  switch (error.failure) {
    case "unauthorized":
      return {
        type: `${PROBLEM_BASE}inbox-reauthentication`,
        title: "Bildirimler için yeniden giriş yapman gerekiyor",
        status: 401,
        detail: "Oturumunun SkyNotify erişimi doğrulanamadı. Yeniden giriş yapmak sorunu genellikle çözer.",
      };
    case "forbidden":
      return {
        type: `${PROBLEM_BASE}inbox-forbidden`,
        title: "Bildirimler bu hesap için kullanılamıyor",
        status: 403,
        detail: "SkyNotify bu hesabın bildirimlerini göstermedi; hesabın silinmeye alınmış olabilir.",
      };
    case "not_found":
      return {
        type: `${PROBLEM_BASE}inbox-item-not-found`,
        title: "Bildirim bulunamadı",
        status: 404,
        detail: "Bildirim silinmiş ya da süresi dolmuş olabilir. Sayfayı yenile.",
      };
    case "not_enabled":
      return {
        type: `${PROBLEM_BASE}inbox-not-enabled`,
        title: "Bildirimler henüz açık değil",
        status: 503,
        detail: "Bildirimler açıldığında burada görünür.",
        code: "inbox_not_enabled",
      };
    case "contract":
      return {
        type: `${PROBLEM_BASE}inbox-contract`,
        title: "Bildirimler: beklenmeyen yanıt",
        status: 502,
        detail: "Sayfayı yenileyip yeniden dene.",
      };
    case "rejected":
    case "invalid_input":
      return {
        type: `${PROBLEM_BASE}inbox-rejected`,
        title: "SkyNotify isteği kabul etmedi",
        status: 400,
        detail: "Sayfayı yenileyip yeniden dene.",
      };
    case "unavailable":
      return {
        type: `${PROBLEM_BASE}inbox-unavailable`,
        title: "Bildirimlere şu anda ulaşılamıyor",
        status: 503,
        detail: "SkyNotify yanıt vermedi. Kısa bir süre sonra yeniden deneyebilirsin.",
      };
  }
}
