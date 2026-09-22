"use client";

import { GraduationCap, Link2, Mail, MailCheck, Pencil, Plus, RotateCcw, Star, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ModalDialog } from "@/components/modal-dialog";
import { FeedbackAlert, feedbackFor, loginPath, sharedCopy, useWaitSeconds } from "@/components/security-shared";
import type { Feedback } from "@/components/security-shared";
import { SettingsGroup, StatusBadge } from "@/components/settings";
import { useSudo } from "@/components/sudo-provider";
import { ActionProgress, RetryableError } from "@/components/ui-states";
import { detailOf, errorOf, isObject, responseJson, runWithSudo, securityRequest } from "@/lib/security-client";
import type { EnsureSudo, MutationOutcome } from "@/lib/security-client";

const RETURN_TO = "/email";
/** Where "YTÜ hesabını bağla" already lives: the identity page's YTÜ section. */
const YTU_LINK_PAGE = "/identity";
/** The SPI keeps a pending change for ten minutes; the countdown never shows more. */
const CODE_LIFETIME_MS = 10 * 60_000;
const MAX_ADDRESS_LENGTH = 254;
const ADDRESS_SHAPE = /^[^\s@]+@[^\s@]+$/;
const EMAIL_CODE = /^\d{6}$/;

type PrimaryChoice = "school" | "personal";

/** Browser-side copy of `EmailPayload` (`src/server/email/view.ts`). */
export type EmailPayload = {
  email: string | null;
  emailVerified: boolean;
  primary: PrimaryChoice | "none";
  schoolEmail: string | null;
  verifiedYtu: boolean;
  personalEmail: string | null;
  personalEmailVerified: boolean;
  csrfToken: string;
};

export const emailCopy = {
  loading: "E-posta adreslerin yükleniyor",
  loadFailed: {
    title: "E-posta adreslerin yüklenemedi",
    detail: "Kimlik hizmetine şu anda ulaşılamıyor. Kısa bir süre sonra yeniden deneyebilirsin.",
  },
  contract: {
    title: "E-posta adreslerin güvenle durduruldu",
    detail: "Kimlik hizmetinin yanıtı desteklenen biçimle eşleşmedi. Hiçbir ham veri gösterilmedi.",
  },
  verified: "Doğrulandı",
  unverified: "Doğrulanmadı",
  linkYtu: "YTÜ hesabını bağla",
  school: {
    title: "Okul e-postası",
    description: "YTÜ Microsoft hesabından gelir; buradan değiştirilemez.",
    missing: "Kayıtlı değil",
    verifiedDetail: "YTÜ Microsoft hesabınla doğrulandı. Bu adresle de giriş yapabilirsin.",
    unverifiedDetail: "YTÜ hesabın bağlı olmadığı için doğrulanmadı ve birincil adres yapılamaz.",
    missingDetail: "YTÜ hesabını bağladığında okul e-postan buraya gelir.",
  },
  personal: {
    title: "Kişisel e-posta",
    description: "Okul dışında kullandığın bir adres. Eklediğin adrese gelen 6 haneli kodu bu sayfada girerek doğrularsın.",
    empty: "Henüz kişisel e-posta eklemedin.",
    emptyDetail: "Bir kişisel adres eklersen kulüp postalarını oraya yönlendirebilir ve onunla da giriş yapabilirsin.",
    verifiedDetail: "Kodla doğrulandı. Bu adresle de giriş yapabilirsin.",
    unverifiedDetail: "Doğrulanmadı; birincil adres yapılamaz.",
    add: "Kişisel e-posta ekle",
    change: "Değiştir",
    remove: "Kaldır",
  },
  add: {
    title: "Kişisel e-posta ekle",
    label: "E-posta adresi",
    hint: "Bu adrese 6 haneli bir doğrulama kodu göndereceğiz; kod 10 dakika geçerli. Göndermeden önce kimliğini doğrulaman istenir.",
    send: "Kod gönder",
    sending: "Gönderiliyor",
    invalid: "Geçerli bir e-posta adresi gir.",
    alreadyYours: "Bu adres zaten hesabında kayıtlı.",
  },
  change: {
    title: "Kişisel e-postayı değiştir",
    label: "Yeni e-posta adresi",
    hint: (current: string) =>
      `Yeni adrese 6 haneli bir doğrulama kodu göndereceğiz; kod 10 dakika geçerli. Kodu girene kadar ${current} kişisel adresin olarak kalır. Göndermeden önce kimliğini doğrulaman istenir.`,
    primary: "Birincil adresin de yeni adrese geçer.",
  },
  code: {
    title: "Doğrulama kodunu gir",
    sentTo: (address: string) => `${address} adresine 6 haneli bir kod gönderdik. Kodu kimseyle paylaşma.`,
    replaces: (current: string) => `Kodu girdiğinde ${current} yerine bu adres kişisel e-postan olur.`,
    attemptsLeft: (attemptsLeft: number) => `${attemptsLeft} deneme hakkın kaldı.`,
    label: "Doğrulama kodu",
    hint: "Postadaki 6 rakamı gir; araya giren boşluklar sorun değil.",
    remaining: "Kalan süre:",
    confirm: "Doğrula",
    confirming: "Doğrulanıyor",
    resend: "Yeni kod gönder",
    resent: "Yeni bir kod gönderdik. Önceki kod artık geçersiz.",
    wrong: (attemptsLeft: number) => `Kod yanlış. ${attemptsLeft} deneme hakkın kaldı.`,
    wrongUnknown: "Kod yanlış. Postadaki kodu yeniden kontrol et.",
    exhausted: "Kodu çok kez yanlış girdin; bu kod artık geçersiz. Yeni kod iste.",
    gone: "Bu kodun süresi dolmuş ya da kod artık geçerli değil. Yeni kod iste.",
    expired: "Kodun süresi doldu. Yeni kod iste.",
    confirmed: (address: string) => `${address} doğrulandı. Artık bu adresle de giriş yapabilirsin.`,
    replaced: (address: string, previous: string) =>
      `${address} doğrulandı; kişisel e-postan artık bu adres. ${previous} ile artık giriş yapamazsın.`,
  },
  primary: {
    title: "Birincil e-posta",
    description: "Kulüp postaları birincil adrese gider; iki adresle de giriş yapabilirsin.",
    none: (email: string | null) => email
      ? `Şu anki birincil adresin ${email}; okul ya da kişisel adreslerinden biri değil. Aşağıdan birini seçebilirsin.`
      : "Birincil adresin yok. Aşağıdan birini seçebilirsin.",
    noAddress: "Birincil adres seçmek için önce bir kişisel e-posta ekle ya da YTÜ hesabını bağla.",
    schoolUnverified: "YTÜ hesabın bağlanmadan birincil adres yapılamaz.",
    personalUnverified: "Doğrulanmadığı için birincil adres yapılamaz; adresi kaldırıp yeniden ekle ve gelen kodla doğrula.",
    save: "Birincil adresi kaydet",
    saving: "Kaydediliyor",
    saved: (address: string) => `Birincil adresin güncellendi. Kulüp postaları artık ${address} adresine gider.`,
    sudo: "Kaydetmeden önce kimliğini doğrulaman istenir.",
  },
  remove: {
    title: "Kişisel e-posta kaldırılsın mı?",
    body: (address: string) => `${address} hesabından kaldırılacak. Bu adresle artık giriş yapamazsın.`,
    primary: "Bu adres birincil adresin; kaldırınca kulüp postaları okul e-postana gider.",
    sudo: "Onayladıktan sonra kimliğini doğrulaman istenir.",
    confirm: "Kaldır",
    removing: "Kaldırılıyor",
    removed: "Kişisel e-postan kaldırıldı.",
  },
  note: "E-posta değişiklikleri Keycloak'taki SKY LAB kimliğinde yapılır ve her SKY LAB uygulamasında geçerlidir. Adres eklemek, birincil adresi değiştirmek ve kişisel adresi kaldırmak kimliğini yeniden doğrulamanı ister; postadaki kodu girmek istemez.",
} as const;

