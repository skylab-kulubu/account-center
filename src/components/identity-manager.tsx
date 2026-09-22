"use client";

import {
  AtSign,
  GraduationCap,
  Link2,
  Lock,
  Mail,
  Pencil,
  UserRound,
  UserRoundPen,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ModalDialog } from "@/components/modal-dialog";
import { FeedbackAlert, feedbackFor, loginPath, sharedCopy, useWaitSeconds } from "@/components/security-shared";
import type { Feedback } from "@/components/security-shared";
import { SettingsGroup, SettingsRow, StatusBadge } from "@/components/settings";
import { useSudo } from "@/components/sudo-provider";
import { ActionProgress, RetryableError } from "@/components/ui-states";
import {
  checkPersonName,
  checkUsername,
  MAX_PERSON_NAME_LENGTH,
  personNameLabels,
  personNameMessage,
  USERNAME_MAX_LENGTH,
  usernameMessage,
} from "@/lib/identity-fields";
import type { PersonNameField } from "@/lib/identity-fields";
import { detailOf, errorOf, isObject, responseJson, runWithSudo, securityRequest } from "@/lib/security-client";
import type { MutationOutcome } from "@/lib/security-client";

const RETURN_TO = "/identity";

/** Browser-side copy of `IdentityPayload` (`src/server/identity/view.ts`). */
export type IdentityPayload = {
  firstName: string | null;
  lastName: string | null;
  nameLocked: boolean;
  username: string;
  usernameChangeAvailableAt: string | null;
  verifiedYtu: boolean;
  schoolEmail: string | null;
  email: string | null;
  emailVerified: boolean;
  csrfToken: string;
};

