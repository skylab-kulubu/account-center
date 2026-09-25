import "server-only";

import {
  CLUB_PROFILE_LINKEDIN_MAX_LENGTH,
  CLUB_PROFILE_TEXT_MAX_LENGTH,
} from "@/config/club-profile";
import type { ClubProfileEditableField } from "@/config/club-profile";
import { RequestBodyError } from "@/server/auth/request-body";
import {
  ClubProfilePictureError,
  ClubProfileValidationError,
} from "@/server/club-profile/validation";
import {
  CoreProfileContractError,
  CoreProfileForbiddenError,
  CoreProfileInvalidInputError,
  CoreProfileNotFoundError,
  CoreProfileRejectedError,
  CoreProfileUnauthorizedError,
  CoreProfileUnavailableError,
} from "@/server/core/profile-client";
import type { AccountProblem } from "@/server/keycloak-account/problem";
import { toAccountProblem } from "@/server/keycloak-account/problem";

/** RFC 7807 problem for the club-profile surface; `field` names the rejected form field when there is one. */
export type ClubProfileProblem = AccountProblem & { field?: ClubProfileEditableField };

const PROBLEM_BASE = "https://my.yildizskylab.com/problems/";

const fieldLabels: Readonly<Record<ClubProfileEditableField, string>> = {
  university: "Üniversite",
  faculty: "Fakülte",
  department: "Bölüm",
  linkedin: "LinkedIn bağlantısı",
};

export const clubProfileDisabledProblem: ClubProfileProblem = {
  type: `${PROBLEM_BASE}club-profile-disabled`,
  title: "Kulüp profili bu ortamda kapalı",
  status: 503,
  detail: "Bu ortamda core bağlantısı tanımlı değil; SKY numarası, öğrenci kartı ve kulüp bilgileri burada görünmez. Kimlik bilgilerin bundan etkilenmez.",
};

/** A change to a field that follows the YTÜ login; `field` is set when the BFF caught it. */
function ytuManagedProblem(field?: ClubProfileEditableField): ClubProfileProblem {
  return {
    type: `${PROBLEM_BASE}club-profile-ytu-managed`,
    title: "Bu bilgi YTÜ hesabından gelir",
    status: 409,
    detail: "Üniversite, fakülte ve bölüm her YTÜ girişinde YTÜ hesabından güncellenir; buradan değiştirilemez. Kulüp profilin değişmedi.",
    ...(field ? { field } : {}),
  };
}

export const pictureTooLargeProblem: ClubProfileProblem = {
  type: `${PROBLEM_BASE}club-profile-picture`,
  title: "Fotoğraf çok büyük",
  status: 413,
  detail: "En fazla 5 MB boyutunda bir PNG, JPEG ya da WebP seçebilirsin. Profil fotoğrafın değişmedi.",
};

/** Whether the failure came from the core client, as opposed to the Keycloak session or token path. */
export function isCoreProfileError(error: unknown) {
  return (
    error instanceof CoreProfileUnavailableError ||
    error instanceof CoreProfileUnauthorizedError ||
    error instanceof CoreProfileForbiddenError ||
    error instanceof CoreProfileNotFoundError ||
    error instanceof CoreProfileRejectedError ||
    error instanceof CoreProfileContractError ||
    error instanceof CoreProfileInvalidInputError
  );
}

function validationDetail(error: ClubProfileValidationError) {
  const label = error.field === "body" ? "Alan" : fieldLabels[error.field];
  switch (error.reason) {
    case "invalid_body":
      return "İstek gövdesi okunamadı. Sayfayı yenileyip yeniden dene.";
    case "unknown_field":
      return "Bu sayfadan yalnızca üniversite, fakülte, bölüm ve LinkedIn bağlantısı düzenlenebilir.";
    case "not_text":
      return `${label} metin olmalı.`;
    case "too_long":
      return error.field === "linkedin"
        ? `${label} en fazla ${CLUB_PROFILE_LINKEDIN_MAX_LENGTH} karakter olabilir.`
        : `${label} en fazla ${CLUB_PROFILE_TEXT_MAX_LENGTH} karakter olabilir.`;
    case "forbidden_characters":
      return `${label} görünmez, biçimlendirme ya da kontrol karakteri içeremez.`;
    case "linkedin_url":
      return "LinkedIn bağlantısı https:// ile başlamalı ve linkedin.com ya da www.linkedin.com adresinde olmalı.";
    case "ytu_managed":
      return ytuManagedProblem().detail;
  }
}

