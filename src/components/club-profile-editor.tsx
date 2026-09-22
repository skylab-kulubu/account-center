"use client";

import {
  AlertCircle,
  BookOpen,
  Camera,
  CircleUserRound,
  GraduationCap,
  Landmark,
  Link2,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { StatusBadge } from "@/components/settings";
import { ActionProgress } from "@/components/ui-states";
import {
  CLUB_PROFILE_EDITABLE_FIELDS,
  CLUB_PROFILE_LINKEDIN_MAX_LENGTH,
  CLUB_PROFILE_PICTURE_FIELD,
  CLUB_PROFILE_PICTURE_MAX_BYTES,
  CLUB_PROFILE_PICTURE_TYPES,
  CLUB_PROFILE_TEXT_MAX_LENGTH,
  hasForbiddenCharacters,
  isClubProfilePictureType,
  isLinkedinProfileUrl,
} from "@/config/club-profile";
import type { ClubProfileEditableField } from "@/config/club-profile";
import type { ClubProfileView } from "@/server/club-profile/service";

type FormValues = Record<ClubProfileEditableField, string>;

type SafeProblem = {
  title: string;
  detail: string;
  status: number;
  field?: ClubProfileEditableField;
};

type Pending = "save" | "upload" | "remove" | null;

type Feedback =
  | { tone: "success"; message: string }
  | { tone: "danger"; problem: SafeProblem };

/** Where focus goes once the pending action has settled and the DOM reflects it. */
type FocusTarget =
  | { kind: "feedback" }
  | { kind: "remove-trigger" }
  | { kind: "field"; field: ClubProfileEditableField };

const LOGIN_HREF = "/login?returnTo=%2Fclub-profile";
const PICTURE_ACCEPT = CLUB_PROFILE_PICTURE_TYPES.join(",");

const fieldCopy: Readonly<Record<ClubProfileEditableField, { label: string; hint: string; placeholder: string }>> = {
  university: {
    label: "Üniversite",
    hint: "Öğrenim gördüğün üniversite.",
    placeholder: "Yıldız Teknik Üniversitesi",
  },
  faculty: {
    label: "Fakülte",
    hint: "Bağlı olduğun fakülte ya da enstitü.",
    placeholder: "Elektrik-Elektronik Fakültesi",
  },
  department: {
    label: "Bölüm",
    hint: "Kayıtlı olduğun bölüm.",
    placeholder: "Bilgisayar Mühendisliği",
  },
  linkedin: {
    label: "LinkedIn bağlantısı",
    hint: "https:// ile başlayan linkedin.com profil adresin. Boş bırakırsan bağlantı kaldırılır.",
    placeholder: "https://www.linkedin.com/in/kullanici-adin",
  },
};

const fieldIcons: Readonly<Record<ClubProfileEditableField, typeof GraduationCap>> = {
  university: GraduationCap,
  faculty: Landmark,
  department: BookOpen,
  linkedin: Link2,
};

const unavailableProblem: SafeProblem = {
  title: "Kulüp profiline şu anda ulaşılamıyor",
  detail: "Core hizmeti yanıt vermedi. Kulüp profilin değişmedi; kısa bir süre sonra yeniden deneyebilirsin.",
  status: 503,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown, maximum = 512): value is string | null {
  return value === null || (typeof value === "string" && value.length <= maximum);
}

function httpUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Fail-closed parser for the BFF profile payload: nothing unexpected reaches the DOM. */
export function parseClubProfileView(value: unknown): ClubProfileView | null {
  if (
    !isObject(value) ||
    !optionalText(value.skyNumber) ||
    typeof value.studentCardLinked !== "boolean" ||
    !optionalText(value.schoolEmail) ||
    !optionalText(value.phone) ||
    !optionalText(value.university) ||
    !optionalText(value.faculty) ||
    !optionalText(value.department) ||
    !optionalText(value.linkedin) ||
    (value.profilePictureUrl !== null && !httpUrl(value.profilePictureUrl)) ||
    !optionalText(value.updatedAt, 64)
  ) return null;
  return {
    skyNumber: value.skyNumber,
    studentCardLinked: value.studentCardLinked,
    schoolEmail: value.schoolEmail,
    phone: value.phone,
    university: value.university,
    faculty: value.faculty,
    department: value.department,
    linkedin: value.linkedin,
    profilePictureUrl: value.profilePictureUrl as string | null,
    updatedAt: value.updatedAt,
  };
}

function parseProblem(value: unknown, status: number, fallback: SafeProblem): SafeProblem {
  if (!isObject(value)) return { ...fallback, status };
  const field = typeof value.field === "string" && (CLUB_PROFILE_EDITABLE_FIELDS as readonly string[]).includes(value.field)
    ? value.field as ClubProfileEditableField
    : undefined;
  return {
    title: typeof value.title === "string" && value.title.length <= 160 ? value.title : fallback.title,
    detail: typeof value.detail === "string" && value.detail.length <= 512 ? value.detail : fallback.detail,
    status,
    ...(field ? { field } : {}),
  };
}

async function responseJson(response: Response) {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function formValuesOf(profile: ClubProfileView): FormValues {
  return {
    university: profile.university ?? "",
    faculty: profile.faculty ?? "",
    department: profile.department ?? "",
    linkedin: profile.linkedin ?? "",
  };
}

function dirtyFields(profile: ClubProfileView, values: FormValues) {
  const changes: Partial<FormValues> = {};
  for (const field of CLUB_PROFILE_EDITABLE_FIELDS) {
    const next = values[field].trim();
    if (next !== (profile[field] ?? "")) changes[field] = next;
  }
  return changes;
}

function localFieldError(field: ClubProfileEditableField, value: string): string | null {
  if (hasForbiddenCharacters(value)) {
    return `${fieldCopy[field].label} görünmez, biçimlendirme ya da kontrol karakteri içeremez.`;
  }
  const trimmed = value.trim();
  if (field === "linkedin") {
    if (trimmed.length > CLUB_PROFILE_LINKEDIN_MAX_LENGTH) return `LinkedIn bağlantısı en fazla ${CLUB_PROFILE_LINKEDIN_MAX_LENGTH} karakter olabilir.`;
    if (trimmed.length > 0 && !isLinkedinProfileUrl(trimmed)) {
      return "LinkedIn bağlantısı https:// ile başlamalı ve linkedin.com ya da www.linkedin.com adresinde olmalı.";
    }
    return null;
  }
  if (trimmed.length > CLUB_PROFILE_TEXT_MAX_LENGTH) return `${fieldCopy[field].label} en fazla ${CLUB_PROFILE_TEXT_MAX_LENGTH} karakter olabilir.`;
  return null;
}

function localPictureError(file: File): string | null {
  if (!isClubProfilePictureType(file.type)) return "Bu dosya türü desteklenmiyor. PNG, JPEG ya da WebP seç.";
  if (file.size === 0) return "Seçtiğin dosya boş görünüyor. Başka bir fotoğraf seç.";
  if (file.size > CLUB_PROFILE_PICTURE_MAX_BYTES) return "Fotoğraf 5 MB sınırını aşıyor. Daha küçük bir dosya seç.";
  return null;
}

function FeedbackBanner({ feedback, focusRef }: { feedback: Feedback; focusRef: React.RefObject<HTMLParagraphElement | null> }) {
  if (feedback.tone === "success") {
    return (
      <p ref={focusRef} className="form-feedback" data-tone="success" role="status" tabIndex={-1}>
        <ShieldCheck aria-hidden="true" size={17} />
        {feedback.message}
      </p>
    );
  }
  const { problem } = feedback;
  return (
    <div className="form-feedback" data-tone="danger" role="alert">
      <AlertCircle aria-hidden="true" size={17} />
      <span>
        <strong>{problem.title}</strong>
        {problem.detail}
        {problem.status === 401 ? <Link href={LOGIN_HREF}>Yeniden giriş yap</Link> : null}
      </span>
    </div>
  );
}

export function ClubProfileEditor({ initial, csrfToken }: { initial: ClubProfileView; csrfToken: string }) {
  const [profile, setProfile] = useState(initial);
  const [values, setValues] = useState<FormValues>(() => formValuesOf(initial));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ClubProfileEditableField, string>>>({});
  const [pending, setPending] = useState<Pending>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [selection, setSelection] = useState<{ file: File; previewUrl: string } | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const removeTrigger = useRef<HTMLButtonElement>(null);
  const successFeedback = useRef<HTMLParagraphElement>(null);
  const fieldRefs = useRef<Partial<Record<ClubProfileEditableField, HTMLInputElement | null>>>({});
  const focusAfterUpdate = useRef<FocusTarget | null>(null);
  const idPrefix = useId();
  const pictureHeadingId = `${idPrefix}-picture`;
  const formHeadingId = `${idPrefix}-form`;

  useEffect(() => () => {
    if (selection) URL.revokeObjectURL(selection.previewUrl);
  }, [selection]);

  useEffect(() => {
    const target = focusAfterUpdate.current;
    if (!target || pending || confirmRemoval) return;
    focusAfterUpdate.current = null;
    const element = target.kind === "feedback"
      ? successFeedback.current
      : target.kind === "remove-trigger"
        ? removeTrigger.current
        : fieldRefs.current[target.field];
    if (element?.isConnected) element.focus();
  }, [confirmRemoval, feedback, fieldErrors, pending]);

  const changes = dirtyFields(profile, values);
  const dirty = Object.keys(changes).length > 0;

  const applyProfile = useCallback((next: ClubProfileView) => {
    setProfile(next);
    setValues(formValuesOf(next));
    setFieldErrors({});
  }, []);

  const failWith = useCallback((response: Response, body: unknown, fallback: SafeProblem) => {
    const problem = parseProblem(body, response.status, fallback);
    if (problem.field) {
      setFieldErrors({ [problem.field]: problem.detail });
      setFeedback(null);
      focusAfterUpdate.current = { kind: "field", field: problem.field };
      return;
    }
    setFeedback({ tone: "danger", problem });
  }, []);

  const request = useCallback(async (
    input: string,
    init: RequestInit,
    fallback: SafeProblem,
  ): Promise<{ profile: ClubProfileView; changed: boolean } | null> => {
    let response: Response;
    try {
      response = await fetch(input, {
        ...init,
        cache: "no-store",
        credentials: "same-origin",
        headers: { ...(init.headers as Record<string, string> | undefined), "x-csrf-token": csrfToken },
      });
    } catch {
      setFeedback({ tone: "danger", problem: unavailableProblem });
      return null;
    }
    const body = await responseJson(response);
    if (!response.ok) {
      failWith(response, body, fallback);
      return null;
    }
    const parsed = isObject(body) ? parseClubProfileView(body.profile) : null;
    if (!parsed) {
      setFeedback({
        tone: "danger",
        problem: {
          title: "Kulüp profili güvenle durduruldu",
          detail: "Sunucu yanıtı desteklenen biçimle eşleşmedi. Sayfayı yenileyip güncel durumu kontrol et.",
          status: 502,
        },
      });
      return null;
    }
    return { profile: parsed, changed: !(isObject(body) && body.changed === false) };
  }, [csrfToken, failWith]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const errors: Partial<Record<ClubProfileEditableField, string>> = {};
    for (const field of CLUB_PROFILE_EDITABLE_FIELDS) {
      const error = localFieldError(field, values[field]);
      if (error) errors[field] = error;
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      const first = CLUB_PROFILE_EDITABLE_FIELDS.find((field) => errors[field]);
      if (first) fieldRefs.current[first]?.focus();
      return;
    }
    if (!dirty) {
      setFeedback({ tone: "success", message: "Kaydedilecek bir değişiklik yok." });
      return;
    }
    setPending("save");
    setFeedback(null);
    setFieldErrors({});
    try {
      const result = await request("/api/account/club-profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changes),
      }, {
        title: "Kulüp bilgilerin kaydedilemedi",
        detail: "Kulüp profilin değişmedi. Kısa bir süre sonra yeniden deneyebilirsin.",
        status: 500,
      });
      if (!result) return;
      applyProfile(result.profile);
      focusAfterUpdate.current = { kind: "feedback" };
      setFeedback({
        tone: "success",
        message: result.changed ? "Kulüp bilgilerin kaydedildi." : "Bilgilerin zaten güncel; kaydedilecek bir değişiklik yoktu.",
      });
    } finally {
      setPending(null);
    }
  };

  const resetForm = () => {
    setValues(formValuesOf(profile));
    setFieldErrors({});
  };

  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const error = localPictureError(file);
    if (error) {
      setSelection(null);
      setSelectionError(error);
      return;
    }
    setSelectionError(null);
    setSelection({ file, previewUrl: URL.createObjectURL(file) });
  };

  const clearSelection = () => {
    setSelection(null);
    setSelectionError(null);
  };

  const upload = async () => {
    if (!selection || pending) return;
    setPending("upload");
    setFeedback(null);
    try {
      const form = new FormData();
      form.set(CLUB_PROFILE_PICTURE_FIELD, selection.file, selection.file.name);
      const result = await request("/api/account/club-profile/picture", { method: "POST", body: form }, {
        title: "Fotoğraf yüklenemedi",
        detail: "Profil fotoğrafın değişmedi. Kısa bir süre sonra yeniden deneyebilirsin.",
        status: 500,
      });
      if (!result) return;
      setSelection(null);
      applyProfile(result.profile);
      focusAfterUpdate.current = { kind: "feedback" };
      setFeedback({ tone: "success", message: "Profil fotoğrafın güncellendi." });
    } finally {
      setPending(null);
    }
  };

  const remove = async () => {
    if (pending) return;
    setPending("remove");
    setFeedback(null);
    try {
      const result = await request("/api/account/club-profile/picture", { method: "DELETE" }, {
        title: "Fotoğraf kaldırılamadı",
        detail: "Profil fotoğrafın değişmedi. Kısa bir süre sonra yeniden deneyebilirsin.",
        status: 500,
      });
      setConfirmRemoval(false);
      if (!result) {
        focusAfterUpdate.current = { kind: "remove-trigger" };
        return;
      }
      applyProfile(result.profile);
      focusAfterUpdate.current = { kind: "feedback" };
      setFeedback({ tone: "success", message: "Profil fotoğrafın kaldırıldı." });
    } finally {
      setPending(null);
    }
  };

  const hasPicture = profile.profilePictureUrl !== null;
  const shownPicture = selection?.previewUrl ?? profile.profilePictureUrl;

  return (
    <>
      {feedback ? <FeedbackBanner feedback={feedback} focusRef={successFeedback} /> : null}

      <section className="settings-section" aria-labelledby={pictureHeadingId}>
        <div className="settings-section__heading">
          <h2 id={pictureHeadingId}>Profil fotoğrafı</h2>
          <p>PNG, JPEG ya da WebP; en fazla 5 MB. Kulüp uygulamalarında görünür, SkyPass kartında fotoğraf yer almaz.</p>
        </div>
        <div className="profile-picture-card" data-preview={selection ? "" : undefined}>
          <span className="profile-picture-card__avatar" data-empty={shownPicture ? undefined : ""}>
            {shownPicture ? (
              <Image
                alt={selection ? "Seçtiğin fotoğrafın önizlemesi" : "Mevcut profil fotoğrafın"}
                height={96}
                src={shownPicture}
                unoptimized
                width={96}
              />
            ) : (
              <CircleUserRound aria-hidden="true" size={34} strokeWidth={1.5} />
            )}
          </span>
          <span className="profile-picture-card__copy">
            <strong>
              {selection ? "Yeni fotoğraf seçildi" : hasPicture ? "Fotoğraf yüklü" : "Henüz fotoğraf yok"}
            </strong>
            <small>
              {selection
                ? `${selection.file.name} · ${Math.max(1, Math.round(selection.file.size / 1_024))} KB. Yüklemeden önce önizlemeyi kontrol et.`
                : hasPicture
                  ? "Yeni bir fotoğraf seçerek değiştirebilir ya da tamamen kaldırabilirsin."
                  : "Bir fotoğraf seçtiğinde önce burada önizlemesini görürsün."}
            </small>
            {selection ? <StatusBadge tone="warning">Önizleme, henüz yüklenmedi</StatusBadge> : null}
            {selectionError ? (
              <span className="field__error" role="alert">{selectionError}</span>
            ) : null}
          </span>
          <span className="profile-picture-card__actions">
            <input
              ref={fileInput}
              accept={PICTURE_ACCEPT}
              aria-label="Profil fotoğrafı dosyası"
              className="sr-only"
              disabled={pending !== null}
              onChange={selectFile}
              tabIndex={-1}
              type="file"
            />
            {selection ? (
              <>
                <button className="primary-button" type="button" disabled={pending !== null} onClick={() => void upload()}>
                  {pending === "upload" ? <ActionProgress label="Yükleniyor" /> : (
                    <><Upload aria-hidden="true" size={16} />Fotoğrafı yükle</>
                  )}
                </button>
                <button className="secondary-button" type="button" disabled={pending !== null} onClick={clearSelection}>
                  <X aria-hidden="true" size={16} />
                  Vazgeç
                </button>
              </>
            ) : (
              <>
                <button
                  className="secondary-button secondary-button--accent"
                  type="button"
                  disabled={pending !== null}
                  onClick={() => fileInput.current?.click()}
                >
                  <Camera aria-hidden="true" size={16} />
                  {hasPicture ? "Fotoğrafı değiştir" : "Fotoğraf seç"}
                </button>
                {hasPicture ? (
                  <button
                    ref={removeTrigger}
                    className="quiet-danger-button"
                    type="button"
                    disabled={pending !== null}
                    onClick={() => setConfirmRemoval(true)}
                  >
                    <Trash2 aria-hidden="true" size={16} />
                    Fotoğrafı kaldır
                  </button>
                ) : null}
              </>
            )}
          </span>
        </div>
      </section>

      <section className="settings-section" aria-labelledby={formHeadingId}>
        <div className="settings-section__heading">
          <h2 id={formHeadingId}>Kulüp bilgileri</h2>
          <p>Üniversite, fakülte, bölüm ve LinkedIn bağlantın kulüp kayıtlarında ve takım listelerinde kullanılır.</p>
        </div>
        <form className="profile-form" noValidate onSubmit={(event) => void submit(event)}>
          {CLUB_PROFILE_EDITABLE_FIELDS.map((field) => {
            const Icon = fieldIcons[field];
            const inputId = `${idPrefix}-${field}`;
            const hintId = `${inputId}-hint`;
            const errorId = `${inputId}-error`;
            const error = fieldErrors[field];
            return (
              <div className="field" key={field} data-invalid={error ? "" : undefined}>
                <label htmlFor={inputId}>
                  <Icon aria-hidden="true" size={16} />
                  {fieldCopy[field].label}
                </label>
                <input
                  ref={(element) => { fieldRefs.current[field] = element; }}
                  id={inputId}
                  aria-describedby={error ? `${errorId} ${hintId}` : hintId}
                  aria-invalid={error ? true : undefined}
                  autoComplete={field === "linkedin" ? "url" : "off"}
                  disabled={pending !== null}
                  inputMode={field === "linkedin" ? "url" : "text"}
                  maxLength={field === "linkedin" ? CLUB_PROFILE_LINKEDIN_MAX_LENGTH : CLUB_PROFILE_TEXT_MAX_LENGTH}
                  name={field}
                  onChange={(event) => {
                    const next = event.target.value;
                    setValues((previous) => ({ ...previous, [field]: next }));
                    if (error) setFieldErrors((previous) => ({ ...previous, [field]: undefined }));
                  }}
                  placeholder={fieldCopy[field].placeholder}
                  spellCheck={false}
                  type={field === "linkedin" ? "url" : "text"}
                  value={values[field]}
                />
                {error ? <span className="field__error" id={errorId} role="alert">{error}</span> : null}
                <span className="field__hint" id={hintId}>{fieldCopy[field].hint}</span>
              </div>
            );
          })}
          <div className="form-actions">
            {dirty && pending === null ? (
              <button className="secondary-button" type="button" onClick={resetForm}>
                <X aria-hidden="true" size={16} />
                Değişiklikleri geri al
              </button>
            ) : null}
            <button
              className="primary-button"
              type="submit"
              aria-disabled={!dirty || pending !== null}
              disabled={pending !== null}
            >
              {pending === "save" ? <ActionProgress label="Kaydediliyor" /> : (
                <><Save aria-hidden="true" size={16} />Kaydet</>
              )}
            </button>
          </div>
        </form>
      </section>

      {confirmRemoval ? (
        <ConfirmationDialog
          title="Profil fotoğrafını kaldır"
          description="Fotoğrafın kulüp uygulamalarından kaldırılacak. İstediğin zaman yeni bir fotoğraf yükleyebilirsin."
          confirmLabel="Fotoğrafı kaldır"
          pendingLabel="Kaldırılıyor"
          icon={<Trash2 size={22} />}
          pending={pending === "remove"}
          onCancel={() => {
            setConfirmRemoval(false);
            focusAfterUpdate.current = { kind: "remove-trigger" };
          }}
          onConfirm={() => void remove()}
        />
      ) : null}
    </>
  );
}