type Notice = { tone: "positive" | "warning"; title: string; detail: string };

/** A change the SPI still holds (`GET /api/account/email/pending`), shown again as the code panel. */
export type WaitingChange = { address: string; expiresAt: string; attemptsLeft: number };

type Flow =
  /** Adding a first personal address, or replacing the existing one (`change`); `waiting` restores the code panel. */
  | { kind: "add" | "change"; waiting?: WaitingChange }
  | { kind: "remove" };

function optionalAddress(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 320);
}

/** Fail-closed parser for the BFF payload: nothing unexpected reaches the DOM. */
export function parseEmailPayload(value: unknown): EmailPayload | null {
  if (
    !isObject(value) ||
    !optionalAddress(value.email) ||
    typeof value.emailVerified !== "boolean" ||
    (value.primary !== "school" && value.primary !== "personal" && value.primary !== "none") ||
    !optionalAddress(value.schoolEmail) ||
    typeof value.verifiedYtu !== "boolean" ||
    !optionalAddress(value.personalEmail) ||
    typeof value.personalEmailVerified !== "boolean" ||
    typeof value.csrfToken !== "string" ||
    value.csrfToken.length < 1 ||
    value.csrfToken.length > 128
  ) return null;
  return {
    email: value.email,
    emailVerified: value.emailVerified,
    primary: value.primary,
    schoolEmail: value.schoolEmail,
    verifiedYtu: value.verifiedYtu,
    personalEmail: value.personalEmail,
    personalEmailVerified: value.personalEmailVerified,
    csrfToken: value.csrfToken,
  };
}

/**
 * `{ pending }` of `GET /api/account/email/pending`: the waiting change,
 * `null` when nothing waits, `undefined` for an answer outside the contract
 * (treated like nothing waiting: the page simply does not restore).
 */