function rejectedProblem(status: number): ClubProfileProblem {
  if (status === 413) return pictureTooLargeProblem;
  // Core answers 409 on /v1/users/me only for a YTÜ field change (`ytu_managed_field`).
  if (status === 409) return ytuManagedProblem();
  if (status === 415) {
    return {
      type: `${PROBLEM_BASE}club-profile-picture`,
      title: "Dosya türü desteklenmiyor",
      status: 415,
      detail: "Core bu dosya türünü kabul etmedi. PNG, JPEG ya da WebP seç. Profil fotoğrafın değişmedi.",
    };
  }
  if (status === 429) {
    return {
      type: `${PROBLEM_BASE}club-profile-rejected`,
      title: "Çok fazla deneme",
      status: 429,
      detail: "Kısa bir süre bekleyip yeniden dene. Kulüp profilin değişmedi.",
    };
  }
  return {
    type: `${PROBLEM_BASE}club-profile-rejected`,
    title: "Core isteği kabul etmedi",
    status: 400,
    detail: "Gönderilen bilgi core tarafından kabul edilmedi. Kulüp profilin değişmedi.",
  };
}

export function toClubProfileProblem(error: unknown): ClubProfileProblem {
  if (error instanceof ClubProfileValidationError) {
    if (error.reason === "ytu_managed" && error.field !== "body") return ytuManagedProblem(error.field);
    return {
      type: `${PROBLEM_BASE}club-profile-invalid`,
      title: "Bilgiler doğrulanamadı",
      status: 400,
      detail: validationDetail(error),
      ...(error.field === "body" ? {} : { field: error.field }),
    };
  }
  if (error instanceof ClubProfilePictureError) {
    if (error.reason === "too_large") return pictureTooLargeProblem;
    if (error.reason === "unsupported_type") {
      return {
        type: `${PROBLEM_BASE}club-profile-picture`,
        title: "Dosya türü desteklenmiyor",
        status: 415,
        detail: "Yalnızca PNG, JPEG ve WebP kabul edilir; seçtiğin dosyanın içeriği bunlardan biri değil. Profil fotoğrafın değişmedi.",
      };
    }
    return {
      type: `${PROBLEM_BASE}club-profile-picture`,
      title: "Dosya boş",
      status: 400,
      detail: "Seçtiğin dosya boş görünüyor. Başka bir fotoğraf seç.",
    };
  }
  if (error instanceof RequestBodyError) {
    if (error.status === 413) {
      return {
        type: `${PROBLEM_BASE}club-profile-request-too-large`,
        title: "İstek çok büyük",
        status: 413,
        detail: "Gönderilen istek izin verilen boyutu aşıyor. Kulüp profilin değişmedi.",
      };
    }
    return {
      type: `${PROBLEM_BASE}club-profile-invalid`,
      title: "İstek okunamadı",
      status: 400,
      detail: "İstek gövdesi beklenen biçimde değil. Sayfayı yenileyip yeniden dene.",
    };
  }
  if (error instanceof CoreProfileUnavailableError) {
    return {
      type: `${PROBLEM_BASE}club-profile-unavailable`,
      title: "Kulüp profiline şu anda ulaşılamıyor",
      status: 503,
      detail: "Core hizmeti yanıt vermedi. Kulüp profilin değişmedi; kısa bir süre sonra yeniden deneyebilirsin.",
    };
  }
  if (error instanceof CoreProfileUnauthorizedError) {
    return {
      type: `${PROBLEM_BASE}club-profile-reauthentication`,
      title: "Kulüp profili için yeniden giriş yapman gerekiyor",
      status: 401,
      detail: "Oturumunun core erişimi doğrulanamadı. Yeniden giriş yapmak sorunu genellikle çözer; kulüp profilin değişmedi.",
    };
  }
  if (error instanceof CoreProfileForbiddenError) {
    return {
      type: `${PROBLEM_BASE}club-profile-forbidden`,
      title: "Kulüp profili işlemine izin verilmedi",
      status: 403,
      detail: "Core bu işlemi reddetti; kulüp profilin değişmedi. Sorun sürerse yönetim ekibiyle iletişime geç.",
    };
  }
  if (error instanceof CoreProfileNotFoundError) {
    return {
      type: `${PROBLEM_BASE}club-profile-missing`,
      title: "Kulüp profili bulunamadı",
      status: 404,
      detail: "Core'da hesabına bağlı bir kulüp profili yok. Sorun sürerse yönetim ekibiyle iletişime geç.",
    };
  }
  if (error instanceof CoreProfileRejectedError) return rejectedProblem(error.status);
  if (error instanceof CoreProfileContractError) {
    return {
      type: `${PROBLEM_BASE}club-profile-contract`,
      title: "Kulüp profili güvenle durduruldu",
      status: 502,
      detail: "Core yanıtı desteklenen sözleşmeyle eşleşmedi. Hiçbir ham kulüp bilgisi gösterilmedi.",
    };
  }
  if (error instanceof CoreProfileInvalidInputError) {
    return {
      type: `${PROBLEM_BASE}club-profile-invalid`,
      title: "Bilgiler doğrulanamadı",
      status: 400,
      detail: "Gönderilen bilgi core sözleşmesine uymuyor. Kulüp profilin değişmedi.",
    };
  }
  return toAccountProblem(error);
}
