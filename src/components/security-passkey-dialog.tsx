"use client";

import { Fingerprint } from "lucide-react";
import { useId, useState } from "react";
import type { FormEvent } from "react";
import { ModalDialog } from "@/components/modal-dialog";
import { FeedbackAlert, feedbackFor, sharedCopy, useWaitSeconds } from "@/components/security-shared";
import type { Feedback } from "@/components/security-shared";
import { ActionProgress } from "@/components/ui-states";
import { MAX_CREDENTIAL_LABEL_LENGTH, normalizeLabel } from "@/lib/labels";
import { isObject, runWithSudo, securityRequest } from "@/lib/security-client";
import type { EnsureSudo } from "@/lib/security-client";
import { serializeAttestation, toPublicKeyCreationOptions, webauthnCreateSupported } from "@/lib/webauthn";
import type { CreationOptionsJson } from "@/lib/webauthn";

const MAX_LABEL_LENGTH = MAX_CREDENTIAL_LABEL_LENGTH;

export const passkeyCopy = {
  title: "Passkey ekle",
  description: "Passkey’e bir ad ver; ardından cihazın kilidiyle (parmak izi, yüz tanıma ya da cihaz şifresi) passkey oluşturulur.",
  labelHint: "Passkey’i listede tanımanı sağlar; örneğin “MacBook” ya da “iPhone”.",
  unsupported: "Bu tarayıcı passkey eklemeyi desteklemiyor. Güncel bir tarayıcı ya da SKY LAB uygulaması kullan.",
  cancelled: "Passkey oluşturma tamamlanmadı ya da zaman aşımına uğradı. Yeniden dene.",
  alreadyOnDevice: "Bu cihazdaki passkey zaten hesabında kayıtlı.",
  failed: "Passkey oluşturulamadı. Yeniden dene.",
  duplicate: "Aynı adda bir passkey zaten var. Başka bir ad seç.",
  added: "Passkey eklendi.",
  waiting: "Passkey bekleniyor",
} as const;

function parseCreationOptions(value: unknown): CreationOptionsJson | null {
  if (
    !isObject(value) ||
    !isObject(value.rp) || typeof value.rp.id !== "string" || typeof value.rp.name !== "string" ||
    !isObject(value.user) || typeof value.user.id !== "string" ||
    typeof value.user.name !== "string" || typeof value.user.displayName !== "string" ||
    typeof value.challenge !== "string" ||
    !Array.isArray(value.pubKeyCredParams) ||
    !value.pubKeyCredParams.every((item) => isObject(item) && item.type === "public-key" && typeof item.alg === "number") ||
    !Array.isArray(value.excludeCredentials) ||
    !isObject(value.authenticatorSelection) ||
    (value.timeout !== undefined && typeof value.timeout !== "number") ||
    (value.attestation !== undefined && typeof value.attestation !== "string")
  ) return null;
  const excludeCredentials: CreationOptionsJson["excludeCredentials"] = [];
  for (const credential of value.excludeCredentials) {
    if (
      !isObject(credential) ||
      credential.type !== "public-key" ||
      typeof credential.id !== "string" ||
      (credential.transports !== undefined &&
        (!Array.isArray(credential.transports) || !credential.transports.every((item) => typeof item === "string")))
    ) return null;
    excludeCredentials.push({
      type: "public-key",
      id: credential.id,
      ...(credential.transports ? { transports: credential.transports as string[] } : {}),
    });
  }
  const selection = value.authenticatorSelection;
  return {
    rp: { id: value.rp.id, name: value.rp.name },
    user: { id: value.user.id, name: value.user.name, displayName: value.user.displayName },
    challenge: value.challenge,
    pubKeyCredParams: value.pubKeyCredParams.map((item) => ({ type: "public-key" as const, alg: (item as { alg: number }).alg })),
    excludeCredentials,
    authenticatorSelection: {
      ...(selection.authenticatorAttachment === "platform" || selection.authenticatorAttachment === "cross-platform"
        ? { authenticatorAttachment: selection.authenticatorAttachment }
        : {}),
      ...(selection.residentKey === "required" || selection.residentKey === "preferred" || selection.residentKey === "discouraged"
        ? { residentKey: selection.residentKey }
        : {}),
      ...(typeof selection.requireResidentKey === "boolean" ? { requireResidentKey: selection.requireResidentKey } : {}),
      ...(selection.userVerification === "required" || selection.userVerification === "preferred" || selection.userVerification === "discouraged"
        ? { userVerification: selection.userVerification }
        : {}),
    },
    ...(typeof value.timeout === "number" ? { timeout: value.timeout } : {}),
    ...(value.attestation === "none" || value.attestation === "indirect" || value.attestation === "direct" || value.attestation === "enterprise"
      ? { attestation: value.attestation }
      : {}),
    ...(isObject(value.extensions) && typeof value.extensions.credProps === "boolean"
      ? { extensions: { credProps: value.extensions.credProps } }
      : {}),
  };
}

type PasskeyAddDialogProps = {
  csrfToken: string;
  ensureSudo: EnsureSudo;
  existingLabels: string[];
  onDone: (message: string) => void;
  onDismiss: () => void;
  onCsrfRenewed: () => Promise<void>;
  onAuthenticationRequired: () => void;
};

