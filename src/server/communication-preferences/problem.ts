import "server-only";

import { RequestBodyError } from "@/server/auth/request-body";
import { CommunicationPreferencesInputError } from "@/server/communication-preferences/service";
import { CoreCommunicationPreferencesError } from "@/server/core/communication-preferences-client";
import type { AccountProblem } from "@/server/keycloak-account/problem";
import { toAccountProblem } from "@/server/keycloak-account/problem";

export type CommunicationPreferencesProblemCode =
  | "communication_preferences_disabled"
  | "communication_preferences_unavailable"
  | "communication_preference_teams_unavailable"
  | "communication_preference_team_unknown";

/** RFC 7807 problem for the preference routes and page; `retryAfterSeconds` accompanies a busy team tree when known. */
export type CommunicationPreferencesProblem = AccountProblem & {
  code?: CommunicationPreferencesProblemCode;
  retryAfterSeconds?: number;
};

const PROBLEM_BASE = "https://my.yildizskylab.com/problems/";

/** `CORE_API_URL` is unset in this environment. */
export const communicationPreferencesDisabledProblem: CommunicationPreferencesProblem = {
  type: `${PROBLEM_BASE}communication-preferences-disabled`,
  title: "İletişim tercihleri bu ortamda kapalı",
  status: 503,
  detail: "Bu ortamda core bağlantısı tanımlı değil; iletişim tercihleri burada görünmez. Hesap postaların bundan etkilenmez.",
  code: "communication_preferences_disabled",
};

/** Core has the routes but `COMMUNICATION_PREFERENCE_KEY` is unset: the feature is not switched on yet. */
export const communicationPreferencesOffProblem: CommunicationPreferencesProblem = {
  type: `${PROBLEM_BASE}communication-preferences-unavailable`,
  title: "İletişim tercihleri şu an kullanılamıyor",
  status: 503,
  detail: "Duyuru ve haber postası tercihleri henüz açılmadı. Açıldığında ekip ekip buradan yönetebileceksin; giriş kodu, bilet ve sertifika gibi hesap postaların bundan etkilenmez.",
  code: "communication_preferences_unavailable",
};

function withRetry(problem: CommunicationPreferencesProblem, seconds: number | null): CommunicationPreferencesProblem {
  return seconds === null ? problem : { ...problem, retryAfterSeconds: seconds };
}

export function toCommunicationPreferencesProblem(error: unknown): CommunicationPreferencesProblem {
  if (error instanceof CommunicationPreferencesInputError || error instanceof RequestBodyError) {
    if (error instanceof RequestBodyError && error.status === 413) {
      return {
        type: `${PROBLEM_BASE}communication-preferences-request-too-large`,
        title: "İstek çok büyük",
        status: 413,
        detail: "Gönderilen istek izin verilen boyutu aşıyor. Tercihlerin değişmedi.",
      };
    }
    return {
      type: `${PROBLEM_BASE}communication-preferences-invalid`,
      title: "İstek okunamadı",
      status: 400,
      detail: "İstek beklenen biçimde değil. Sayfayı yenileyip yeniden dene; tercihlerin değişmedi.",
    };
  }
  if (!(error instanceof CoreCommunicationPreferencesError)) return toAccountProblem(error);
  switch (error.failure) {
    case "off":
      return communicationPreferencesOffProblem;
    case "teams_unavailable":
      return withRetry({
        type: `${PROBLEM_BASE}communication-preferences-teams-unavailable`,
        title: "Ekip bilgisi şu anda alınamıyor",
        status: 503,
        detail: "Ekiplerin okunamadı; tercihlerin değişmedi. Biraz sonra yeniden dene.",
        code: "communication_preference_teams_unavailable",
      }, error.retryAfterSeconds);
    case "team_unknown":
      return {
        type: `${PROBLEM_BASE}communication-preferences-team-unknown`,
        title: "Bu ekip bulunamadı",
        status: 400,
        detail: "Ekip silinmiş, taşınmış ya da artık herkese açık değil olabilir. Sayfayı yenileyip yeniden dene; tercihlerin değişmedi.",
        code: "communication_preference_team_unknown",
      };
    case "unauthorized":
      return {
        type: `${PROBLEM_BASE}communication-preferences-reauthentication`,
        title: "İletişim tercihleri için yeniden giriş yapman gerekiyor",
        status: 401,
        detail: "Oturumunun core erişimi doğrulanamadı. Yeniden giriş yapmak sorunu genellikle çözer; tercihlerin değişmedi.",
      };
    case "forbidden":
    case "subject_inactive":
      return {
        type: `${PROBLEM_BASE}communication-preferences-forbidden`,
        title: "İletişim tercihleri bu hesap için kullanılamıyor",
        status: 403,
        detail: "Core bu hesap için tercih yazmadı; hesabın silinmeye alınmış olabilir. Sorun sürerse yönetim ekibiyle iletişime geç.",
      };
    case "contract":
      return {
        type: `${PROBLEM_BASE}communication-preferences-contract`,
        title: "İletişim tercihleri güvenle durduruldu",
        status: 502,
        detail: "Core yanıtı desteklenen sözleşmeyle eşleşmedi; hiçbir ham bilgi gösterilmedi.",
      };
    case "rejected":
    case "invalid_input":
      return {
        type: `${PROBLEM_BASE}communication-preferences-rejected`,
        title: "Core isteği kabul etmedi",
        status: 400,
        detail: "Tercih değişikliği core tarafından kabul edilmedi. Sayfayı yenileyip yeniden dene; tercihlerin değişmedi.",
      };
    case "unavailable":
      return {
        type: `${PROBLEM_BASE}communication-preferences-core-unavailable`,
        title: "İletişim tercihlerine şu anda ulaşılamıyor",
        status: 503,
        detail: "Core hizmeti yanıt vermedi; tercihlerin değişmedi. Kısa bir süre sonra yeniden deneyebilirsin.",
      };
  }
}
