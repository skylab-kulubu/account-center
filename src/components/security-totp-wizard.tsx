"use client";

import { RotateCcw, Smartphone } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { QrCode } from "@/components/qr-code";
import { FeedbackAlert, feedbackFor, sharedCopy, useWaitSeconds } from "@/components/security-shared";
import type { Feedback } from "@/components/security-shared";
import { ActionProgress } from "@/components/ui-states";
import { MAX_CREDENTIAL_LABEL_LENGTH, normalizeLabel } from "@/lib/labels";
import { groupSecret, isObject, runWithSudo, securityRequest } from "@/lib/security-client";
import type { EnsureSudo } from "@/lib/security-client";

const MAX_LABEL_LENGTH = MAX_CREDENTIAL_LABEL_LENGTH;
const TOTP_CODE = /^\d{4,10}$/;

export type TotpSetup = {
  setupHandle: string;
  secret: string;
  otpauthUri: string;
  expiresAt: string;
  policy: { digits: number; period: number; algorithm: string };
};

export const totpCopy = {
  title: "Doğrulama uygulaması ekle",
  starting: "Kurulum hazırlanıyor",
  scan: "Doğrulama uygulamanla (Google Authenticator, 1Password, Microsoft Authenticator gibi) bu QR kodu tara.",
  manualLead: "Kodu okutamıyorsan anahtarı elle gir:",
  qrLabel: "Doğrulama uygulaması kurulumu için QR kodu",
  labelHint: "Bu uygulamayı listede tanımanı sağlar; örneğin “Telefon”.",
  codeHint: "Uygulamanın gösterdiği güncel kodu gir.",
  added: "Doğrulama uygulaması eklendi.",
  expired: "Kurulumun süresi doldu. Baştan başla.",
  restart: "Baştan başla",
  duplicate: "Aynı adda bir doğrulama uygulaması zaten var. Başka bir ad seç.",
  setupFailed: "Kurulum başlatılamadı.",
  policyLead: (digits: number, period: number) => `Uygulama ${digits} haneli kod üretir; kod ${period} saniyede bir yenilenir.`,
} as const;

function parseSetup(value: unknown): TotpSetup | null {
  if (
    !isObject(value) ||
    typeof value.setupHandle !== "string" ||
    !/^[A-Za-z0-9_-]{1,255}$/.test(value.setupHandle) ||
    typeof value.secret !== "string" ||
    !/^[A-Z2-7]{16,128}={0,6}$/.test(value.secret) ||
    typeof value.otpauthUri !== "string" ||
    !value.otpauthUri.startsWith("otpauth://totp/") ||
    value.otpauthUri.length > 2_048 ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    !isObject(value.policy) ||
    (value.policy.digits !== 6 && value.policy.digits !== 8) ||
    typeof value.policy.period !== "number" ||
    typeof value.policy.algorithm !== "string"
  ) return null;
  return {
    setupHandle: value.setupHandle,
    secret: value.secret,
    otpauthUri: value.otpauthUri,
    expiresAt: value.expiresAt,
    policy: { digits: value.policy.digits, period: value.policy.period, algorithm: value.policy.algorithm },
  };
}

const expiryFormatter = new Intl.DateTimeFormat("tr-TR", { timeStyle: "short", timeZone: "Europe/Istanbul" });

type TotpSetupWizardProps = {
  csrfToken: string;
  ensureSudo: EnsureSudo;
  existingLabels: string[];
  onDone: (message: string) => void;
  onCancel: () => void;
  onCsrfRenewed: () => Promise<void>;
  onAuthenticationRequired: () => void;
};

/**
 * TOTP enrolment: sudo → `POST …/totp/setup` → QR (drawn in the browser) and
 * the manual secret → label + code → `POST …/totp/confirm`. A wrong code
 * keeps the setup handle for another attempt; an expired setup offers a
 * restart; the secret lives only in this component's state.
 */
