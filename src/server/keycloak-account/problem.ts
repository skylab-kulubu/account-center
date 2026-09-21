import "server-only";

import { ActiveSessionTokenDecryptError } from "@/server/auth/sessions";
import {
  AccountAccessTokenContractError,
  AccountAccessTokenExpiredError,
} from "@/server/keycloak-account/access-token";
import {
  KeycloakAccountForbiddenError,
  KeycloakAccountLinkingDisabledError,
  KeycloakAccountUnauthorizedError,
  KeycloakAccountUnavailableError,
} from "@/server/keycloak-account/adapter";
import { KeycloakAccountContractError } from "@/server/keycloak-account/schema";
import { AccountReauthenticationRequiredError } from "@/server/keycloak-account/service";

export type AccountProblem = {
  type: string;
  title: string;
  status: number;
  detail: string;
};

const contractProblem: AccountProblem = {
  type: "https://my.yildizskylab.com/problems/identity-contract",
  title: "Kimlik bilgileri güvenle durduruldu",
  status: 502,
  detail: "Kimlik sağlayıcısının yanıtı desteklenen sürümle eşleşmedi. Hiçbir ham hesap bilgisi gösterilmedi.",
};

export function toAccountProblem(error: unknown): AccountProblem {
  if (
    error instanceof KeycloakAccountContractError ||
    error instanceof AccountAccessTokenContractError ||
    error instanceof KeycloakAccountForbiddenError
  ) {
    return contractProblem;
  }
  if (
    error instanceof AccountReauthenticationRequiredError ||
    error instanceof KeycloakAccountUnauthorizedError ||
    error instanceof AccountAccessTokenExpiredError
  ) {
    return {
      type: "https://my.yildizskylab.com/problems/reauthentication-required",
      title: "Yeniden giriş yapman gerekiyor",
      status: 401,
      detail: "Kimlik oturumun yenilenemedi. Güvenli biçimde devam etmek için yeniden giriş yap.",
    };
  }
  if (error instanceof KeycloakAccountLinkingDisabledError) {
    return {
      type: "https://my.yildizskylab.com/problems/account-linking-unavailable",
      title: "Hesap bağlama şu anda kullanılamıyor",
      status: 503,
      detail: "Kimlik sağlayıcısı bağlantı akışı bu ortamda kapalı. Hesap bilgilerin değişmedi.",
    };
  }
  if (error instanceof KeycloakAccountUnavailableError) {
    return {
      type: "https://my.yildizskylab.com/problems/identity-unavailable",
      title: "Kimlik hizmetine şu anda ulaşılamıyor",
      status: 503,
      detail: "Hesap bilgilerin değişmedi. Kısa bir süre sonra yeniden deneyebilirsin.",
    };
  }
  if (error instanceof ActiveSessionTokenDecryptError) {
    return {
      type: "https://my.yildizskylab.com/problems/session-material",
      title: "Güvenli oturum okunamadı",
      status: 500,
      detail: "Oturum materyali tarayıcıya aktarılmadı. Yeniden giriş yaparak devam edebilirsin.",
    };
  }
  return {
    type: "https://my.yildizskylab.com/problems/account-read",
    title: "Hesap bilgileri yüklenemedi",
    status: 500,
    detail: "Beklenmeyen bir sorun oluştu. Hesap bilgilerinin hiçbiri yanıta eklenmedi.",
  };
}
