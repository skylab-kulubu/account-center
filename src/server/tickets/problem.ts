import "server-only";

import type { TicketCancelCode } from "@/lib/tickets";
import { CoreTicketsError } from "@/server/core/tickets-client";
import type { AccountProblem } from "@/server/keycloak-account/problem";
import { toAccountProblem } from "@/server/keycloak-account/problem";

export type TicketsProblem = AccountProblem & { code?: "tickets_disabled" | TicketCancelCode };

const PROBLEM_BASE = "https://my.yildizskylab.com/problems/";

/** `CORE_API_URL` is unset in this environment. */
export const ticketsDisabledProblem: TicketsProblem = {
  type: `${PROBLEM_BASE}tickets-disabled`,
  title: "Biletler bu ortamda kapalı",
  status: 503,
  detail: "Bu ortamda core bağlantısı tanımlı değil.",
  code: "tickets_disabled",
};

const REFUSALS: Record<TicketCancelCode, { title: string; detail: string }> = {
  ticket_cancel_closed: { title: "Etkinlik başladı", detail: "Bilet artık iptal edilemez." },
  event_ended: { title: "Etkinlik bitti", detail: "Bilet artık iptal edilemez." },
  ticket_checked_in: { title: "Girişin yazılmış", detail: "Girişi olan bilet iptal edilemez." },
  ticket_in_competition: { title: "Yarışmaya kayıtlısın", detail: "Yarışmadaki bilet iptal edilemez." },
};

export function toTicketsProblem(error: unknown): TicketsProblem {
  if (!(error instanceof CoreTicketsError)) return toAccountProblem(error);
  switch (error.failure) {
    case "refused":
      return error.code
        ? { type: `${PROBLEM_BASE}ticket-cancel-refused`, status: 409, code: error.code, ...REFUSALS[error.code] }
        : { type: `${PROBLEM_BASE}ticket-cancel-refused`, title: "Bilet iptal edilemez", status: 409, detail: "Sayfayı yenile." };
    case "unauthorized":
      return {
        type: `${PROBLEM_BASE}tickets-reauthentication`,
        title: "Biletler için yeniden giriş yapman gerekiyor",
        status: 401,
        detail: "Yeniden giriş yapmak sorunu genellikle çözer.",
      };
    case "forbidden":
    case "not_found":
      return {
        type: `${PROBLEM_BASE}ticket-not-found`,
        title: "Bilet buradan iptal edilemiyor",
        status: 404,
        detail: "Sayfayı yenile.",
      };
    case "rate_limited":
      return {
        type: `${PROBLEM_BASE}tickets-rate-limited`,
        title: "Çok fazla deneme",
        status: 429,
        detail: "Biraz bekleyip yeniden dene.",
      };
    case "contract":
      return {
        type: `${PROBLEM_BASE}tickets-contract`,
        title: "Biletler: beklenmeyen yanıt",
        status: 502,
        detail: "Sayfayı yenileyip yeniden dene.",
      };
    case "rejected":
    case "invalid_input":
      return {
        type: `${PROBLEM_BASE}tickets-rejected`,
        title: "İstek kabul edilmedi",
        status: 400,
        detail: "Sayfayı yenileyip yeniden dene.",
      };
    case "unavailable":
      return {
        type: `${PROBLEM_BASE}tickets-unavailable`,
        title: "Biletlere şu anda ulaşılamıyor",
        status: 503,
        detail: "Kısa bir süre sonra yeniden dene.",
      };
  }
}