export function parsePendingPayload(value: unknown): WaitingChange | null | undefined {
  if (!isObject(value)) return undefined;
  if (value.pending === null) return null;
  const pending = value.pending;
  if (
    !isObject(pending) ||
    !optionalAddress(pending.address) ||
    pending.address === null ||
    typeof pending.expiresAt !== "string" ||
    pending.expiresAt.length > 64 ||
    !Number.isFinite(Date.parse(pending.expiresAt)) ||
    typeof pending.attemptsLeft !== "number" ||
    !Number.isSafeInteger(pending.attemptsLeft) ||
    pending.attemptsLeft < 0 ||
    pending.attemptsLeft > 100
  ) return undefined;
  return { address: pending.address, expiresAt: pending.expiresAt, attemptsLeft: pending.attemptsLeft };
}

/** Trimmed and lower-cased the way the SPI stores it, so the page shows and compares what Keycloak will hold. */
function normalizeAddress(value: string) {
  return value.trim().toLowerCase();
}

function knownAddresses(payload: EmailPayload) {
  return [payload.email, payload.schoolEmail, payload.personalEmail]
    .filter((address): address is string => address !== null)
    .map(normalizeAddress);
}

/**
 * When the code stops working, on this browser's clock. The SPI's deadline
 * is honoured, but a clock that disagrees with the server (a deadline in the
 * past or further than ten minutes away) falls back to the documented ten
 * minutes: the SPI stays the judge and answers `no_pending_change` itself.
 */
function localDeadline(expiresAt: string) {
  const remaining = Date.parse(expiresAt) - Date.now();
  const lifetime = Number.isFinite(remaining) && remaining > 0 && remaining <= CODE_LIFETIME_MS ? remaining : CODE_LIFETIME_MS;
  return Date.now() + lifetime;
}

/**
 * Seconds left until `deadline`, ticking once a second while any are left.
 * `restart` re-reads the clock when a new deadline is set (from the event
 * handler that sets it), so the first second shown is never stale.
 */
function useCountdown(deadline: number | null) {
  const [now, setNow] = useState(() => Date.now());
  const remaining = deadline === null ? 0 : Math.max(0, Math.ceil((deadline - now) / 1_000));
  const running = deadline !== null && remaining > 0;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running, deadline]);
  const restart = useCallback(() => setNow(Date.now()), []);
  return { remaining, restart };
}