/**
 * Passkey registration: label → sudo → `POST …/passkeys/options` →
 * `navigator.credentials.create()` on `my.` → `POST …/passkeys/register`.
 * The attestation is serialized once and never kept.
 */
export function PasskeyAddDialog({
  csrfToken,
  ensureSudo,
  existingLabels,
  onDone,
  onDismiss,
  onCsrfRenewed,
  onAuthenticationRequired,
}: PasskeyAddDialogProps) {
  const baseId = useId();
  const [label, setLabel] = useState("");
  const [labelError, setLabelError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const waitSeconds = useWaitSeconds(feedback);
  const busy = pending || waitSeconds > 0;
  const supported = webauthnCreateSupported();

  const register = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !supported) return;
    const trimmedLabel = normalizeLabel(label);
    if (trimmedLabel.length === 0 || trimmedLabel.length > MAX_LABEL_LENGTH) return;
    if (existingLabels.includes(trimmedLabel)) {
      setLabelError(passkeyCopy.duplicate);
      return;
    }
    setPending(true);
    setFeedback(null);
    setLabelError(null);
    try {
      const verified = await ensureSudo();
      if (!verified) {
        setFeedback({ tone: "warning", detail: sharedCopy.sudoCancelled });
        return;
      }
      const optionsOutcome = await runWithSudo(
        () => securityRequest({ method: "POST", path: "/api/account/security/passkeys/options", csrfToken }),
        ensureSudo,
      );
      if (optionsOutcome.kind !== "ok") {
        const next = feedbackFor(optionsOutcome, () => null, onAuthenticationRequired);
        if (next === "reload-csrf") {
          setFeedback({ tone: "warning", detail: sharedCopy.csrfRenewed });
          await onCsrfRenewed();
          return;
        }
        setFeedback(next);
        return;
      }
      const options = parseCreationOptions(optionsOutcome.body);
      if (!options) {
        setFeedback({ tone: "danger", detail: passkeyCopy.failed });
        return;
      }
      let credential: Credential | null;
      try {
        credential = await navigator.credentials.create({ publicKey: toPublicKeyCreationOptions(options) });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        setFeedback({
          tone: "warning",
          detail: name === "InvalidStateError"
            ? passkeyCopy.alreadyOnDevice
            : name === "NotAllowedError" || name === "AbortError"
              ? passkeyCopy.cancelled
              : passkeyCopy.failed,
        });
        return;
      }
      if (!credential || !(credential instanceof PublicKeyCredential)) {
        setFeedback({ tone: "warning", detail: passkeyCopy.cancelled });
        return;
      }
      const attestation = serializeAttestation(credential);
      const outcome = await runWithSudo(
        () => securityRequest({
          method: "POST",
          path: "/api/account/security/passkeys/register",
          csrfToken,
          body: { attestation, label: trimmedLabel },
        }),
        ensureSudo,
      );
      if (outcome.kind === "ok") {
        onDone(passkeyCopy.added);
        return;
      }
      const next = feedbackFor(outcome, (error, detail) => {
        if (error === "duplicate_label") {
          setLabelError(detail);
          return { tone: "danger", detail };
        }
        if (
          error === "passkey_already_registered" ||
          error === "webauthn_origin_not_allowed" ||
          error === "webauthn_invalid" ||
          error === "challenge_expired" ||
          error === "invalid_request"
        ) return { tone: "danger", detail };
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
  const descriptionId = `${baseId}-description`;
  return (
    <ModalDialog
      titleId={titleId}
      descriptionId={descriptionId}
      className="security-dialog"
      pending={pending}
      icon={<Fingerprint size={22} />}
      iconClassName="sudo-dialog__icon"
      onDismiss={onDismiss}
    >
      <h2 id={titleId}>{passkeyCopy.title}</h2>
      <p id={descriptionId}>{passkeyCopy.description}</p>
      {!supported ? (
        <FeedbackAlert feedback={{ tone: "warning", detail: passkeyCopy.unsupported }} />
      ) : (
        <form className="sudo-form security-dialog__form" onSubmit={(event) => void register(event)}>
          <FeedbackAlert feedback={feedback} waitSeconds={waitSeconds} />
          <div className="sudo-field">
            <label htmlFor={`${baseId}-label`}>Passkey adı</label>
            <small id={`${baseId}-label-hint`}>{passkeyCopy.labelHint}</small>
            <input
              id={`${baseId}-label`}
              name="label"
              type="text"
              autoComplete="off"
              autoFocus
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
          <div className="confirmation-dialog__actions">
            <button className="secondary-button" type="button" disabled={pending} onClick={onDismiss}>
              Vazgeç
            </button>
            <button className="primary-button" type="submit" disabled={busy || label.trim().length === 0}>
              {pending ? <ActionProgress label={passkeyCopy.waiting} /> : (
                <><Fingerprint aria-hidden="true" size={16} />Passkey oluştur</>
              )}
            </button>
          </div>
        </form>
      )}
    </ModalDialog>
  );
}
