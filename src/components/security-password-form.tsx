"use client";

import { KeyRound } from "lucide-react";
import { useId, useState } from "react";
import type { FormEvent } from "react";
import { FeedbackAlert, feedbackFor, sharedCopy, useWaitSeconds } from "@/components/security-shared";
import type { Feedback } from "@/components/security-shared";
import { ActionProgress } from "@/components/ui-states";
import { isObject, runWithSudo, securityRequest } from "@/lib/security-client";
import type { EnsureSudo } from "@/lib/security-client";

const MAX_PASSWORD_LENGTH = 1_024;

export const passwordCopy = {
  mismatch: "Parolalar birbiriyle aynı değil.",
  policyLead: "Yeni parola realm kurallarına uymuyor.",
  hints: ["En az 8 karakter", "Kullanıcı adın ya da e-posta adresin olamaz"],
  changed: "Parolan değiştirildi.",
  set: "Parola belirlendi.",
  othersLoggedOut: "Diğer cihazlardaki oturumlar kapatıldı.",
} as const;

type PasswordFormProps = {
  csrfToken: string;
  hasPassword: boolean;
  ensureSudo: EnsureSudo;
  onDone: (message: string) => void;
  onCancel: () => void;
  onCsrfRenewed: () => Promise<void>;
  onAuthenticationRequired: () => void;
};

/**
 * New password + confirmation + "log out other sessions" (default on). The
 * form posts once, never keeps the password after the answer, and renders
 * the realm policy rejection from the server's own Turkish `detail`.
 */
export function PasswordForm({
  csrfToken,
  hasPassword,
  ensureSudo,
  onDone,
  onCancel,
  onCsrfRenewed,
  onAuthenticationRequired,
}: PasswordFormProps) {
  const baseId = useId();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [logoutOthers, setLogoutOthers] = useState(true);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [policyRejected, setPolicyRejected] = useState(false);
  const waitSeconds = useWaitSeconds(feedback);
  const busy = pending || waitSeconds > 0;
  const mismatch = confirmation.length > 0 && confirmation !== password;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return;
    if (password !== confirmation) {
      setFeedback({ tone: "danger", detail: passwordCopy.mismatch });
      return;
    }
    setPending(true);
    setFeedback(null);
    setPolicyRejected(false);
    try {
      const outcome = await runWithSudo(
        () => securityRequest({
          method: "POST",
          path: "/api/account/security/password",
          csrfToken,
          body: { newPassword: password, logoutOtherSessions: logoutOthers },
        }),
        ensureSudo,
      );
      if (outcome.kind === "ok") {
        setPassword("");
        setConfirmation("");
        onDone([hasPassword ? passwordCopy.changed : passwordCopy.set, logoutOthers ? passwordCopy.othersLoggedOut : null]
          .filter(Boolean).join(" "));
        return;
      }
      const next = feedbackFor(outcome, (error, detail) => {
        if (error === "password_policy") {
          setPolicyRejected(true);
          return { tone: "danger", detail };
        }
        if (error === "password_rejected" || error === "invalid_request") return { tone: "danger", detail };
        return null;
      }, onAuthenticationRequired);
      if (next === "reload-csrf") {
        setFeedback({ tone: "warning", detail: sharedCopy.csrfRenewed });
        await onCsrfRenewed();
        return;
      }
      setFeedback(next);
      if (outcome.kind === "error" && isObject(outcome.body) && outcome.body.error === "password_policy") {
        setConfirmation("");
      }
    } catch {
      setFeedback({ tone: "warning", detail: sharedCopy.network });
    } finally {
      setPending(false);
    }
  };

  const hintsId = `${baseId}-hints`;
  return (
    <form className="security-panel" aria-labelledby={`${baseId}-title`} onSubmit={(event) => void submit(event)}>
      <h3 id={`${baseId}-title`} className="security-panel__title">
        <KeyRound aria-hidden="true" size={16} />
        {hasPassword ? "Parolayı değiştir" : "Parola belirle"}
      </h3>
      <FeedbackAlert feedback={feedback} waitSeconds={waitSeconds} />
      <div className="sudo-field">
        <label htmlFor={`${baseId}-password`}>Yeni parola</label>
        <input
          id={`${baseId}-password`}
          name="newPassword"
          type="password"
          autoComplete="new-password"
          autoFocus
          required
          maxLength={MAX_PASSWORD_LENGTH}
          disabled={busy}
          aria-describedby={hintsId}
          aria-invalid={policyRejected || undefined}
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
        />
      </div>
      <div className="sudo-field">
        <label htmlFor={`${baseId}-confirmation`}>Yeni parola (tekrar)</label>
        <input
          id={`${baseId}-confirmation`}
          name="confirmation"
          type="password"
          autoComplete="new-password"
          required
          maxLength={MAX_PASSWORD_LENGTH}
          disabled={busy}
          aria-invalid={mismatch || undefined}
          aria-describedby={mismatch ? `${baseId}-mismatch` : undefined}
          value={confirmation}
          onChange={(event) => setConfirmation(event.currentTarget.value)}
        />
        {mismatch ? <small id={`${baseId}-mismatch`} className="security-field-error">{passwordCopy.mismatch}</small> : null}
      </div>
      <ul id={hintsId} className="security-hints" data-tone={policyRejected ? "danger" : undefined}>
        {policyRejected ? <li className="security-hints__lead">{passwordCopy.policyLead}</li> : null}
        {passwordCopy.hints.map((hint) => <li key={hint}>{hint}</li>)}
      </ul>
      <label className="security-checkbox">
        <input
          type="checkbox"
          name="logoutOtherSessions"
          checked={logoutOthers}
          disabled={busy}
          onChange={(event) => setLogoutOthers(event.currentTarget.checked)}
        />
        <span>
          <strong>Diğer cihazlardaki oturumları kapat</strong>
          <small>Bu cihazdaki oturumun açık kalır.</small>
        </span>
      </label>
      <div className="security-panel__actions">
        <button className="secondary-button" type="button" disabled={pending} onClick={onCancel}>
          Vazgeç
        </button>
        <button
          className="primary-button"
          type="submit"
          disabled={busy || password.length === 0 || confirmation.length === 0 || mismatch}
        >
          {pending ? <ActionProgress label="Kaydediliyor" /> : "Parolayı kaydet"}
        </button>
      </div>
    </form>
  );
}