function formatCountdown(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function YtuLink() {
  return (
    <Link className="security-action email-link-action" href={YTU_LINK_PAGE}>
      <Link2 aria-hidden="true" size={15} />
      {emailCopy.linkYtu}
    </Link>
  );
}

type FlowCallbacks = {
  ensureSudo: EnsureSudo;
  onCsrfRenewed: () => Promise<void>;
  onAuthenticationRequired: () => void;
};

type CodeState =
  /** The code can be typed. */
  | "open"
  /** The last wrong code used the final attempt (`attemptsLeft: 0`). */
  | "exhausted"
  /** The SPI has nothing pending any more (expired, used, replaced). */
  | "gone";

type PendingChange = { address: string; deadline: number };

/**
 * "Kişisel e-posta ekle" / "Değiştir": the address → Sudo mode
 * (`runWithSudo` opens the dialog on `428` and retries once) →
 * `change-request` → the code panel with the address, the ten-minute
 * countdown, the six-digit input and "yeni kod gönder". The code is
 * confirmed with the session only. A wrong code shows the tries left; an
 * exhausted, vanished or timed-out code closes the input until a new code is
 * sent. `waiting` opens straight on the code panel of a change the SPI still
 * holds (read from `GET /api/account/email/pending`); nothing about the
 * change is ever stored in the browser. `replacing` is the personal address
 * a confirmed code replaces (the primary moves with it when it was primary).
 */
function PersonalEmailFlow({
  payload,
  replacing,
  waiting,
  onDone,
  onCancel,
  ensureSudo,
  onCsrfRenewed,
  onAuthenticationRequired,
}: FlowCallbacks & {
  payload: EmailPayload;
  replacing: string | null;
  waiting?: WaitingChange;
  onDone: (address: string) => void;
  onCancel: () => void;
}) {
  const baseId = useId();
  const [value, setValue] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  /** Which action a lockout or rate limit applies to, so a wait on one never blocks the other. */
  const [waitScope, setWaitScope] = useState<"send" | "confirm">("send");
  const waitSeconds = useWaitSeconds(feedback);
  const [change, setChange] = useState<PendingChange | null>(() =>
    waiting ? { address: waiting.address, deadline: localDeadline(waiting.expiresAt) } : null);
  /** Tries left on the current code, when the SPI said so (a restored change or a wrong code). */
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(waiting?.attemptsLeft ?? null);
  const [code, setCode] = useState("");
  const [codeState, setCodeState] = useState<CodeState>("open");
  const [resent, setResent] = useState(false);
  const { remaining, restart } = useCountdown(change?.deadline ?? null);
  const addressInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const focusTarget = useRef<"address" | "code" | null>(null);

  useEffect(() => {
    if (pending || !focusTarget.current) return;
    const target = focusTarget.current;
    focusTarget.current = null;
    (target === "address" ? addressInput : codeInput).current?.focus();
  }, [pending, fieldError, change, codeState]);

  const expired = change !== null && remaining === 0;
  const sendBlocked = pending || (waitScope === "send" && waitSeconds > 0);
  const codeClosed = expired || codeState !== "open";
  const confirmBlocked = pending || codeClosed || (waitScope === "confirm" && waitSeconds > 0);

  const handleFailure = async (
    outcome: Exclude<MutationOutcome, { kind: "ok" }>,
    scope: "send" | "confirm",
    handled: (error: string, detail: string) => Feedback | null,
  ) => {
    const next = feedbackFor(outcome, handled, onAuthenticationRequired);
    if (next === "reload-csrf") {
      setFeedback({ tone: "warning", detail: sharedCopy.csrfRenewed });
      await onCsrfRenewed();
      return;
    }
    setWaitScope(scope);
    setFeedback(next);
  };

  /** Asks the SPI to mail a code; the second call for the same address is "yeni kod gönder". */
  const send = async (address: string, again: boolean) => {
    setPending(true);
    setFeedback(null);
    setFieldError(null);
    setResent(false);
    try {
      const outcome = await runWithSudo(
        () => securityRequest({
          method: "POST",
          path: "/api/account/email/change-request",
          csrfToken: payload.csrfToken,
          body: { address },
        }),
        ensureSudo,
      );
      if (outcome.kind === "ok") {
        const expiresAt = isObject(outcome.body) && typeof outcome.body.expiresAt === "string" ? outcome.body.expiresAt : "";
        restart();
        setChange({ address, deadline: localDeadline(expiresAt) });
        setCode("");
        setCodeState("open");
        setAttemptsLeft(null);
        setResent(again);
        focusTarget.current = "code";
        return;
      }
      if (!again && outcome.kind === "error") {
        const error = errorOf(outcome.body);
        if (error === "invalid_address" || error === "email_taken") {
          focusTarget.current = "address";
          setFieldError(detailOf(outcome.body, emailCopy.add.invalid));
          return;
        }
      }
      await handleFailure(outcome, "send", (error, detail) => {
        if (error === "email_not_sent") return { tone: "warning", detail };
        return null;
      });
    } catch {
      setFeedback({ tone: "warning", detail: sharedCopy.network });
    } finally {
      setPending(false);
    }
  };

  const submitAddress = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sendBlocked) return;
    const address = normalizeAddress(value);
    if (address.length > MAX_ADDRESS_LENGTH || !ADDRESS_SHAPE.test(address)) {
      focusTarget.current = "address";
      setFieldError(emailCopy.add.invalid);
      return;
    }
    if (knownAddresses(payload).includes(address)) {
      focusTarget.current = "address";
      setFieldError(emailCopy.add.alreadyYours);
      return;
    }
    void send(address, false);
  };

  const submitCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!change || confirmBlocked) return;
    const digits = code.replace(/\s+/g, "");
    if (!EMAIL_CODE.test(digits)) return;
    setPending(true);
    setFeedback(null);
    setFieldError(null);
    setResent(false);
    try {
      const response = await securityRequest({
        method: "POST",
        path: "/api/account/email/confirm",
        csrfToken: payload.csrfToken,
        body: { code: digits },
      });
      const body = response.status === 204 ? null : await responseJson(response);
      if (response.ok) {
        onDone(change.address);
        return;
      }
      setCode("");
      const error = errorOf(body);
      if (response.status === 400 && error === "invalid_code") {
        const left = isObject(body) && typeof body.attemptsLeft === "number" ? body.attemptsLeft : null;
        setAttemptsLeft(left);
        if (left === 0) {
          setCodeState("exhausted");
          return;
        }
        focusTarget.current = "code";
        setFieldError(left === null ? emailCopy.code.wrongUnknown : emailCopy.code.wrong(left));
        return;
      }
      if (response.status === 404 && error === "no_pending_change") {
        setCodeState("gone");
        return;
      }
      await handleFailure({ kind: "error", response, status: response.status, body }, "confirm", () => null);
    } catch {
      setFeedback({ tone: "warning", detail: sharedCopy.network });
    } finally {
      setPending(false);
    }
  };

  if (!change) {
    const inputId = `${baseId}-address`;
    const hintId = `${inputId}-hint`;
    const errorId = `${inputId}-error`;
    return (
      <form className="security-panel" aria-labelledby={`${baseId}-title`} noValidate onSubmit={submitAddress}>
        <h3 id={`${baseId}-title`} className="security-panel__title">
          {replacing ? <Pencil aria-hidden="true" size={16} /> : <Plus aria-hidden="true" size={16} />}
          {replacing ? emailCopy.change.title : emailCopy.add.title}
        </h3>
        <FeedbackAlert feedback={feedback} waitSeconds={waitSeconds} />
        <div className="sudo-field">
          <label htmlFor={inputId}>{replacing ? emailCopy.change.label : emailCopy.add.label}</label>
          <input
            ref={addressInput}
            id={inputId}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            required
            maxLength={MAX_ADDRESS_LENGTH}
            disabled={sendBlocked}
            aria-describedby={fieldError ? `${errorId} ${hintId}` : hintId}
            aria-invalid={fieldError ? true : undefined}
            value={value}
            onChange={(event) => {
              setValue(event.currentTarget.value);
              if (fieldError) setFieldError(null);
            }}
          />
          {fieldError ? <small id={errorId} className="security-field-error" role="alert">{fieldError}</small> : null}
          <small id={hintId}>
            {replacing
              ? `${emailCopy.change.hint(replacing)}${payload.primary === "personal" ? ` ${emailCopy.change.primary}` : ""}`
              : emailCopy.add.hint}
          </small>
        </div>
        <div className="security-panel__actions">
          <button className="secondary-button" type="button" disabled={pending} onClick={onCancel}>
            Vazgeç
          </button>
          <button className="primary-button" type="submit" disabled={sendBlocked || value.trim().length === 0}>
            {pending ? <ActionProgress label={emailCopy.add.sending} /> : emailCopy.add.send}
          </button>
        </div>
      </form>
    );
  }

  const codeId = `${baseId}-code`;
  const codeHintId = `${codeId}-hint`;
  const codeErrorId = `${codeId}-error`;
  const closedMessage = codeState === "exhausted"
    ? emailCopy.code.exhausted
    : codeState === "gone"
      ? emailCopy.code.gone
      : expired
        ? emailCopy.code.expired
        : null;
  return (
    <form
      className="security-panel"
      aria-labelledby={`${baseId}-code-title`}
      aria-busy={pending}
      noValidate
      onSubmit={(event) => void submitCode(event)}
    >
      <h3 id={`${baseId}-code-title`} className="security-panel__title">
        <MailCheck aria-hidden="true" size={16} />
        {emailCopy.code.title}
      </h3>
      <p className="email-code__lead">{emailCopy.code.sentTo(change.address)}</p>
      {replacing ? <p className="email-code__lead">{emailCopy.code.replaces(replacing)}</p> : null}
      {!codeClosed ? (
        <p className="email-code__timer" role="timer">
          {emailCopy.code.remaining} <strong>{formatCountdown(remaining)}</strong>
        </p>
      ) : null}
      {resent ? <p className="email-code__resent" role="status">{emailCopy.code.resent}</p> : null}
      {attemptsLeft !== null && attemptsLeft > 0 && !codeClosed && !fieldError ? (
        <p className="email-code__timer">{emailCopy.code.attemptsLeft(attemptsLeft)}</p>
      ) : null}
      {closedMessage ? <FeedbackAlert feedback={{ tone: "warning", detail: closedMessage }} /> : null}
      <FeedbackAlert feedback={feedback} waitSeconds={waitSeconds} />
      <div className="sudo-field">
        <label htmlFor={codeId}>{emailCopy.code.label}</label>
        <input
          ref={codeInput}
          id={codeId}
          name="code"
          type="text"
          inputMode="numeric"
          pattern="[0-9 ]*"
          autoComplete="one-time-code"
          autoFocus
          required
          maxLength={11}
          disabled={codeClosed}
          readOnly={pending}
          aria-describedby={fieldError ? `${codeErrorId} ${codeHintId}` : codeHintId}
          aria-invalid={fieldError ? true : undefined}
          value={code}
          onChange={(event) => {
            setCode(event.currentTarget.value);
            if (fieldError) setFieldError(null);
          }}
        />
        {fieldError ? <small id={codeErrorId} className="security-field-error" role="alert">{fieldError}</small> : null}
        <small id={codeHintId}>{emailCopy.code.hint}</small>
      </div>
      <div className="security-panel__actions">
        <button className="secondary-button" type="button" disabled={pending} onClick={onCancel}>
          Vazgeç
        </button>
        <button className="secondary-button" type="button" disabled={sendBlocked} onClick={() => void send(change.address, true)}>
          <RotateCcw aria-hidden="true" size={15} />
          {emailCopy.code.resend}
        </button>
        <button
          className="primary-button"
          type="submit"
          disabled={confirmBlocked || !EMAIL_CODE.test(code.replace(/\s+/g, ""))}
        >
          {pending ? <ActionProgress label={emailCopy.code.confirming} /> : emailCopy.code.confirm}
        </button>
      </div>
    </form>
  );
}