export const identityCopy = {
  loading: "Kimlik bilgilerin yükleniyor",
  loadFailed: {
    title: "Kimlik bilgileri yüklenemedi",
    detail: "Kimlik hizmetine şu anda ulaşılamıyor. Kısa bir süre sonra yeniden deneyebilirsin.",
  },
  contract: {
    title: "Kimlik bilgileri güvenle durduruldu",
    detail: "Kimlik hizmetinin yanıtı desteklenen biçimle eşleşmedi. Hiçbir ham veri gösterilmedi.",
  },
  name: {
    title: "Ad soyad",
    description: "Kulüp kayıtlarında, belgelerde ve SKY LAB uygulamalarında görünen adın.",
    missing: "Tanımlı değil",
    locked: "YTÜ hesabından gelir; yönetim ekibi düzeltebilir.",
    lockedBadge: "YTÜ kaydından",
    editable: "Adını buradan değiştirebilirsin. YTÜ hesabını bağladığında adın YTÜ kaydından gelir.",
    edit: "Adı düzenle",
    formTitle: "Adı düzenle",
    hint: `Her alan en fazla ${MAX_PERSON_NAME_LENGTH} karakter; görünmez karakterler ve < > & " gibi işaretler kullanılamaz.`,
    save: "Adı kaydet",
    saving: "Kaydediliyor",
    saved: "Adın güncellendi.",
    coreDeferred: "Kulüp profilindeki adın daha sonra eşitlenecek.",
    unchanged: "Adında değişiklik yok.",
    lockedNow: "Adın artık YTÜ kaydından geliyor; buradan değiştirilemez.",
  },
  username: {
    title: "Kullanıcı adı",
    description: "Giriş yaparken parolanla birlikte kullandığın ad. Kullanıcı adını 14 günde bir değiştirebilirsin.",
    change: "Kullanıcı adını değiştir",
    formTitle: "Kullanıcı adını değiştir",
    label: "Yeni kullanıcı adı",
    hint: "3–30 karakter; yalnız küçük harf (a-z), rakam, nokta ve alt çizgi. Büyük harfler küçültülür.",
    continue: "Devam et",
    same: "Bu zaten kullanıcı adın.",
    taken: "Bu kullanıcı adı kullanılıyor.",
    cooldown: (absolute: string, relative: string) =>
      `Kullanıcı adını en erken ${absolute} tarihinde yeniden değiştirebilirsin (${relative}).`,
    changing: "Değiştiriliyor",
    changed: (username: string) => `Kullanıcı adın ${username} olarak değiştirildi. Bundan sonra giriş yaparken bu adı kullan.`,
    confirm: {
      title: "Kullanıcı adın değişsin mi?",
      lead: (username: string) => `Yeni kullanıcı adın ${username} olacak. Devam etmeden önce şunları bil:`,
      consequences: [
        "Giriş yaparken yeni adını kullanacaksın.",
        "Eski adın boşa çıkar ve başkası alabilir.",
        "Kullanıcı adını 14 günde bir değiştirebilirsin.",
      ],
      sudo: "Onayladıktan sonra kimliğini doğrulaman istenir.",
      confirm: "Onayla ve doğrula",
    },
  },
  ytu: {
    title: "YTÜ durumu",
    verified: "Doğrulanmış YTÜ hesabı",
    verifiedBadge: "Doğrulandı",
    verifiedDetail: (schoolEmail: string | null) =>
      schoolEmail
        ? `${schoolEmail} adresiyle bağlı. Adın ve okul e-postan YTÜ kaydından gelir.`
        : "YTÜ Microsoft hesabın bağlı. Adın ve okul e-postan YTÜ kaydından gelir.",
    unverified: "YTÜ hesabın bağlı değil",
    unverifiedDetail: "YTÜ Microsoft hesabını bağladığında adın ve okul e-postan YTÜ kaydından gelir ve kilitlenir.",
    link: "YTÜ hesabımı bağla",
    confirm: {
      title: "YTÜ hesabın bağlansın mı?",
      lead: "Microsoft ile YTÜ hesabına giriş yapacaksın. Devam etmeden önce şunları bil:",
      consequences: [
        "Bağlandıktan sonra adın ve okul e-postan YTÜ kaydından gelir ve buradan değiştirilemez.",
        "Okul e-postan, giriş yaptığın YTÜ Microsoft hesabındaki adres olur.",
        "Bağlantı kalıcıdır; buradan kaldırılamaz.",
      ],
      note: "Kısa bir süre için e.yildizskylab.com ve Microsoft sayfalarına gideceksin; işlem bitince bu sayfaya dönersin.",
      confirm: "Microsoft ile devam et",
      redirecting: "Yönlendiriliyor",
    },
    unexpectedAnswer: "Yönlendirme adresi alınamadı. Yeniden dene.",
    notices: {
      linked: {
        tone: "positive",
        title: "YTÜ hesabın bağlandı",
        detail: "Adın ve okul e-postan artık YTÜ kaydından gelir ve buradan değiştirilemez.",
      },
      cancelled: {
        tone: "neutral",
        title: "Bağlama tamamlanmadı",
        detail: "Hesabında değişiklik yapılmadı. İstediğinde yeniden deneyebilirsin.",
      },
      error: {
        tone: "warning",
        title: "YTÜ hesabı bağlanamadı",
        detail: "YTÜ girişi tamamlanamadı ya da bu Microsoft hesabı başka bir SKY LAB hesabına bağlı. Yeniden dene; sorun sürerse yönetim ekibine yaz.",
      },
      unverified: {
        tone: "warning",
        title: "Bağlantı doğrulanamadı",
        detail: "Microsoft girişi tamamlandı ama hesabında YTÜ bağlantısı görünmüyor. Bu sayfa güncel durumu gösterir; bağlı görünmüyorsa yeniden dene.",
      },
      already_linked: {
        tone: "neutral",
        title: "YTÜ hesabın zaten bağlı",
        detail: "Adın ve okul e-postan YTÜ kaydından geliyor; yeniden bağlaman gerekmez.",
      },
      unavailable: {
        tone: "warning",
        title: "Bağlama başlatılamadı",
        detail: "Kimlik hizmetine şu anda ulaşılamıyor. Kısa bir süre sonra yeniden dene.",
      },
    },
  },
  email: {
    title: "E-posta",
    primary: "Birincil e-posta",
    primaryDetail: "Kulüp postaları bu adrese gelir; giriş yaparken de kullanabilirsin.",
    verified: "Doğrulandı",
    unverified: "Doğrulanmadı",
    missing: "Tanımlı değil",
    school: "Okul e-postası",
    schoolDetail: "YTÜ hesabından gelir; buradan değiştirilemez.",
    schoolMissing: "Kayıtlı değil",
    schoolBadge: "YTÜ hesabından gelir",
    manage: "E-posta ayarları",
    soon: "Yakında",
    soonDetail: "Kişisel e-posta ekleme ve birincil adres seçimi yakında bu sayfaya gelecek.",
  },
  note: "Ad ve kullanıcı adı değişiklikleri Keycloak'taki SKY LAB kimliğinde yapılır ve her SKY LAB uygulamasında geçerlidir. Kullanıcı adı değişikliği kimliğini yeniden doğrulamanı ister; YTÜ hesabını bağlamak seni kısa süreliğine Microsoft girişine götürür.",
} as const;

type Flow =
  | { kind: "name" }
  | { kind: "username"; stage: "form" | "confirm" }
  | { kind: "ytu-link" };

type Notice = { tone: "positive" | "neutral" | "warning"; title: string; detail: string };

/** `?ytu=` values the identity page announces after the Microsoft round trip (`src/server/identity/ytu-link.ts`). */
export type YtuLinkOutcome = keyof typeof identityCopy.ytu.notices;

export const YTU_LINK_QUERY = "ytu";

