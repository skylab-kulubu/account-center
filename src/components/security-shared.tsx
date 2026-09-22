"use client";

import { AlertCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { detailOf, errorOf, isObject, retryAfterOf } from "@/lib/security-client";
import type { MutationOutcome } from "@/lib/security-client";

/** Browser-side copy of `SecurityPayload` (`src/server/security/view.ts`). */
export type SecurityCredentialRow = {
  reference: string;
  label: string | null;
  createdAt: string | null;
  transports?: string[];
  legacy?: true;
};

export type SecurityPayload = {
  password: boolean;
  totp: SecurityCredentialRow[];
  passkeys: SecurityCredentialRow[];
  sudo: {
    methods: string[];
    fallback: "microsoft" | null;
    active: { method: string; expiresAt: string } | null;
  };
  csrfToken: string;
};

export type Feedback = {
  tone: "danger" | "warning";
  detail: string;
  /** Seconds the person must wait before another attempt (lockout or rate limit). */
  retryAfter?: number;
};

export const sharedCopy = {
  network: "Bağlantı kurulamadı. Kısa bir süre sonra yeniden dene.",
  unexpected: "İşlem tamamlanamadı. Yeniden dene.",
  csrfRenewed: "Oturum bilgin yenilendi. Lütfen yeniden dene.",
  tooMany: "Çok fazla deneme yaptın.",
  locked: "Hesabın geçici olarak kilitlendi.",
  waitPrefix: "Yeniden denemek için bekle:",
  sudoCancelled: "Kimliğini doğrulamadığın için değişiklik yapılmadı.",
  spiTokenRequired: "Doğrulaman tamamlandı ama güvenlik işlemi için ek doğrulama gerekiyor; tekrar dene.",
  sudoStale: "Doğrulamanın süresi doldu ve yeniden doğrulama tamamlanmadı. Yeniden dene.",
} as const;

const CREDENTIAL_REFERENCE = /^[A-Za-z0-9_-]{43}$/;

function optionalText(value: unknown, maximum = 255) {
  return value === null || (typeof value === "string" && value.length <= maximum);
}

function validIsoDate(value: unknown) {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function validRow(value: unknown): value is SecurityCredentialRow {
  if (!isObject(value)) return false;
  if (typeof value.reference !== "string" || !CREDENTIAL_REFERENCE.test(value.reference)) return false;
  if (!optionalText(value.label)) return false;
  if (value.createdAt !== null && !validIsoDate(value.createdAt)) return false;
  if (value.transports !== undefined &&
    (!Array.isArray(value.transports) || value.transports.length > 8 ||
      !value.transports.every((item) => typeof item === "string" && item.length <= 32))) return false;
  return value.legacy === undefined || value.legacy === true;
}

function validRows(value: unknown): value is SecurityCredentialRow[] {
  if (!Array.isArray(value) || value.length > 64 || !value.every(validRow)) return false;
  return new Set(value.map((row) => row.reference)).size === value.length;
}

export function parseSecurityPayload(value: unknown): SecurityPayload | null {
  if (
    !isObject(value) ||
    typeof value.password !== "boolean" ||
    !validRows(value.totp) ||
    !validRows(value.passkeys) ||
    !isObject(value.sudo) ||
    !Array.isArray(value.sudo.methods) ||
    !value.sudo.methods.every((method) => typeof method === "string" && method.length <= 16) ||
    (value.sudo.fallback !== null && value.sudo.fallback !== "microsoft") ||
    typeof value.csrfToken !== "string" ||
    value.csrfToken.length < 1 ||
    value.csrfToken.length > 128
  ) return null;
  let active: SecurityPayload["sudo"]["active"] = null;
  if (value.sudo.active !== null) {
    if (
      !isObject(value.sudo.active) ||
      typeof value.sudo.active.method !== "string" ||
      value.sudo.active.method.length > 16 ||
      !validIsoDate(value.sudo.active.expiresAt)
    ) return null;
    active = { method: value.sudo.active.method, expiresAt: value.sudo.active.expiresAt as string };
  }
  return {
    password: value.password,
    totp: value.totp,
    passkeys: value.passkeys,
    sudo: { methods: value.sudo.methods as string[], fallback: value.sudo.fallback, active },
    csrfToken: value.csrfToken,
  };
}

const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "long",
  timeZone: "Europe/Istanbul",
});

export function formattedCreatedAt(value: string | null) {
  if (!value) return "Eklenme tarihi bilinmiyor";
  return `Eklendi: ${dateFormatter.format(new Date(value))}`;
}

export function formatWait(seconds: number) {
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} dakika`;
  return `${seconds} saniye`;
}

export function loginPath(returnTo: string) {
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * Maps a mutation outcome that is not a success to feedback, or `null` when
 * the caller handles the case itself (`handled` returns feedback for the
 * route-specific `error` keys). A `401` ends in the login page.
 */
export function feedbackFor(
  outcome: Exclude<MutationOutcome, { kind: "ok" }>,
  handled: (error: string, detail: string) => Feedback | null,
  onAuthenticationRequired: () => void,
): Feedback | "reload-csrf" {
  if (outcome.kind === "sudo_cancelled") return { tone: "warning", detail: sharedCopy.sudoCancelled };
  if (outcome.kind === "spi_token_required") return { tone: "warning", detail: sharedCopy.spiTokenRequired };
  const { status, body, response } = outcome;
  const error = errorOf(body);
  if (status === 401) {
    onAuthenticationRequired();
    return { tone: "warning", detail: sharedCopy.unexpected };
  }
  if (status === 428) return { tone: "warning", detail: sharedCopy.sudoStale };
  if (status === 403 && error !== "disabled") return "reload-csrf";
  if (status === 423) {
    return { tone: "danger", detail: detailOf(body, sharedCopy.locked), retryAfter: retryAfterOf(body, response) };
  }
  if (status === 429) {
    return { tone: "warning", detail: detailOf(body, sharedCopy.tooMany), retryAfter: retryAfterOf(body, response) };
  }
  const specific = handled(error, detailOf(body, sharedCopy.unexpected));
  if (specific) return specific;
  return { tone: status >= 500 ? "warning" : "danger", detail: detailOf(body, sharedCopy.unexpected) };
}

/** Counts a lockout / rate-limit wait down once per second; a new feedback object restarts it. */
export function useWaitSeconds(feedback: Feedback | null) {
  const [waitSeconds, setWaitSeconds] = useState(feedback?.retryAfter ?? 0);
  const [seen, setSeen] = useState(feedback);
  if (feedback !== seen) {
    setSeen(feedback);
    setWaitSeconds(feedback?.retryAfter ?? 0);
  }
  useEffect(() => {
    if (waitSeconds <= 0) return;
    const timer = window.setTimeout(() => setWaitSeconds((current) => Math.max(0, current - 1)), 1_000);
    return () => window.clearTimeout(timer);
  }, [waitSeconds]);
  return waitSeconds;
}

export function FeedbackAlert({ feedback, waitSeconds = 0 }: { feedback: Feedback | null; waitSeconds?: number }) {
  if (!feedback) return null;
  return (
    <p className="security-feedback" data-tone={feedback.tone} role="alert">
      <AlertCircle aria-hidden="true" size={16} />
      <span>
        {feedback.detail}
        {waitSeconds > 0 ? ` ${sharedCopy.waitPrefix} ${formatWait(waitSeconds)}.` : null}
      </span>
    </p>
  );
}
