"use client";

import { useState } from "react";
import { KeyRound, LockKeyhole, Trash2 } from "lucide-react";
import { useSudo } from "@/components/sudo-provider";
import { isObject, runWithSudo } from "@/lib/security-client";

const CONFIRMATION = "HESABIMI SİL";

export type AccountDeletionError =
  | "proof_expired"
  | "reauth_unavailable"
  | "deletion_unavailable"
  | "sudo_required";

/**
 * `intent` is the person saying they want the account gone, `keycloak` the
 * extra Keycloak round trip core's intake still needs when the session holds
 * no recent authentication, and `confirm` the literal confirmation text.
 * Sudo mode sits between `intent` and the other two and has no card of its
 * own: it is the dialog the provider opens.
 */
type Step = "intent" | "keycloak" | "confirm";

const copy = {
  sudoCancelled: "Kimlik doğrulaman tamamlanmadı. Hesabında hiçbir değişiklik yapılmadı.",
  unavailable: "Hesap silme işlemi şu anda başlatılamıyor. Hesabında hiçbir değişiklik yapılmadı; kısa bir süre sonra tekrar dene.",
  sessionEnded: "Oturumun sona ermiş görünüyor. Sayfayı yenileyip yeniden dene.",
} as const;

const errorFeedback: Record<AccountDeletionError, string> = {
  proof_expired: "Doğrulama süren doldu veya silme onayın geçersizdi. Devam etmek için kimliğini yeniden doğrula.",
  reauth_unavailable: "Yeniden doğrulama başlatılamadı. Hesabında hiçbir değişiklik yapılmadı; kısa bir süre sonra tekrar dene.",
  deletion_unavailable: copy.unavailable,
  sudo_required: "Kimlik doğrulaman geçerliliğini yitirdi. Devam etmek için kimliğini yeniden doğrula.",
};

/**
 * The delete-account flow in the order the person walks it: confirm the
 * intent, prove who they are with Sudo mode, and only then type the literal
 * confirmation and submit. Sudo mode covers the re-authentication the person
 * sees; the BFF still decides on its own whether core's intake needs the
 * extra Keycloak round trip, and says so through `POST .../deletion/prepare`.
 */
export function AccountDeletionConfirmation({
  csrfToken,
  deletionError,
  enabled,
  reauthenticated,
  reauthenticationCancelled = false,
}: {
  csrfToken: string;
  deletionError?: AccountDeletionError;
  enabled: boolean;
  reauthenticated: boolean;
  reauthenticationCancelled?: boolean;
}) {
  const { ensureSudo } = useSudo();
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  /** Once the person has started, the recovery message the page arrived with is spent. */
  const [attempted, setAttempted] = useState(false);
  // A browser that came back from the Keycloak hop already carries the proof
  // cookie, so it lands on the confirmation; an expired sudo proof starts over.
  const [step, setStep] = useState<Step>(
    reauthenticated && deletionError !== "sudo_required" ? "confirm" : "intent",
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
      if (outcome.kind !== "ok") {
        setFeedback(
          outcome.kind === "error" && outcome.status === 401 ? copy.sessionEnded : copy.unavailable,
        );
        return;
      }
      const next = isObject(outcome.body) ? outcome.body.step : null;
      if (next === "confirm") setStep("confirm");
      else if (next === "keycloak_reauthentication") setStep("keycloak");
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
            {reauthenticationCancelled && !shownFeedback ? (
              <p className="deletion-step__feedback" role="status">
                Yeniden doğrulama tamamlanmadı. Hesabında hiçbir değişiklik yapılmadı.
              </p>
            ) : null}
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

  if (step === "keycloak") {
    return (
      <>
        {feedbackNote}
        <div className="deletion-step">
          <span className="deletion-step__icon" aria-hidden="true">
            <KeyRound size={18} />
          </span>
          <div>
            <strong>Bir doğrulama adımı daha</strong>
            <p>
              Kimliğini doğruladın. Hesap silme için Keycloak üzerinden ek doğrulama
              gerekiyor: silme isteği, beş dakikadan daha yeni bir giriş kanıtıyla
              iletilir ve oturumundaki giriş bundan eski.
            </p>
            <p>Doğrulamadan sonra bu sayfaya dönersin ve onay metnini yazarsın.</p>
            <form action="/api/account/deletion/reauthenticate" method="post">
              <input type="hidden" name="csrfToken" value={csrfToken} />
              <button className="primary-button" type="submit">
                Keycloak ile doğrula
              </button>
            </form>
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