export function ytuLinkNotice(value: string | null): Notice | null {
  if (!value || !Object.hasOwn(identityCopy.ytu.notices, value)) return null;
  return identityCopy.ytu.notices[value as YtuLinkOutcome];
}

/** The Keycloak authorization URL the BFF answered, accepted only as an absolute HTTPS address. */
export function authorizationUrlOf(answer: unknown): string | null {
  if (!isObject(answer) || typeof answer.authorizationUrl !== "string" || answer.authorizationUrl.length > 4_096) return null;
  try {
    const url = new URL(answer.authorizationUrl);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const absoluteFormatter = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Europe/Istanbul",
});

/** Turkish relative and absolute wording of the next allowed username change, or `null` once it has passed. */
export function describeCooldown(availableAt: Date, now: Date = new Date()): { relative: string; absolute: string } | null {
  const remaining = availableAt.getTime() - now.getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const minutes = Math.ceil(remaining / 60_000);
  const hours = Math.ceil(remaining / 3_600_000);
  const days = Math.ceil(remaining / 86_400_000);
  const relative = minutes < 60 ? `${minutes} dakika sonra` : hours < 24 ? `${hours} saat sonra` : `${days} gün sonra`;
  return { relative, absolute: absoluteFormatter.format(availableAt) };
}

function optionalText(value: unknown, maximum = 320): value is string | null {
  return value === null || (typeof value === "string" && value.length <= maximum);
}