type PrimaryOption = {
  which: PrimaryChoice;
  title: string;
  address: string;
  /** Why the option cannot be chosen, or `null`. The current primary is never disabled. */
  blocked: string | null;
  action?: ReactNode;
};

function primaryOptions(payload: EmailPayload): PrimaryOption[] {
  const options: PrimaryOption[] = [];
  if (payload.schoolEmail) {
    const blocked = !payload.verifiedYtu && payload.primary !== "school";
    options.push({
      which: "school",
      title: emailCopy.school.title,
      address: payload.schoolEmail,
      blocked: blocked ? emailCopy.primary.schoolUnverified : null,
      ...(blocked ? { action: <YtuLink /> } : {}),
    });
  }
  if (payload.personalEmail) {
    const blocked = !payload.personalEmailVerified && payload.primary !== "personal";
    options.push({
      which: "personal",
      title: emailCopy.personal.title,
      address: payload.personalEmail,
      blocked: blocked ? emailCopy.primary.personalUnverified : null,
    });
  }
  return options;
}

/**
 * The Primary e-mail: one radio per address that exists, the unproven ones
 * disabled with the reason (a school address needs the YTÜ link, which
 * lives on the identity page). Saving runs Sudo mode and `email/primary`;
 * a `409 email_not_verified` is explained with the same way out.
 */
