"use client";

import { useState } from "react";
import { LockKeyhole, Trash2 } from "lucide-react";
import { useSudo } from "@/components/sudo-provider";
import { isObject, runWithSudo } from "@/lib/security-client";

const CONFIRMATION = "HESABIMI SİL";

/**
 * Why the submit sent the person back. `sudo_required`: the Sudo mode proof
 * lapsed before the submit; `sudo_rejected`: core refused the proof sealed
 * into the confirmation (expired, or its Keycloak session ended), so nothing
 * was accepted and the vault has dropped it.
 */
export type AccountDeletionError =
  | "proof_expired"
  | "deletion_unavailable"
  | "sudo_required"
  | "sudo_rejected";

/**
 * `intent` is the person saying they want the account gone and `confirm` the
 * literal confirmation text. Sudo mode sits between the two and has no card
 * of its own: it is the dialog the provider opens, and its proof is also what
 * the BFF presents to core.
 */
type Step = "intent" | "confirm";

const copy = {
  sudoCancelled: "Kimlik doğrulaman tamamlanmadı. Hesabında hiçbir değişiklik yapılmadı.",
  spiTokenRequired: "Doğrulaman tamamlandı ama hesap silme için ek doğrulama gerekiyor. Hesabında hiçbir değişiklik yapılmadı; tekrar dene.",
  unavailable: "Hesap silme işlemi şu anda başlatılamıyor. Hesabında hiçbir değişiklik yapılmadı; kısa bir süre sonra tekrar dene.",
  sessionEnded: "Oturumun sona ermiş görünüyor. Sayfayı yenileyip yeniden dene.",
} as const;

const errorFeedback: Record<AccountDeletionError, string> = {
  proof_expired: "Doğrulama süren doldu veya silme onayın geçersizdi. Devam etmek için kimliğini yeniden doğrula.",
  deletion_unavailable: copy.unavailable,
  sudo_required: "Kimlik doğrulaman geçerliliğini yitirdi. Devam etmek için kimliğini yeniden doğrula.",
  sudo_rejected: "Silme isteğin için kimlik doğrulaman kabul edilmedi ya da süresi doldu. Hesabında hiçbir değişiklik yapılmadı. Devam etmek için kimliğini yeniden doğrula.",
};

/**
 * The delete-account flow in the order the person walks it: confirm the
 * intent, prove who they are with Sudo mode, and only then type the literal
 * confirmation and submit. `POST .../deletion/prepare` seals the Sudo mode
 * proof into the confirmation; there is no Keycloak round trip.
 */
export function AccountDeletionConfirmation({
  csrfToken,
  deletionError,
  enabled,
  reauthenticated,
}: {
  csrfToken: string;
  deletionError?: AccountDeletionError;
  enabled: boolean;
  reauthenticated: boolean;
}) {
  const { ensureSudo } = useSudo();
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  /** Once the person has started, the recovery message the page arrived with is spent. */
  const [attempted, setAttempted] = useState(false);
  // A reload inside the window still carries the proof cookie, so it lands on
  // the confirmation; a lapsed or refused sudo proof starts over.
  const [step, setStep] = useState<Step>(
    reauthenticated && deletionError !== "sudo_required" && deletionError !== "sudo_rejected"
      ? "confirm"
      : "intent",
  );
  const shownFeedback = feedback ??
    (attempted || !deletionError ? null : errorFeedback[deletionError]);

  const start = async () => {
    if (pending) return;
    setPending(true);
    setAttempted(true);
    setFeedback(null);
    try {
      if (!await ensureSudo()) {
        setFeedback(copy.sudoCancelled);
        return;
      }
      const outcome = await runWithSudo(
        () => fetch("/api/account/deletion/prepare", {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
          headers: { "x-csrf-token": csrfToken },
        }),
        ensureSudo,
      );
      if (outcome.kind === "sudo_cancelled") {
        setFeedback(copy.sudoCancelled);
        return;
      }
      if (outcome.kind === "spi_token_required") {
        setFeedback(copy.spiTokenRequired);
        return;
      }
      if (outcome.kind !== "ok") {
        setFeedback(
          outcome.kind === "error" && outcome.status === 401 ? copy.sessionEnded : copy.unavailable,
        );
        return;
      }
      const next = isObject(outcome.body) ? outcome.body.step : null;
      if (next === "confirm") setStep("confirm");
      else setFeedback(copy.unavailable);
    } catch {
      setFeedback(copy.unavailable);
    } finally {
      setPending(false);
    }
  };

  const feedbackNote = shownFeedback ? (
    <p className="deletion-step__feedback" role="status">{shownFeedback}</p>
  ) : null;

  if (!enabled) {
    return (
      <>
        {feedbackNote}
        <div className="deletion-step" data-tone="muted">
          <strong>Silme akışı henüz etkin değil</strong>
          <span>Hazırlıklar tamamlandığında bu ekrandan güvenle başlatabileceksin.</span>
        </div>
      </>
    );
  }

  if (step === "intent") {
    return (
      <>
        {feedbackNote}
        <div className="deletion-step">
          <span className="deletion-step__icon" aria-hidden="true">
            <LockKeyhole size={18} />
          </span>
          <div>
            <strong>Önce silmek istediğini onayla</strong>
            <p>
              Devam ettiğinde kim olduğunu parolan, passkey&apos;in ya da doğrulama kodunla
              kanıtlaman istenir; ardından onay metnini yazarsın. Bu adımların hepsi
              tamamlanmadan hesabında hiçbir değişiklik yapılmaz.
            </p>
            <button
              aria-busy={pending}
              className="primary-button"
              disabled={pending}
              onClick={() => void start()}
              type="button"
            >
              Hesabımı silmek istiyorum
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {feedbackNote}
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
            Kimlik doğrulaman kısa süre geçerlidir. Süre dolarsa bu adımı yeniden başlatman gerekir.
          </p>
        </div>
      </div>
    </>
  );
}