export function TotpSetupWizard({
  csrfToken,
  ensureSudo,
  existingLabels,
  onDone,
  onCancel,
  onCsrfRenewed,
  onAuthenticationRequired,
}: TotpSetupWizardProps) {
  const baseId = useId();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [stage, setStage] = useState<"starting" | "ready" | "expired" | "failed">("starting");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const started = useRef(false);
  const waitSeconds = useWaitSeconds(feedback);
  const busy = pending || waitSeconds > 0;

  const start = useCallback(async () => {
    setStage("starting");
    setSetup(null);
    setFeedback(null);
    setLabelError(null);
    setCode("");
    setPending(true);
    try {
      const outcome = await runWithSudo(
        () => securityRequest({ method: "POST", path: "/api/account/security/totp/setup", csrfToken }),
        ensureSudo,
      );
      if (outcome.kind === "ok") {
        const parsed = parseSetup(outcome.body);
        if (!parsed) {
          setStage("failed");
          setFeedback({ tone: "danger", detail: sharedCopy.unexpected });
          return;
        }
        setSetup(parsed);
        setStage("ready");
        return;
      }
      if (outcome.kind === "sudo_cancelled") {
        onCancel();
        return;
      }
      const next = feedbackFor(outcome, () => null, onAuthenticationRequired);
      setStage("failed");
      if (next === "reload-csrf") {
        setFeedback({ tone: "warning", detail: sharedCopy.csrfRenewed });
        await onCsrfRenewed();
        return;
      }
      setFeedback(next);
    } catch {
      setStage("failed");
      setFeedback({ tone: "warning", detail: sharedCopy.network });
    } finally {
      setPending(false);
    }
  }, [csrfToken, ensureSudo, onAuthenticationRequired, onCancel, onCsrfRenewed]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  const confirm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!setup || busy) return;
    const trimmedLabel = normalizeLabel(label);
    const digits = code.replace(/\s+/g, "");
    if (trimmedLabel.length === 0 || trimmedLabel.length > MAX_LABEL_LENGTH || !TOTP_CODE.test(digits)) return;
    if (existingLabels.includes(trimmedLabel)) {
      setLabelError(totpCopy.duplicate);
      return;
    }
    setPending(true);
    setFeedback(null);
    setLabelError(null);
    try {
      const outcome = await runWithSudo(
        () => securityRequest({
          method: "POST",
          path: "/api/account/security/totp/confirm",
          csrfToken,
          body: { setupHandle: setup.setupHandle, code: digits, label: trimmedLabel },
        }),
        ensureSudo,
      );
      setCode("");
      if (outcome.kind === "ok") {
        setSetup(null);
        onDone(totpCopy.added);
        return;
      }
      const next = feedbackFor(outcome, (error, detail) => {
        if (error === "setup_expired") {
          setStage("expired");
          return { tone: "warning", detail: detail || totpCopy.expired };
        }
        if (error === "duplicate_label") {
          setLabelError(detail);
          return { tone: "danger", detail };
        }
        if (error === "invalid_code" || error === "invalid_request") return { tone: "danger", detail };
        return null;
      }, onAuthenticationRequired);
      if (next === "reload-csrf") {
        setFeedback({ tone: "warning", detail: sharedCopy.csrfRenewed });
        await onCsrfRenewed();
        return;
      }
      setFeedback(next);
    } catch {
      setFeedback({ tone: "warning", detail: sharedCopy.network });
    } finally {
      setPending(false);
    }
  };

  const titleId = `${baseId}-title`;
  return (
    <section className="security-panel" aria-labelledby={titleId} aria-busy={pending}>
      <h3 id={titleId} className="security-panel__title">
        <Smartphone aria-hidden="true" size={16} />
        {totpCopy.title}
      </h3>
      {stage === "starting" ? (
        <div className="security-panel__state">
          <ActionProgress label={totpCopy.starting} />
        </div>
      ) : stage === "failed" || stage === "expired" ? (
        <div className="security-panel__state">
          <FeedbackAlert feedback={feedback ?? { tone: "warning", detail: totpCopy.setupFailed }} waitSeconds={waitSeconds} />
          <div className="security-panel__actions">
            <button className="secondary-button" type="button" disabled={pending} onClick={onCancel}>
              Vazgeç
            </button>
            <button className="primary-button" type="button" disabled={busy} onClick={() => void start()}>
              <RotateCcw aria-hidden="true" size={16} />
              {totpCopy.restart}
            </button>
          </div>
        </div>
      ) : setup ? (
        <form className="security-totp" onSubmit={(event) => void confirm(event)}>
          <ol className="security-steps">
            <li>
              <p>{totpCopy.scan}</p>
              <div className="security-qr">
                <QrCode value={setup.otpauthUri} label={totpCopy.qrLabel} />
              </div>
              <p className="security-totp__manual">
                <span>{totpCopy.manualLead}</span>
                <code className="security-secret" translate="no" aria-label="Elle giriş anahtarı">{groupSecret(setup.secret)}</code>
              </p>
              <small className="security-totp__policy">
                {totpCopy.policyLead(setup.policy.digits, setup.policy.period)}{" "}
                Kurulum {expiryFormatter.format(new Date(setup.expiresAt))}’e kadar geçerli.
              </small>
            </li>
            <li>
              <FeedbackAlert feedback={feedback} waitSeconds={waitSeconds} />
              <div className="sudo-field">
                <label htmlFor={`${baseId}-label`}>Uygulama adı</label>
                <small id={`${baseId}-label-hint`}>{totpCopy.labelHint}</small>
                <input
                  id={`${baseId}-label`}
                  name="label"
                  type="text"
                  autoComplete="off"
                  required
                  maxLength={MAX_LABEL_LENGTH}
                  disabled={busy}
                  aria-describedby={labelError ? `${baseId}-label-error` : `${baseId}-label-hint`}
                  aria-invalid={labelError ? true : undefined}
                  value={label}
                  onChange={(event) => {
                    setLabel(event.currentTarget.value);
                    setLabelError(null);
                  }}
                />
                {labelError ? <small id={`${baseId}-label-error`} className="security-field-error">{labelError}</small> : null}
              </div>
              <div className="sudo-field">
                <label htmlFor={`${baseId}-code`}>Uygulamadaki kod</label>
                <small id={`${baseId}-code-hint`}>{totpCopy.codeHint}</small>
                <input
                  id={`${baseId}-code`}
                  name="code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9 ]*"
                  autoComplete="one-time-code"
                  required
                  maxLength={12}
                  disabled={busy}
                  aria-describedby={`${baseId}-code-hint`}
                  value={code}
                  onChange={(event) => setCode(event.currentTarget.value)}
                />
              </div>
            </li>
          </ol>
          <div className="security-panel__actions">
            <button className="secondary-button" type="button" disabled={pending} onClick={onCancel}>
              Vazgeç
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={busy || label.trim().length === 0 || !TOTP_CODE.test(code.replace(/\s+/g, ""))}
            >
              {pending ? <ActionProgress label="Doğrulanıyor" /> : "Doğrula ve ekle"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