function validIsoDate(value: unknown) {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

/** Fail-closed parser for the BFF identity payload: nothing unexpected reaches the DOM. */
export function parseIdentityPayload(value: unknown): IdentityPayload | null {
  if (
    !isObject(value) ||
    !optionalText(value.firstName, 255) ||
    !optionalText(value.lastName, 255) ||
    typeof value.nameLocked !== "boolean" ||
    typeof value.username !== "string" ||
    value.username.length === 0 ||
    value.username.length > 255 ||
    (value.usernameChangeAvailableAt !== null && !validIsoDate(value.usernameChangeAvailableAt)) ||
    typeof value.verifiedYtu !== "boolean" ||
    !optionalText(value.schoolEmail) ||
    !optionalText(value.email) ||
    typeof value.emailVerified !== "boolean" ||
    typeof value.csrfToken !== "string" ||
    value.csrfToken.length < 1 ||
    value.csrfToken.length > 128
  ) return null;
  return {
    firstName: value.firstName,
    lastName: value.lastName,
    nameLocked: value.nameLocked,
    username: value.username,
    usernameChangeAvailableAt: value.usernameChangeAvailableAt as string | null,
    verifiedYtu: value.verifiedYtu,
    schoolEmail: value.schoolEmail,
    email: value.email,
    emailVerified: value.emailVerified,
    csrfToken: value.csrfToken,
  };
}

function fullName(payload: Pick<IdentityPayload, "firstName" | "lastName">) {
  return [payload.firstName, payload.lastName].filter(Boolean).join(" ") || null;
}

type NameFormProps = {
  payload: IdentityPayload;
  onDone: (message: string, coreSync: "synced" | "failed" | "disabled") => void;
  onCancel: () => void;
  onLocked: (detail: string) => void;
  onCsrfRenewed: () => Promise<void>;
  onAuthenticationRequired: () => void;
};

/**
 * First and last name, checked with the shared rules before the request,
 * patched without Sudo mode. The SPI's `invalid_name` names the field; a
 * `403 name_locked` means the account became a Verified YTÜ account since
 * the page loaded, so the page re-reads the identity instead of retrying.
 */
function NameForm({ payload, onDone, onCancel, onLocked, onCsrfRenewed, onAuthenticationRequired }: NameFormProps) {
  const baseId = useId();
  const [values, setValues] = useState<Record<PersonNameField, string>>({
    firstName: payload.firstName ?? "",
    lastName: payload.lastName ?? "",
  });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<PersonNameField, string>>>({});
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const waitSeconds = useWaitSeconds(feedback);
  const inputs = useRef<Partial<Record<PersonNameField, HTMLInputElement | null>>>({});
  /** The field to focus once the DOM shows its error and the inputs are enabled again. */
  const focusField = useRef<PersonNameField | null>(null);
  const busy = pending || waitSeconds > 0;
  const fields: PersonNameField[] = ["firstName", "lastName"];

  useEffect(() => {
    const field = focusField.current;
    if (!field || pending) return;
    focusField.current = null;
    inputs.current[field]?.focus();
  }, [fieldErrors, pending]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const checked: Partial<Record<PersonNameField, string>> = {};
    const errors: Partial<Record<PersonNameField, string>> = {};
    for (const field of fields) {
      const check = checkPersonName(values[field]);
      if (check.ok) checked[field] = check.value;
      else errors[field] = personNameMessage(field, check.reason);
    }
    if (errors.firstName || errors.lastName) {
      focusField.current = fields.find((field) => errors[field]) ?? null;
      setFieldErrors(errors);
      return;
    }
    const body = { firstName: checked.firstName!, lastName: checked.lastName! };
    if (body.firstName === (payload.firstName ?? "") && body.lastName === (payload.lastName ?? "")) {
      setFeedback({ tone: "warning", detail: identityCopy.name.unchanged });
      return;
    }
    setPending(true);
    setFeedback(null);
    setFieldErrors({});
    try {
      const response = await securityRequest({ method: "PATCH", path: "/api/account/identity/name", csrfToken: payload.csrfToken, body });
      const answer = await responseJson(response);
      if (response.ok) {
        const coreSync = isObject(answer) && (answer.coreSync === "failed" || answer.coreSync === "disabled") ? answer.coreSync : "synced";
        onDone(identityCopy.name.saved, coreSync);
        return;
      }
      const error = errorOf(answer);
      if (response.status === 403 && error === "name_locked") {
        onLocked(detailOf(answer, identityCopy.name.lockedNow));
        return;
      }
      if (response.status === 400 && error === "invalid_name" && isObject(answer) &&
        (answer.field === "firstName" || answer.field === "lastName")) {
        const field = answer.field;
        focusField.current = field;
        setFieldErrors({ [field]: detailOf(answer, personNameMessage(field, "empty")) });
        return;
      }
      const outcome: MutationOutcome = { kind: "error", response, status: response.status, body: answer };
      const next = feedbackFor(outcome, (code, detail) => {
        if (code === "invalid_name" || code === "invalid_request") return { tone: "danger", detail };
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

  const hintId = `${baseId}-hint`;
  return (
    <form className="security-panel" aria-labelledby={`${baseId}-title`} noValidate onSubmit={(event) => void submit(event)}>
      <h3 id={`${baseId}-title`} className="security-panel__title">
        <UserRoundPen aria-hidden="true" size={16} />
        {identityCopy.name.formTitle}
      </h3>
      <FeedbackAlert feedback={feedback} waitSeconds={waitSeconds} />
      {fields.map((field, index) => {
        const inputId = `${baseId}-${field}`;
        const errorId = `${inputId}-error`;
        const error = fieldErrors[field];
        return (
          <div className="sudo-field" key={field}>
            <label htmlFor={inputId}>{personNameLabels[field]}</label>
            <input
              ref={(element) => { inputs.current[field] = element; }}
              id={inputId}
              name={field}
              type="text"
              autoComplete={field === "firstName" ? "given-name" : "family-name"}
              autoFocus={index === 0}
              required
              maxLength={MAX_PERSON_NAME_LENGTH}
              disabled={busy}
              aria-describedby={error ? `${errorId} ${hintId}` : hintId}
              aria-invalid={error ? true : undefined}
              value={values[field]}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setValues((previous) => ({ ...previous, [field]: next }));
                if (error) setFieldErrors((previous) => ({ ...previous, [field]: undefined }));
              }}
            />
            {error ? <small id={errorId} className="security-field-error" role="alert">{error}</small> : null}
          </div>
        );
      })}
      <ul id={hintId} className="security-hints">
        <li>{identityCopy.name.hint}</li>
      </ul>
      <div className="security-panel__actions">
        <button className="secondary-button" type="button" disabled={pending} onClick={onCancel}>
          Vazgeç
        </button>
        <button
          className="primary-button"
          type="submit"
          disabled={busy || values.firstName.trim().length === 0 || values.lastName.trim().length === 0}
        >
          {pending ? <ActionProgress label={identityCopy.name.saving} /> : identityCopy.name.save}
        </button>
      </div>
    </form>
  );
}

type UsernameFormProps = {
  payload: IdentityPayload;
  stage: "form" | "confirm";
  onConfirmationChange: (open: boolean) => void;
  ensureSudo: (options?: { challenged?: boolean }) => Promise<boolean>;
  onDone: (username: string) => void;
  onCancel: () => void;
  onCsrfRenewed: () => Promise<void>;
  onAuthenticationRequired: () => void;
};

/**
 * New username → local pattern check → confirmation dialog stating the
 * consequences → the request behind Sudo mode (`runWithSudo` opens the
 * dialog on `428` and retries once). `username_taken` and `invalid_username`
 * land on the field; `username_cooldown` shows the next allowed moment.
 */
function UsernameForm({
  payload,
  stage,
  onConfirmationChange,
  ensureSudo,
  onDone,
  onCancel,
  onCsrfRenewed,
  onAuthenticationRequired,
}: UsernameFormProps) {
  const baseId = useId();
  const [value, setValue] = useState("");
  const [candidate, setCandidate] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const waitSeconds = useWaitSeconds(feedback);
  const input = useRef<HTMLInputElement>(null);
  /** Set when the field must regain focus once its error is shown and the input is enabled again. */
  const focusInput = useRef(false);
  const busy = pending || waitSeconds > 0;

  useEffect(() => {
    if (!focusInput.current || pending) return;
    focusInput.current = false;
    input.current?.focus();
  }, [fieldError, pending]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const check = checkUsername(value);
    if (!check.ok) {
      focusInput.current = true;
      setFieldError(usernameMessage(check.reason));
      return;
    }
    if (check.value === payload.username.toLowerCase()) {
      focusInput.current = true;
      setFieldError(identityCopy.username.same);
      return;
    }
    setFieldError(null);
    setFeedback(null);
    setCandidate(check.value);
    onConfirmationChange(true);
  };

  const change = async () => {
    if (!candidate || pending) return;
    onConfirmationChange(false);
    setPending(true);
    setFeedback(null);
    try {
      const outcome = await runWithSudo(
        () => securityRequest({
          method: "POST",
          path: "/api/account/identity/username",
          csrfToken: payload.csrfToken,
          body: { username: candidate },
        }),
        ensureSudo,
      );
      if (outcome.kind === "ok") {
        setValue("");
        onDone(candidate);
        return;
      }
      if (outcome.kind === "error" && isObject(outcome.body)) {
        const code = errorOf(outcome.body);
        if (code === "username_taken" || code === "invalid_username") {
          focusInput.current = true;
          setFieldError(detailOf(outcome.body, code === "username_taken" ? identityCopy.username.taken : usernameMessage("invalid_characters")));
          return;
        }
        if (code === "username_cooldown") {
          const availableAt = typeof outcome.body.availableAt === "string" ? new Date(outcome.body.availableAt) : null;
          const cooldown = availableAt ? describeCooldown(availableAt) : null;
          setFeedback({
            tone: "danger",
            detail: cooldown
              ? `${detailOf(outcome.body, "")} ${identityCopy.username.cooldown(cooldown.absolute, cooldown.relative)}`.trim()
              : detailOf(outcome.body, sharedCopy.unexpected),
          });
          return;
        }
      }
      const next = feedbackFor(outcome, (code, detail) => {
        if (code === "invalid_request") return { tone: "danger", detail };
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
      setCandidate(null);
    }
  };

  const dismissConfirmation = () => {
    setCandidate(null);
    onConfirmationChange(false);
    queueMicrotask(() => input.current?.focus());
  };

  const inputId = `${baseId}-username`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const dialogTitleId = `${baseId}-confirm-title`;
  const dialogDescriptionId = `${baseId}-confirm-description`;
  return (
    <>
      <form className="security-panel" aria-labelledby={`${baseId}-title`} noValidate onSubmit={submit}>
        <h3 id={`${baseId}-title`} className="security-panel__title">
          <Pencil aria-hidden="true" size={16} />
          {identityCopy.username.formTitle}
        </h3>
        <FeedbackAlert feedback={feedback} waitSeconds={waitSeconds} />
        <div className="sudo-field">
          <label htmlFor={inputId}>{identityCopy.username.label}</label>
          <input
            ref={input}
            id={inputId}
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            required
            maxLength={USERNAME_MAX_LENGTH}
            disabled={busy}
            aria-describedby={fieldError ? `${errorId} ${hintId}` : hintId}
            aria-invalid={fieldError ? true : undefined}
            value={value}
            onChange={(event) => {
              setValue(event.currentTarget.value.toLowerCase());
              if (fieldError) setFieldError(null);
            }}
          />
          {fieldError ? <small id={errorId} className="security-field-error" role="alert">{fieldError}</small> : null}
          <small id={hintId}>{identityCopy.username.hint}</small>
        </div>
        <div className="security-panel__actions">
          <button className="secondary-button" type="button" disabled={pending} onClick={onCancel}>
            Vazgeç
          </button>
          <button className="primary-button" type="submit" disabled={busy || value.trim().length === 0}>
            {pending ? <ActionProgress label={identityCopy.username.changing} /> : identityCopy.username.continue}
          </button>
        </div>
      </form>
      {stage === "confirm" && candidate ? (
        <ModalDialog
          titleId={dialogTitleId}
          descriptionId={dialogDescriptionId}
          className="security-dialog"
          icon={<Pencil size={22} />}
          onDismiss={dismissConfirmation}
        >
          <h2 id={dialogTitleId}>{identityCopy.username.confirm.title}</h2>
          <p id={dialogDescriptionId}>{identityCopy.username.confirm.lead(candidate)}</p>
          <ul className="security-hints identity-consequences">
            {identityCopy.username.confirm.consequences.map((consequence) => <li key={consequence}>{consequence}</li>)}
          </ul>
          <p className="identity-consequences__sudo">{identityCopy.username.confirm.sudo}</p>
          <div className="confirmation-dialog__actions">
            <button className="secondary-button" type="button" onClick={dismissConfirmation}>
              Vazgeç
            </button>
            <button className="primary-button" type="button" onClick={() => void change()}>
              {identityCopy.username.confirm.confirm}
            </button>
          </div>
        </ModalDialog>
      ) : null}
    </>
  );
}

type YtuLinkDialogProps = {
  payload: IdentityPayload;
  onDismiss: () => void;
  onAlreadyLinked: () => void;
  onCsrfRenewed: () => Promise<void>;
  onAuthenticationRequired: () => void;
};

/**
 * "YTÜ hesabımı bağla": the consequences (the name and school e-mail become
 * YTÜ's and lock, the school e-mail is the Microsoft account's address, no
 * unlink) and one button. Confirming asks the BFF to start the `idp_link`
 * action and then navigates to the Keycloak address it answered; the person
 * comes back to this page with `?ytu=`. The dialog stays busy while the
 * browser leaves, and a `409 already_linked` re-reads the identity instead.
 */
function YtuLinkDialog({ payload, onDismiss, onAlreadyLinked, onCsrfRenewed, onAuthenticationRequired }: YtuLinkDialogProps) {
  const baseId = useId();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const waitSeconds = useWaitSeconds(feedback);
  const busy = pending || waitSeconds > 0;

  const start = async () => {
    if (busy) return;
    setPending(true);
    setFeedback(null);
    let leaving = false;
    try {
      const response = await securityRequest({ method: "POST", path: "/api/account/identity/ytu-link", csrfToken: payload.csrfToken });
      const answer = await responseJson(response);
      if (response.ok) {
        const authorizationUrl = authorizationUrlOf(answer);
        if (!authorizationUrl) {
          setFeedback({ tone: "warning", detail: identityCopy.ytu.unexpectedAnswer });
          return;
        }
        leaving = true;
        window.location.assign(authorizationUrl);
        return;
      }
      if (response.status === 409 && errorOf(answer) === "already_linked") {
        onAlreadyLinked();
        return;
      }
      const next = feedbackFor({ kind: "error", response, status: response.status, body: answer }, (code, detail) => {
        if (code === "invalid_request") return { tone: "danger", detail };
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
      if (!leaving) setPending(false);
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
      icon={<Link2 size={22} />}
      onDismiss={onDismiss}
    >
      <h2 id={titleId}>{identityCopy.ytu.confirm.title}</h2>
      <p id={descriptionId}>{identityCopy.ytu.confirm.lead}</p>
      <ul className="security-hints identity-consequences">
        {identityCopy.ytu.confirm.consequences.map((consequence) => <li key={consequence}>{consequence}</li>)}
      </ul>
      <p className="identity-consequences__sudo">{identityCopy.ytu.confirm.note}</p>
      <FeedbackAlert feedback={feedback} waitSeconds={waitSeconds} />
      <div className="confirmation-dialog__actions">
        <button className="secondary-button" type="button" disabled={pending} onClick={onDismiss}>
          Vazgeç
        </button>
        <button className="primary-button" type="button" disabled={busy} onClick={() => void start()}>
          {pending ? <ActionProgress label={identityCopy.ytu.confirm.redirecting} /> : identityCopy.ytu.confirm.confirm}
        </button>
      </div>
    </ModalDialog>
  );
}

/**
 * The identity page: name (locked for a Verified YTÜ account), username
 * (confirmation + Sudo mode, 14-day cooldown), YTÜ status with the link
 * (a confirmation dialog, then Keycloak's `idp_link` action at Microsoft,
 * announced from `?ytu=` on return) and the e-mail rows, all read from
 * `/api/account/identity` and always re-read after a change; the server's
 * identity, not the answer of a mutation, is what the page shows.
 */
export function IdentityManager() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { ensureSudo, invalidateSudo } = useSudo();
  const [payload, setPayload] = useState<IdentityPayload | null>(null);
  const [problem, setProblem] = useState<{ title: string; detail: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [flow, setFlow] = useState<Flow | null>(null);
  // The Microsoft round trip ends in a full navigation, so its outcome is read once at mount.
  const [returnNotice] = useState<Notice | null>(() => ytuLinkNotice(searchParams.get(YTU_LINK_QUERY)));
  const [notices, setNotices] = useState<Notice[]>(() => returnNotice ? [returnNotice] : []);
  const firstLoadStarted = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const focusNotice = useRef(returnNotice !== null);
  const returnHandled = useRef(false);
  const soonId = useId();

  useEffect(() => {
    if (!returnNotice || returnHandled.current) return;
    returnHandled.current = true;
    const remaining = new URLSearchParams(searchParams.toString());
    remaining.delete(YTU_LINK_QUERY);
    const query = remaining.toString();
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
  }, [pathname, returnNotice, searchParams]);

  const onAuthenticationRequired = useCallback(() => {
    router.replace(loginPath(RETURN_TO));
  }, [router]);

  const load = useCallback(async (preserve = false) => {
    if (!preserve) setLoading(true);
    setProblem(null);
    try {
      const response = await fetch("/api/account/identity", { cache: "no-store", credentials: "same-origin" });
      const body = await responseJson(response);
      if (response.status === 401) {
        onAuthenticationRequired();
        return;
      }
      if (!response.ok) {
        setProblem({ title: identityCopy.loadFailed.title, detail: detailOf(body, identityCopy.loadFailed.detail) });
        return;
      }
      const parsed = parseIdentityPayload(body);
      if (!parsed) {
        setProblem(identityCopy.contract);
        return;
      }
      setPayload(parsed);
    } catch {
      setProblem(identityCopy.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [onAuthenticationRequired]);

  useEffect(() => {
    if (firstLoadStarted.current) return;
    firstLoadStarted.current = true;
    void load();
  }, [load]);

  // The notices region exists only once the identity is shown; a notice seeded from `?ytu=` waits for it.
  useEffect(() => {
    if (!focusNotice.current || notices.length === 0 || !noticeRef.current) return;
    focusNotice.current = false;
    noticeRef.current.focus();
  }, [notices, payload]);

  const openFlow = useCallback((next: Flow, element: HTMLElement) => {
    trigger.current = element;
    setNotices([]);
    setFlow(next);
  }, []);

  const closeFlow = useCallback(() => {
    setFlow(null);
    const element = trigger.current;
    trigger.current = null;
    queueMicrotask(() => {
      if (element?.isConnected) element.focus();
    });
  }, []);

  const finishFlow = useCallback(async (next: Notice[]) => {
    setFlow(null);
    trigger.current = null;
    focusNotice.current = true;
    setNotices(next);
    await load(true);
  }, [load]);

  const csrfRenewed = useCallback(async () => {
    invalidateSudo();
    await load(true);
  }, [invalidateSudo, load]);

  if (loading && !payload) {
    return (
      <section className="state-card session-state" aria-label={identityCopy.loading}>
        <ActionProgress label={identityCopy.loading} />
      </section>
    );
  }

  if (problem || !payload) {
    return (
      <RetryableError
        detail={problem?.detail ?? identityCopy.loadFailed.detail}
        onRetry={() => void load()}
        pending={loading}
        title={problem?.title ?? identityCopy.loadFailed.title}
      />
    );
  }

  const busy = flow !== null;
  const cooldown = payload.usernameChangeAvailableAt ? describeCooldown(new Date(payload.usernameChangeAvailableAt)) : null;
  const cooldownId = `${soonId}-cooldown`;
  const emailSoonId = `${soonId}-email`;

  return (
    <>
      {notices.length > 0 ? (
        <div ref={noticeRef} className="identity-notices" role="status" tabIndex={-1}>
          {notices.map((notice) => (
            <div key={notice.detail} className="action-notice security-notice" data-tone={notice.tone}>
              <strong>{notice.title}</strong>
              <span>{notice.detail}</span>
            </div>
          ))}
        </div>
      ) : null}

      <SettingsGroup title={identityCopy.name.title} description={identityCopy.name.description}>
        <div className="settings-row" data-has-trailing="">
          <span className="settings-row__icon"><UserRound aria-hidden="true" size={19} /></span>
          <span className="settings-row__copy">
            <strong>{fullName(payload) ?? identityCopy.name.missing}</strong>
            <small>{payload.nameLocked ? identityCopy.name.locked : identityCopy.name.editable}</small>
          </span>
          <div className="settings-row__trailing security-row-actions">
            {payload.nameLocked ? (
              <StatusBadge tone="positive">
                <Lock aria-hidden="true" size={12} className="identity-lock" />
                {identityCopy.name.lockedBadge}
              </StatusBadge>
            ) : (
              <button
                className="security-action"
                type="button"
                disabled={busy}
                onClick={(event) => openFlow({ kind: "name" }, event.currentTarget)}
              >
                <Pencil aria-hidden="true" size={15} />
                {identityCopy.name.edit}
              </button>
            )}
          </div>
        </div>
        {flow?.kind === "name" && !payload.nameLocked ? (
          <NameForm
            payload={payload}
            onDone={(message, coreSync) => void finishFlow([
              { tone: "positive", title: "İşlem tamamlandı", detail: message },
              ...(coreSync === "failed"
                ? [{ tone: "warning" as const, title: "Kulüp profili henüz eşitlenmedi", detail: identityCopy.name.coreDeferred }]
                : []),
            ])}
            onCancel={closeFlow}
            onLocked={(detail) => void finishFlow([{ tone: "warning", title: "Ad değiştirilemedi", detail }])}
            onCsrfRenewed={csrfRenewed}
            onAuthenticationRequired={onAuthenticationRequired}
          />
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={identityCopy.username.title} description={identityCopy.username.description}>
        <div className="settings-row" data-has-trailing="">
          <span className="settings-row__icon"><AtSign aria-hidden="true" size={19} /></span>
          <span className="settings-row__copy">
            <strong>{payload.username}</strong>
            {cooldown ? (
              <small id={cooldownId}>{identityCopy.username.cooldown(cooldown.absolute, cooldown.relative)}</small>
            ) : null}
          </span>
          <div className="settings-row__trailing security-row-actions">
            <button
              className="security-action"
              type="button"
              disabled={busy || cooldown !== null}
              aria-describedby={cooldown ? cooldownId : undefined}
              onClick={(event) => openFlow({ kind: "username", stage: "form" }, event.currentTarget)}
            >
              <Pencil aria-hidden="true" size={15} />
              {identityCopy.username.change}
            </button>
          </div>
        </div>
        {flow?.kind === "username" ? (
          <UsernameForm
            payload={payload}
            stage={flow.stage}
            onConfirmationChange={(open) => setFlow({ kind: "username", stage: open ? "confirm" : "form" })}
            ensureSudo={ensureSudo}
            onDone={(username) => void finishFlow([
              { tone: "positive", title: "İşlem tamamlandı", detail: identityCopy.username.changed(username) },
            ])}
            onCancel={closeFlow}
            onCsrfRenewed={csrfRenewed}
            onAuthenticationRequired={onAuthenticationRequired}
          />
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={identityCopy.ytu.title}>
        <div className="settings-row" data-has-trailing="">
          <span className="settings-row__icon"><GraduationCap aria-hidden="true" size={19} /></span>
          <span className="settings-row__copy">
            <strong>{payload.verifiedYtu ? identityCopy.ytu.verified : identityCopy.ytu.unverified}</strong>
            <small>
              {payload.verifiedYtu ? identityCopy.ytu.verifiedDetail(payload.schoolEmail) : identityCopy.ytu.unverifiedDetail}
            </small>
          </span>
          <div className="settings-row__trailing security-row-actions">
            {payload.verifiedYtu ? (
              <StatusBadge tone="positive">{identityCopy.ytu.verifiedBadge}</StatusBadge>
            ) : (
              <button
                className="security-action"
                type="button"
                disabled={busy}
                onClick={(event) => openFlow({ kind: "ytu-link" }, event.currentTarget)}
              >
                <Link2 aria-hidden="true" size={15} />
                {identityCopy.ytu.link}
              </button>
            )}
          </div>
        </div>
        {flow?.kind === "ytu-link" && !payload.verifiedYtu ? (
          <YtuLinkDialog
            payload={payload}
            onDismiss={closeFlow}
            onAlreadyLinked={() => void finishFlow([identityCopy.ytu.notices.already_linked])}
            onCsrfRenewed={csrfRenewed}
            onAuthenticationRequired={onAuthenticationRequired}
          />
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={identityCopy.email.title}>
        <SettingsRow
          icon={<Mail aria-hidden="true" size={19} />}
          title={identityCopy.email.primary}
          description={`${payload.email ?? identityCopy.email.missing} · ${identityCopy.email.primaryDetail}`}
          trailing={
            <StatusBadge tone={payload.emailVerified ? "positive" : "warning"}>
              {payload.emailVerified ? identityCopy.email.verified : identityCopy.email.unverified}
            </StatusBadge>
          }
        />
        <SettingsRow
          icon={<AtSign aria-hidden="true" size={19} />}
          title={identityCopy.email.school}
          description={`${payload.schoolEmail ?? identityCopy.email.schoolMissing} · ${identityCopy.email.schoolDetail}`}
          trailing={<StatusBadge>{identityCopy.email.schoolBadge}</StatusBadge>}
        />
        <div className="security-group-actions">
          <StatusBadge tone="warning">{identityCopy.email.soon}</StatusBadge>
          <button className="security-action" type="button" disabled aria-describedby={emailSoonId}>
            <Mail aria-hidden="true" size={15} />
            {identityCopy.email.manage}
          </button>
          <small id={emailSoonId} className="security-group-actions__hint">{identityCopy.email.soonDetail}</small>
        </div>
      </SettingsGroup>

      <aside className="read-only-note" aria-label="Kimlik değişiklikleri hakkında">
        {identityCopy.note}
      </aside>
    </>
  );
}
