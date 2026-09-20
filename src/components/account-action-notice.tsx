"use client";

import { useEffect } from "react";
import type { AccountActionResult } from "@/server/auth/types";

const actionLabels = {
  password: "Şifre",
  otp: "İki adımlı doğrulama",
  passkey: "Passkey",
  "delete-credential": "Giriş yöntemi",
} as const;

export function AccountActionNotice({
  result,
  reference,
  csrfToken,
}: {
  result: AccountActionResult | null;
  reference?: string;
  csrfToken: string;
}) {
  useEffect(() => {
    if (!result || !reference) return;

    let firstFrame: number | undefined;
    let secondFrame: number | undefined;
    let cancelled = false;

    const acknowledge = () => {
      if (cancelled || firstFrame !== undefined) return;
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => {
          if (cancelled) return;
          void fetch(`/api/auth/action-result/${encodeURIComponent(reference)}`, {
            method: "POST",
            cache: "no-store",
            credentials: "same-origin",
            headers: { "x-csrf-token": csrfToken },
          }).catch(() => undefined);
        });
      });
    };
    const acknowledgeWhenVisible = () => {
      if (document.visibilityState === "visible") {
        document.removeEventListener("visibilitychange", acknowledgeWhenVisible);
        acknowledge();
      }
    };

    if (document.visibilityState === "visible") acknowledge();
    else document.addEventListener("visibilitychange", acknowledgeWhenVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", acknowledgeWhenVisible);
      if (firstFrame !== undefined) window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
    };
  }, [csrfToken, reference, result]);

  if (!result) return null;
  const label = actionLabels[result.action];
  const copy = result.outcome === "success"
    ? `${label} işlemi tamamlandı ve Keycloak’taki güncel durumla doğrulandı.`
    : result.outcome === "cancelled"
      ? `${label} işlemi iptal edildi; hesabında değişiklik yapılmadı.`
      : result.outcome === "unverified"
        ? `${label} işlemi Keycloak tarafından başarılı bildirildi ancak güncel hesap durumunda doğrulanamadı.`
        : `${label} işlemi tamamlanamadı. Tekrar deneyebilirsin.`;
  return (
    <div className="action-notice" data-tone={result.outcome === "success" ? "positive" : result.outcome === "cancelled" ? "neutral" : "warning"} role="status">
      <strong>{result.outcome === "success" ? "İşlem tamamlandı" : result.outcome === "cancelled" ? "İşlem iptal edildi" : "İşlem doğrulanamadı"}</strong>
      <span>{copy}</span>
    </div>
  );
}