function PrimarySelector({
  payload,
  busy,
  onDone,
  ensureSudo,
  onCsrfRenewed,
  onAuthenticationRequired,
}: FlowCallbacks & {
  payload: EmailPayload;
  busy: boolean;
  onDone: (address: string) => void;
}) {
  const baseId = useId();
  const current = payload.primary === "none" ? null : payload.primary;
  const [selected, setSelected] = useState<PrimaryChoice | null>(current);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [refusedSchool, setRefusedSchool] = useState(false);
  const waitSeconds = useWaitSeconds(feedback);
  const options = primaryOptions(payload);
  const chosen = options.find((option) => option.which === selected) ?? null;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chosen || selected === current || pending || waitSeconds > 0) return;
    setPending(true);
    setFeedback(null);
    setRefusedSchool(false);
    try {
      const outcome = await runWithSudo(
        () => securityRequest({
          method: "POST",
          path: "/api/account/email/primary",
          csrfToken: payload.csrfToken,
          body: { which: chosen.which },
        }),
        ensureSudo,
      );
      if (outcome.kind === "ok") {
        onDone(chosen.address);
        return;
      }
      const next = feedbackFor(outcome, (error, detail) => {
        if (error === "email_not_verified") {
          setRefusedSchool(chosen.which === "school");
          return { tone: "danger", detail };
        }
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

  if (options.length === 0) {
    return (
      <div className="settings-row security-empty">
        <span className="settings-row__icon"><Star aria-hidden="true" size={19} /></span>
        <span className="settings-row__copy">
          <strong>{payload.email ?? emailCopy.school.missing}</strong>
          <small>{emailCopy.primary.noAddress}</small>
        </span>
      </div>
    );
  }

  return (
    <form className="email-primary" onSubmit={(event) => void save(event)} aria-busy={pending}>
      <fieldset className="email-primary__options" disabled={pending}>
        <legend className="sr-only">{emailCopy.primary.title}</legend>
        {current === null ? <p className="email-primary__none">{emailCopy.primary.none(payload.email)}</p> : null}
        {options.map((option) => {
          const descriptionId = `${baseId}-${option.which}-blocked`;
          return (
            <div className="email-primary__option" key={option.which}>
              <label className="security-checkbox">
                <input
                  type="radio"
                  name="primary"
                  value={option.which}
                  checked={selected === option.which}
                  disabled={option.blocked !== null}
                  aria-describedby={option.blocked ? descriptionId : undefined}
                  onChange={() => {
                    setSelected(option.which);
                    setFeedback(null);
                    setRefusedSchool(false);
                  }}
                />
                <span>
                  <strong>{option.title}</strong>
                  <small>{option.address}</small>
                </span>
              </label>
              {option.blocked ? (
                <div className="email-primary__blocked">
                  <small id={descriptionId}>{option.blocked}</small>
                  {option.action}
                </div>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <FeedbackAlert feedback={feedback} waitSeconds={waitSeconds} />
      {refusedSchool ? <div className="email-primary__blocked"><YtuLink /></div> : null}
      <div className="security-panel__actions">
        <small className="email-primary__sudo">{emailCopy.primary.sudo}</small>
        <button
          className="primary-button"
          type="submit"
          disabled={busy || pending || waitSeconds > 0 || !chosen || selected === current}
        >
          {pending ? <ActionProgress label={emailCopy.primary.saving} /> : emailCopy.primary.save}
        </button>
      </div>
    </form>
  );
}

/** The removal confirmation: the consequences, then Sudo mode and `DELETE email/personal`. */
function RemoveDialog({
  payload,
  onDone,
  onCancel,
  ensureSudo,
  onCsrfRenewed,
  onAuthenticationRequired,
}: FlowCallbacks & {
  payload: EmailPayload & { personalEmail: string };
  onDone: () => void;
  onCancel: () => void;
}) {
  const baseId = useId();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  /** The SPI kept a primary personal address because no linked school address can take over. */
  const [noFallback, setNoFallback] = useState(false);
  const waitSeconds = useWaitSeconds(feedback);

  const remove = async () => {
    if (pending || waitSeconds > 0) return;
    setPending(true);
    setFeedback(null);
    setNoFallback(false);
    try {
      const outcome = await runWithSudo(
        () => securityRequest({ method: "DELETE", path: "/api/account/email/personal", csrfToken: payload.csrfToken }),
        ensureSudo,
      );
      if (outcome.kind === "ok") {
        onDone();
        return;
      }
      const next = feedbackFor(outcome, (error) => {
        if (error === "no_fallback_email") setNoFallback(true);
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
      icon={<Trash2 size={22} />}
      onDismiss={onCancel}
    >
      <h2 id={titleId}>{emailCopy.remove.title}</h2>
      <p id={descriptionId}>{emailCopy.remove.body(payload.personalEmail)}</p>
      {payload.primary === "personal" ? (
        <ul className="security-hints identity-consequences">
          <li>{emailCopy.remove.primary}</li>
        </ul>
      ) : null}
      <p className="identity-consequences__sudo">{emailCopy.remove.sudo}</p>
      <FeedbackAlert feedback={feedback} waitSeconds={waitSeconds} />
      {noFallback && !payload.verifiedYtu ? <div className="email-primary__blocked"><YtuLink /></div> : null}
      <div className="confirmation-dialog__actions">
        <button className="secondary-button" type="button" disabled={pending} onClick={onCancel}>
          Vazgeç
        </button>
        <button
          className="danger-button danger-button--inline"
          type="button"
          disabled={pending || waitSeconds > 0}
          onClick={() => void remove()}
        >
          {pending ? <ActionProgress label={emailCopy.remove.removing} /> : (
            <><Trash2 aria-hidden="true" size={16} />{emailCopy.remove.confirm}</>
          )}
        </button>
      </div>
    </ModalDialog>
  );
}

/**
 * The e-mail page ("E-posta ve giriş"): the School e-mail (read-only, a
 * verified badge only for a Verified YTÜ account), the Personal e-mail
 * (add or change with a mailed six-digit code typed into this page, remove)
 * and the Primary e-mail choice, all read from `/api/account/email` and
 * re-read after every change; the server's addresses, not the answer of a
 * mutation, are what the page shows. A change still waiting for its code
 * (`/api/account/email/pending`) reopens the code panel on load and when the
 * person comes back to the page (from the mail app), never over a form they
 * are using.
 */
export function EmailManager() {
  const router = useRouter();
  const { ensureSudo, invalidateSudo } = useSudo();
  const [payload, setPayload] = useState<EmailPayload | null>(null);
  const [problem, setProblem] = useState<{ title: string; detail: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const firstLoadStarted = useRef(false);
  /** Read by the visibility listener, which must not replace a flow the person opened meanwhile. */
  const flowRef = useRef<Flow | null>(null);
  const payloadRef = useRef<EmailPayload | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const focusNotice = useRef(false);

  const onAuthenticationRequired = useCallback(() => {
    router.replace(loginPath(RETURN_TO));
  }, [router]);

  const load = useCallback(async (preserve = false): Promise<EmailPayload | null> => {
    if (!preserve) setLoading(true);
    setProblem(null);
    try {
      const response = await fetch("/api/account/email", { cache: "no-store", credentials: "same-origin" });
      const body = await responseJson(response);
      if (response.status === 401) {
        onAuthenticationRequired();
        return null;
      }
      if (!response.ok) {
        setProblem({ title: emailCopy.loadFailed.title, detail: detailOf(body, emailCopy.loadFailed.detail) });
        return null;
      }
      const parsed = parseEmailPayload(body);
      if (!parsed) {
        setProblem(emailCopy.contract);
        return null;
      }
      payloadRef.current = parsed;
      setPayload(parsed);
      return parsed;
    } catch {
      setProblem(emailCopy.loadFailed);
      return null;
    } finally {
      setLoading(false);
    }
  }, [onAuthenticationRequired]);

  const changeFlow = useCallback((next: Flow | null) => {
    flowRef.current = next;
    setFlow(next);
  }, []);

  /**
   * Reopens the code panel of a change the SPI still holds. Best effort: an
   * answer that is not a waiting change (none, an outage, drift) leaves the
   * page as it is, and a flow the person opened meanwhile is never replaced.
   */
  const restoreWaiting = useCallback(async (current: EmailPayload) => {
    if (flowRef.current !== null) return;
    try {
      const response = await fetch("/api/account/email/pending", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) return;
      const waiting = parsePendingPayload(await responseJson(response));
      if (!waiting || flowRef.current !== null) return;
      changeFlow({ kind: current.personalEmail ? "change" : "add", waiting });
    } catch {
      // The page works without it; the next load or return asks again.
    }
  }, [changeFlow]);

  useEffect(() => {
    if (firstLoadStarted.current) return;
    firstLoadStarted.current = true;
    void load().then((loaded) => {
      if (loaded) void restoreWaiting(loaded);
    });
  }, [load, restoreWaiting]);

  // Coming back from the mail app: the person may have left the code panel or reloaded elsewhere.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !payloadRef.current) return;
      void restoreWaiting(payloadRef.current);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [restoreWaiting]);

  useEffect(() => {
    if (!focusNotice.current || !noticeRef.current) return;
    focusNotice.current = false;
    noticeRef.current.focus();
  }, [notice, payload]);

  const openFlow = useCallback((next: Flow, element: HTMLElement) => {
    trigger.current = element;
    setNotice(null);
    changeFlow(next);
  }, [changeFlow]);

  const closeFlow = useCallback(() => {
    changeFlow(null);
    const element = trigger.current;
    trigger.current = null;
    queueMicrotask(() => {
      if (element?.isConnected) element.focus();
    });
  }, [changeFlow]);

  const finish = useCallback(async (detail: string) => {
    changeFlow(null);
    trigger.current = null;
    focusNotice.current = true;
    setNotice({ tone: "positive", title: "İşlem tamamlandı", detail });
    await load(true);
  }, [changeFlow, load]);

  const csrfRenewed = useCallback(async () => {
    invalidateSudo();
    await load(true);
  }, [invalidateSudo, load]);

  if (loading && !payload) {
    return (
      <section className="state-card session-state" aria-label={emailCopy.loading}>
        <ActionProgress label={emailCopy.loading} />
      </section>
    );
  }

  if (problem || !payload) {
    return (
      <RetryableError
        detail={problem?.detail ?? emailCopy.loadFailed.detail}
        onRetry={() => void load()}
        pending={loading}
        title={problem?.title ?? emailCopy.loadFailed.title}
      />
    );
  }

  const busy = flow !== null;
  const callbacks: FlowCallbacks = { ensureSudo, onCsrfRenewed: csrfRenewed, onAuthenticationRequired };
  const personalEmail = payload.personalEmail;

  return (
    <>
      {notice ? (
        <div ref={noticeRef} className="action-notice security-notice" data-tone={notice.tone} role="status" tabIndex={-1}>
          <strong>{notice.title}</strong>
          <span>{notice.detail}</span>
        </div>
      ) : null}

      <SettingsGroup title={emailCopy.school.title} description={emailCopy.school.description}>
        <div className="settings-row" data-has-trailing="">
          <span className="settings-row__icon"><GraduationCap aria-hidden="true" size={19} /></span>
          <span className="settings-row__copy">
            <strong className="email-address">{payload.schoolEmail ?? emailCopy.school.missing}</strong>
            <small>
              {payload.verifiedYtu
                ? emailCopy.school.verifiedDetail
                : payload.schoolEmail ? emailCopy.school.unverifiedDetail : emailCopy.school.missingDetail}
            </small>
          </span>
          <div className="settings-row__trailing security-row-actions">
            {payload.verifiedYtu ? <StatusBadge tone="positive">{emailCopy.verified}</StatusBadge> : <YtuLink />}
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title={emailCopy.personal.title} description={emailCopy.personal.description}>
        {personalEmail ? (
          <div className="settings-row" data-has-trailing="">
            <span className="settings-row__icon"><Mail aria-hidden="true" size={19} /></span>
            <span className="settings-row__copy">
              <strong className="email-address">{personalEmail}</strong>
              <small>{payload.personalEmailVerified ? emailCopy.personal.verifiedDetail : emailCopy.personal.unverifiedDetail}</small>
            </span>
            <div className="settings-row__trailing security-row-actions">
              <StatusBadge tone={payload.personalEmailVerified ? "positive" : "warning"}>
                {payload.personalEmailVerified ? emailCopy.verified : emailCopy.unverified}
              </StatusBadge>
              <button
                className="security-action"
                type="button"
                aria-label={`${personalEmail} — ${emailCopy.personal.change}`}
                disabled={busy}
                onClick={(event) => openFlow({ kind: "change" }, event.currentTarget)}
              >
                <Pencil aria-hidden="true" size={15} />
                {emailCopy.personal.change}
              </button>
              <button
                className="quiet-danger-button"
                type="button"
                aria-label={`${personalEmail} — ${emailCopy.personal.remove}`}
                disabled={busy}
                onClick={(event) => openFlow({ kind: "remove" }, event.currentTarget)}
              >
                <Trash2 aria-hidden="true" size={15} />
                {emailCopy.personal.remove}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="settings-row security-empty">
              <span className="settings-row__icon"><Mail aria-hidden="true" size={19} /></span>
              <span className="settings-row__copy">
                <strong>{emailCopy.personal.empty}</strong>
                <small>{emailCopy.personal.emptyDetail}</small>
              </span>
            </div>
            <div className="security-group-actions">
              <button
                className="security-action"
                type="button"
                disabled={busy}
                onClick={(event) => openFlow({ kind: "add" }, event.currentTarget)}
              >
                <Plus aria-hidden="true" size={15} />
                {emailCopy.personal.add}
              </button>
            </div>
          </>
        )}
        {flow && flow.kind !== "remove" ? (
          <PersonalEmailFlow
            key={flow.waiting?.expiresAt ?? flow.kind}
            payload={payload}
            replacing={flow.kind === "change" ? personalEmail : null}
            waiting={flow.waiting}
            onDone={(address) => void finish(
              flow.kind === "change" && personalEmail
                ? emailCopy.code.replaced(address, personalEmail)
                : emailCopy.code.confirmed(address),
            )}
            onCancel={closeFlow}
            {...callbacks}
          />
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={emailCopy.primary.title} description={emailCopy.primary.description}>
        <PrimarySelector
          key={`${payload.primary}|${payload.schoolEmail ?? ""}|${personalEmail ?? ""}|${payload.verifiedYtu}|${payload.personalEmailVerified}`}
          payload={payload}
          busy={busy}
          onDone={(address) => void finish(emailCopy.primary.saved(address))}
          {...callbacks}
        />
      </SettingsGroup>

      <aside className="read-only-note" aria-label="E-posta değişiklikleri hakkında">
        {emailCopy.note}
      </aside>

      {flow?.kind === "remove" && personalEmail ? (
        <RemoveDialog
          payload={{ ...payload, personalEmail }}
          onDone={() => void finish(emailCopy.remove.removed)}
          onCancel={closeFlow}
          {...callbacks}
        />
      ) : null}
    </>
  );
}
