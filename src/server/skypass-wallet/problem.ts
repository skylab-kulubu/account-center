import "server-only";

import { isCoreSkyPassWalletError } from "@/server/core/skypass-wallet-client";
import type { AccountProblem } from "@/server/keycloak-account/problem";
import { toAccountProblem } from "@/server/keycloak-account/problem";

/** RFC 7807 problem for the SkyPass Wallet routes; `retryAfterSeconds` accompanies a 429 or a 502 when known. */
export type SkyPassWalletProblem = AccountProblem & { code?: SkyPassWalletProblemCode; retryAfterSeconds?: number };

export type SkyPassWalletProblemCode =
  | "skypass_google_wallet_off"
  | "skypass_wallet_pass_ended"
  | "skypass_wallet_rate_limited"
  | "skypass_google_wallet_unavailable";

const PROBLEM_BASE = "https://my.yildizskylab.com/problems/";

export const skyPassWalletDisabledProblem: SkyPassWalletProblem = {
  type: `${PROBLEM_BASE}skypass-wallet-off`,
  title: "Google Cüzdan şu anda kullanılamıyor",
  status: 503,
  detail: "SkyPass'i Google Cüzdan'a ekleme bu ortamda açık değil.",
  code: "skypass_google_wallet_off",
};

function withRetry(problem: SkyPassWalletProblem, seconds: number | null): SkyPassWalletProblem {
  return seconds === null ? problem : { ...problem, retryAfterSeconds: seconds };
}

export function toSkyPassWalletProblem(error: unknown): SkyPassWalletProblem {
  if (!isCoreSkyPassWalletError(error)) return toAccountProblem(error);
  switch (error.failure) {
    case "off":
      return skyPassWalletDisabledProblem;
    case "ended":
      return {
        type: `${PROBLEM_BASE}skypass-wallet-pass-ended`,
        title: "Pas hazırlanırken sona erdi",
        status: 409,
        detail: "Bağlantı yazılırken pasın kaldırıldı ya da hesabın silinmeye alındı; bağlantı verilmedi. Yeniden deneyebilirsin.",
        code: "skypass_wallet_pass_ended",
      };
    case "rate_limited":
      return withRetry({
        type: `${PROBLEM_BASE}skypass-wallet-rate-limited`,
        title: "Çok fazla deneme",
        status: 429,
        detail: "Bir dakikada en fazla 10 kez Google Cüzdan bağlantısı istenebilir ya da pas kaldırılabilir. Biraz bekleyip yeniden dene.",
        code: "skypass_wallet_rate_limited",
      }, error.retryAfterSeconds);
    case "google_unavailable":
      return withRetry({
        type: `${PROBLEM_BASE}skypass-wallet-google-unavailable`,
        title: "Google Cüzdan yanıt vermedi",
        status: 502,
        detail: "Google isteği almadı ya da zamanında yanıt vermedi. Biraz sonra yeniden dene.",
        code: "skypass_google_wallet_unavailable",
      }, error.retryAfterSeconds);
    case "unauthorized":
      return {
        type: `${PROBLEM_BASE}skypass-wallet-reauthentication`,
        title: "SkyPass için yeniden giriş yapman gerekiyor",
        status: 401,
        detail: "Oturumunun core erişimi doğrulanamadı. Yeniden giriş yapmak sorunu genellikle çözer.",
      };
    case "forbidden":
    case "not_found":
      return {
        type: `${PROBLEM_BASE}skypass-wallet-unavailable-for-account`,
        title: "SkyPass bu hesap için kullanılamıyor",
        status: 403,
        detail: "Core bu hesap için SkyPass vermedi; hesabın silinmeye alınmış olabilir. Sorun sürerse yönetim ekibiyle iletişime geç.",
      };
    case "contract":
      return {
        type: `${PROBLEM_BASE}skypass-wallet-contract`,
        title: "Google Cüzdan işlemi güvenle durduruldu",
        status: 502,
        detail: "Core yanıtı desteklenen sözleşmeyle eşleşmedi; hiçbir bağlantı açılmadı.",
      };
    case "rejected":
    case "invalid_input":
      return {
        type: `${PROBLEM_BASE}skypass-wallet-rejected`,
        title: "Core isteği kabul etmedi",
        status: 400,
        detail: "Google Cüzdan isteği core tarafından kabul edilmedi. Sayfayı yenileyip yeniden dene.",
      };
    case "unavailable":
      return {
        type: `${PROBLEM_BASE}skypass-wallet-core-unavailable`,
        title: "SkyPass'e şu anda ulaşılamıyor",
        status: 503,
        detail: "Core hizmeti yanıt vermedi. Kısa bir süre sonra yeniden deneyebilirsin.",
      };
  }
}
