"use client";

import { useState } from "react";
import { LockKeyhole, Trash2 } from "lucide-react";

const CONFIRMATION = "HESABIMI SİL";

export function AccountDeletionConfirmation({
  csrfToken,
  deletionError,
  enabled,
  reauthenticated,
  reauthenticationCancelled = false,
}: {
  csrfToken: string;
  deletionError?: "proof_expired" | "reauth_unavailable" | "deletion_unavailable";
  enabled: boolean;
  reauthenticated: boolean;
  reauthenticationCancelled?: boolean;
}) {
  const [confirmation, setConfirmation] = useState("");
  const errorFeedback = deletionError === "proof_expired"
    ? "Doğrulama süren doldu veya silme onayın geçersizdi. Devam etmek için kimliğini yeniden doğrula."
    : deletionError === "reauth_unavailable"
      ? "Yeniden doğrulama başlatılamadı. Hesabında hiçbir değişiklik yapılmadı; kısa bir süre sonra tekrar dene."
      : deletionError === "deletion_unavailable"
        ? "Hesap silme işlemi şu anda başlatılamıyor. Hesabında hiçbir değişiklik yapılmadı; kısa bir süre sonra tekrar dene."
        : null;
  const feedback = errorFeedback ? (
    <p className="deletion-step__feedback" role="status">{errorFeedback}</p>
  ) : null;

  if (!enabled) {
    return (
      <>
        {feedback}
        <div className="deletion-step" data-tone="muted">
          <strong>Silme akışı henüz etkin değil</strong>
          <span>Hazırlıklar tamamlandığında bu ekrandan güvenle başlatabileceksin.</span>
        </div>
      </>
    );
  }

  if (!reauthenticated) {
    return (
      <>
        {feedback}
        <div className="deletion-step">
        <span className="deletion-step__icon" aria-hidden="true">
          <LockKeyhole size={18} />
        </span>
        <div>
          <strong>Önce kimliğini yeniden doğrula</strong>
          <p>Başka biri açık oturumunu kullanıyor olsa bile hesabını silememesi için yeniden giriş isteyeceğiz.</p>
          {reauthenticationCancelled && !errorFeedback ? (
            <p className="deletion-step__feedback" role="status">
              Yeniden doğrulama tamamlanmadı. Hesabında hiçbir değişiklik yapılmadı.
            </p>
          ) : null}
          <form action="/api/account/deletion/reauthenticate" method="post">
            <input type="hidden" name="csrfToken" value={csrfToken} />
            <button className="primary-button" type="submit">
              Kimliğimi yeniden doğrula
            </button>
          </form>
        </div>
        </div>
      </>
    );
  }

  return (
    <>
      {feedback}
      <div className="deletion-step" data-tone="danger">
      <span className="deletion-step__icon" aria-hidden="true">
        <Trash2 size={18} />
      </span>
      <div>
        <strong>Son onay</strong>
        <p>
          Bu işlem geri alınamaz. Devam etmek için aşağıdaki alana büyük harflerle
          {" "}<b>{CONFIRMATION}</b> yaz.
        </p>
        <form action="/api/account/deletion" className="deletion-confirmation" method="post">
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <label htmlFor="account-deletion-confirmation">Onay metni</label>
          <input
            autoComplete="off"
            id="account-deletion-confirmation"
            name="confirmation"
            onChange={(event) => setConfirmation(event.currentTarget.value)}
            spellCheck={false}
            value={confirmation}
          />
          <button
            className="danger-button"
            disabled={confirmation !== CONFIRMATION}
            type="submit"
          >
            Hesabımı kalıcı olarak sil
          </button>
        </form>
        <p className="deletion-step__feedback" role="status">
          Yeniden doğrulaman kısa süre geçerlidir. Süre dolarsa bu adımı yeniden başlatman gerekir.
        </p>
      </div>
      </div>
    </>
  );
}
