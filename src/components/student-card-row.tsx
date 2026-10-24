"use client";

import { Nfc, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { StatusBadge } from "@/components/settings";

const CARD_ROUTE = "/api/account/club-profile/student-card";
const LINKED_COPY = "Kartını sky-app’teki SkyPass ekranından bağlayabilir ya da değiştirebilirsin; kapıda o kartla giriş yaparsın.";

type Feedback = { tone: "success" | "danger"; message: string; login?: boolean } | null;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The BFF's own problem title, bounded; anything else gets the fallback. */
async function problemMessage(response: Response) {
  try {
    const body = await response.json() as unknown;
    if (isObject(body) && typeof body.title === "string" && body.title.length <= 160) return body.title;
  } catch {
    // fall through
  }
  return "Kart kaldırılamadı. Kısa bir süre sonra yeniden dene.";
}

/**
 * The student-card row of the club profile. A bound card can be removed
 * here (KVKK s6 §5.11): core clears the stored chip UID; binding stays in
 * sky-app. The UID itself never reaches the browser.
 */
export function StudentCardRow({ initialLinked, csrfToken }: { initialLinked: boolean; csrfToken: string }) {
  const [linked, setLinked] = useState(initialLinked);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const feedbackRef = useRef<HTMLElement>(null);
  const focusAfter = useRef<"trigger" | "feedback" | null>(null);

  useEffect(() => {
    if (confirming || pending || !focusAfter.current) return;
    const target = focusAfter.current === "trigger" ? trigger.current : feedbackRef.current;
    focusAfter.current = null;
    if (target?.isConnected) target.focus();
  }, [confirming, pending, linked, feedback]);

  const remove = async () => {
    if (pending) return;
    setPending(true);
    setFeedback(null);
    try {
      let response: Response;
      try {
        response = await fetch(CARD_ROUTE, {
          method: "DELETE",
          cache: "no-store",
          credentials: "same-origin",
          headers: { "x-csrf-token": csrfToken },
        });
      } catch {
        focusAfter.current = "trigger";
        setFeedback({ tone: "danger", message: "Bağlantı kurulamadı. İnternet bağlantını kontrol edip yeniden dene." });
        return;
      }
      if (!response.ok) {
        focusAfter.current = "trigger";
        setFeedback({ tone: "danger", message: await problemMessage(response), login: response.status === 401 });
        return;
      }
      setLinked(false);
      focusAfter.current = "feedback";
      setFeedback({ tone: "success", message: "Kart kaydı kaldırıldı." });
    } finally {
      setConfirming(false);
      setPending(false);
    }
  };

  return (
    <>
      <div className="settings-row" data-has-trailing="">
        <span className="settings-row__icon"><Nfc aria-hidden="true" size={19} /></span>
        <span className="settings-row__copy">
          <strong>Öğrenci kartı</strong>
          <small>{LINKED_COPY}</small>
          {feedback ? (
            <small
              ref={feedbackRef}
              className="student-card-feedback"
              data-tone={feedback.tone}
              role={feedback.tone === "danger" ? "alert" : "status"}
              tabIndex={-1}
            >
              {feedback.message}
              {feedback.login ? <> <Link href="/login?returnTo=%2Fclub-profile">Yeniden giriş yap</Link></> : null}
            </small>
          ) : null}
        </span>
        <div className="settings-row__trailing security-row-actions">
          <StatusBadge tone={linked ? "positive" : "warning"}>
            {linked ? "Öğrenci kartı bağlı" : "Öğrenci kartı bağlı değil"}
          </StatusBadge>
          {linked ? (
            <button
              ref={trigger}
              className="security-action"
              data-tone="danger"
              type="button"
              disabled={pending}
              onClick={() => setConfirming(true)}
            >
              Kartı kaldır
            </button>
          ) : null}
        </div>
      </div>
      {confirming ? (
        <ConfirmationDialog
          title="Kart kaydı kaldırılsın mı?"
          description="Kartın çip numarası silinir; kapıda bu kartla giriş yapamazsın. İstersen sky-app’ten yeniden bağlayabilirsin."
          confirmLabel="Kartı kaldır"
          pendingLabel="Kaldırılıyor"
          icon={<Trash2 size={22} />}
          pending={pending}
          onCancel={() => {
            focusAfter.current = "trigger";
            setConfirming(false);
          }}
          onConfirm={() => void remove()}
        />
      ) : null}
    </>
  );
}
