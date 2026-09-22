"use client";

import { AlertCircle, Fingerprint, KeyRound, LockKeyhole, ShieldCheck, Smartphone, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { ActionProgress } from "@/components/ui-states";
import {
  serializeAssertion,
  toPublicKeyRequestOptions,
  webauthnSupported,
} from "@/lib/webauthn";
import type { AssertionOptionsJson } from "@/lib/webauthn";

export type SudoMethod = "password" | "passkey" | "totp";
export type SudoProofMethod = SudoMethod | "reauth";

/** What the dialog reports when the server accepted a proof. */
export type SudoVerification = {
  method: SudoProofMethod;
  expiresAt: string;
};

type MethodsPayload = {
  methods: SudoMethod[];
  fallback: "microsoft" | null;
  active: { method: SudoProofMethod; expiresAt: string } | null;
  csrfToken: string;
};

type Feedback = {
  tone: "danger" | "warning";
  detail: string;
  /** Seconds the person must wait before another attempt (lockout or rate limit). */
  retryAfter?: number;
};

const methodOrder: SudoMethod[] = ["password", "passkey", "totp"];
const tabLabels: Record<SudoMethod, string> = {
  password: "Parola",
  passkey: "Passkey",
  totp: "Doğrulama kodu",
};

const copy = {
  loading: "Doğrulama yöntemlerin yükleniyor",
  methodsUnavailable: "Doğrulama yöntemlerin alınamadı. Kısa bir süre sonra yeniden dene.",
  network: "Bağlantı kurulamadı. Kısa bir süre sonra yeniden dene.",
  unexpected: "Doğrulama tamamlanamadı. Yeniden dene.",
  csrfRenewed: "Oturum bilgin yenilendi. Lütfen yeniden dene.",
  passkeyUnsupported: "Bu tarayıcı passkey doğrulamasını desteklemiyor. Başka bir yöntem seç.",
  passkeyCancelled: "Passkey doğrulaması tamamlanmadı ya da zaman aşımına uğradı. Yeniden dene.",
  passkeyFailed: "Passkey doğrulaması yapılamadı. Yeniden dene.",
  locked: "Hesabın geçici olarak kilitlendi.",
  disabled: "Hesabın devre dışı. Yönetim ekibiyle iletişime geç.",
  tooMany: "Çok fazla deneme yaptın.",
  waitPrefix: "Yeniden denemek için bekle:",
  fallbackLead: "Hesabında parola, passkey ya da doğrulama uygulaması tanımlı değil.",
  fallbackDetail: "Kimliğini YTÜ Microsoft hesabınla yeniden doğrulayabilirsin. Doğrulama sonrası bu sayfaya dönersin ve 5 dakika boyunca hassas işlemleri yapabilirsin.",
} as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMethod(value: unknown): value is SudoMethod {
  return typeof value === "string" && (methodOrder as string[]).includes(value);
}

function validIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function parseMethods(value: unknown): MethodsPayload | null {
  if (
    !isObject(value) ||
    !Array.isArray(value.methods) ||
    !value.methods.every(isMethod) ||
    new Set(value.methods).size !== value.methods.length ||
    (value.fallback !== null && value.fallback !== "microsoft") ||
    typeof value.csrfToken !== "string" ||
    value.csrfToken.length < 1 ||
    value.csrfToken.length > 128
  ) return null;
  let active: MethodsPayload["active"] = null;
  if (value.active !== null) {
    if (
      !isObject(value.active) ||
      !(isMethod(value.active.method) || value.active.method === "reauth") ||
      !validIsoDate(value.active.expiresAt)
    ) return null;
    active = { method: value.active.method as SudoProofMethod, expiresAt: value.active.expiresAt };
  }
  const methods = methodOrder.filter((method) => (value.methods as SudoMethod[]).includes(method));
  return { methods, fallback: value.fallback, active, csrfToken: value.csrfToken };
}

function parseVerification(value: unknown, method: SudoMethod): SudoVerification | null {
  if (!isObject(value) || value.method !== method || !validIsoDate(value.expiresAt)) return null;
  return { method, expiresAt: value.expiresAt };
}

function parseAssertionOptions(value: unknown): AssertionOptionsJson | null {
  if (
    !isObject(value) ||
    typeof value.challenge !== "string" ||
    typeof value.rpId !== "string" ||
    !Array.isArray(value.allowCredentials) ||
    !["required", "preferred", "discouraged"].includes(String(value.userVerification)) ||
    (value.timeout !== undefined && typeof value.timeout !== "number")
  ) return null;
  const allowCredentials: AssertionOptionsJson["allowCredentials"] = [];
  for (const credential of value.allowCredentials) {
    if (
      !isObject(credential) ||
      credential.type !== "public-key" ||
      typeof credential.id !== "string" ||
      (credential.transports !== undefined &&
        (!Array.isArray(credential.transports) || !credential.transports.every((item) => typeof item === "string")))
    ) return null;
    allowCredentials.push({
      type: "public-key",
      id: credential.id,
      ...(credential.transports ? { transports: credential.transports as string[] } : {}),
    });
  }
  return {
    challenge: value.challenge,
    rpId: value.rpId,
    allowCredentials,
    userVerification: value.userVerification as AssertionOptionsJson["userVerification"],
    ...(typeof value.timeout === "number" ? { timeout: value.timeout } : {}),
  };
}

function detailOf(body: unknown, fallback: string) {
  return isObject(body) && typeof body.detail === "string" && body.detail.length > 0 && body.detail.length <= 512
    ? body.detail
    : fallback;
}

function retryAfterOf(body: unknown, response: Response) {
  if (isObject(body) && typeof body.retryAfter === "number" && Number.isFinite(body.retryAfter) && body.retryAfter > 0) {
    return Math.min(Math.ceil(body.retryAfter), 24 * 60 * 60);
  }
  const header = response.headers.get("retry-after");
  return header && /^\d{1,6}$/.test(header) ? Number(header) : undefined;
}

async function responseJson(response: Response) {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function loginPath(returnTo: string) {
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function formatWait(seconds: number) {
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} dakika`;
  }
  return `${seconds} saniye`;
}

function trapFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ),
  );
  const first = controls.at(0);
  const last = controls.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  } else if (!event.currentTarget.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

type SudoDialogProps = {
  /** Same-origin path to return to after the Microsoft fallback; the server allowlists it. */
  returnTo: string;
  onVerified: (verification: SudoVerification) => void;
  onDismiss: () => void;
  title?: string;
  description?: string;
};

/**
 * Sudo mode step-up: the person proves it is them with their password, a
 * passkey or a verification code before a sensitive action. Only the methods
 * the person actually has appear as tabs; with none, the dialog offers the
 * Microsoft re-authentication. Secrets are posted once and never kept.
 */
export function SudoDialog({
  returnTo,
  onVerified,
  onDismiss,
  title = "Kimliğini doğrula",
  description = "Bu işlem için kim olduğunu yeniden kanıtlaman gerekiyor. Doğrulaman 5 dakika boyunca geçerli olur.",
}: SudoDialogProps) {
  const router = useRouter();
  const baseId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [methods, setMethods] = useState<MethodsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<SudoMethod | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const loadStarted = useRef(false);
  const verified = useRef(false);
  /** The first panel focuses its control; after a tab switch focus stays on the tab list. */
  const [autoFocusPanel, setAutoFocusPanel] = useState(true);

  const finish = useCallback((verification: SudoVerification) => {
    if (verified.current) return;
    verified.current = true;
    setPassword("");
    setCode("");
    onVerified(verification);
  }, [onVerified]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/account/sudo/methods", { cache: "no-store", credentials: "same-origin" });
      const body = await responseJson(response);
      if (response.status === 401) {
        router.replace(loginPath(returnTo));
        return;
      }
      if (!response.ok) {
        setLoadError(detailOf(body, copy.methodsUnavailable));
        return;
      }
      const parsed = parseMethods(body);
      if (!parsed) {
        setLoadError(copy.methodsUnavailable);
        return;
      }
      if (parsed.active && Date.parse(parsed.active.expiresAt) - Date.now() > 15_000) {
        finish({ method: parsed.active.method, expiresAt: parsed.active.expiresAt });
        return;
      }
      setMethods(parsed);
      setTab((current) => (current && parsed.methods.includes(current) ? current : parsed.methods[0] ?? null));
    } catch {
      setLoadError(copy.network);
    } finally {
      setLoading(false);
    }
  }, [finish, returnTo, router]);

  useEffect(() => {
    if (loadStarted.current) return;
    loadStarted.current = true;
    void load();
  }, [load]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
    return () => {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      else dialog.removeAttribute("open");
    };
  }, []);

  useEffect(() => {
    if (waitSeconds <= 0) return;
    const timer = window.setTimeout(() => setWaitSeconds((current) => Math.max(0, current - 1)), 1_000);
    return () => window.clearTimeout(timer);
  }, [waitSeconds]);

  const fail = useCallback((next: Feedback) => {
    setFeedback(next);
    if (next.retryAfter) setWaitSeconds(next.retryAfter);
  }, []);

  /** Shared handling of a proof answer: finishes on success, otherwise explains the rejection. */
  const handleProofResponse = useCallback(async (response: Response, method: SudoMethod) => {
    const body = await responseJson(response);
    if (response.ok) {
      const verification = parseVerification(body, method);
      if (!verification) {
        fail({ tone: "danger", detail: copy.unexpected });
        return;
      }
      finish(verification);
      return;
    }
    const error = isObject(body) && typeof body.error === "string" ? body.error : "";
    if (response.status === 401 && error === "authentication_required") {
      router.replace(loginPath(returnTo));
      return;
    }
    if (response.status === 403) {
      if (error === "disabled") {
        // The account is disabled; no proof can succeed and the methods have not changed.
        fail({ tone: "danger", detail: detailOf(body, copy.disabled) });
        return;
      }
      fail({ tone: "warning", detail: copy.csrfRenewed });
      await load();
      return;
    }
    if (response.status === 423) {
      fail({ tone: "danger", detail: detailOf(body, copy.locked), retryAfter: retryAfterOf(body, response) });
      return;
    }
    if (response.status === 429) {
      fail({ tone: "warning", detail: detailOf(body, copy.tooMany), retryAfter: retryAfterOf(body, response) });
      return;
    }
    if (response.status === 400 && error === "method_unavailable") {
      fail({ tone: "warning", detail: detailOf(body, copy.unexpected) });
      await load();
      return;
    }
    fail({ tone: response.status === 401 ? "danger" : "warning", detail: detailOf(body, copy.unexpected) });
  }, [fail, finish, load, returnTo, router]);

  const post = useCallback((path: string, csrfToken: string, body?: unknown) => fetch(path, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      "x-csrf-token": csrfToken,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), []);

  const submitSecret = async (event: FormEvent<HTMLFormElement>, method: "password" | "totp") => {
    event.preventDefault();
    if (!methods || pending || waitSeconds > 0) return;
    const payload = method === "password"
      ? { password }
      : { code: code.replace(/\s+/g, "") };
    if ((method === "password" && payload.password === "") || (method === "totp" && !/^\d{4,10}$/.test(String(payload.code)))) {
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      const response = await post(`/api/account/sudo/${method}`, methods.csrfToken, payload);
      setPassword("");
      setCode("");
      await handleProofResponse(response, method);
    } catch {
      fail({ tone: "warning", detail: copy.network });
    } finally {
      setPending(false);
    }
  };

  const runPasskey = async () => {
    if (!methods || pending || waitSeconds > 0) return;
    if (!webauthnSupported()) {
      fail({ tone: "warning", detail: copy.passkeyUnsupported });
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      const optionsResponse = await post("/api/account/sudo/webauthn/options", methods.csrfToken);
      if (!optionsResponse.ok) {
        await handleProofResponse(optionsResponse, "passkey");
        return;
      }
      const options = parseAssertionOptions(await responseJson(optionsResponse));
      if (!options) {
        fail({ tone: "danger", detail: copy.passkeyFailed });
        return;
      }
      let credential: Credential | null;
      try {
        credential = await navigator.credentials.get({ publicKey: toPublicKeyRequestOptions(options) });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        fail({
          tone: "warning",
          detail: name === "NotAllowedError" || name === "AbortError" ? copy.passkeyCancelled : copy.passkeyFailed,
        });
        return;
      }
      if (!credential || !(credential instanceof PublicKeyCredential)) {
        fail({ tone: "warning", detail: copy.passkeyCancelled });
        return;
      }
      const assertion = serializeAssertion(credential);
      const response = await post("/api/account/sudo/webauthn/verify", methods.csrfToken, { assertion });
      await handleProofResponse(response, "passkey");
    } catch {
      fail({ tone: "warning", detail: copy.network });
    } finally {
      setPending(false);
    }
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!methods || methods.methods.length < 2 || !tab) return;
    const index = methods.methods.indexOf(tab);
    let next: SudoMethod | undefined;
    if (event.key === "ArrowRight") next = methods.methods[(index + 1) % methods.methods.length];
    else if (event.key === "ArrowLeft") next = methods.methods[(index - 1 + methods.methods.length) % methods.methods.length];
    else if (event.key === "Home") next = methods.methods[0];
    else if (event.key === "End") next = methods.methods.at(-1);
    if (!next) return;
    event.preventDefault();
    setAutoFocusPanel(false);
    setTab(next);
    setFeedback(null);
    document.getElementById(`${baseId}-tab-${next}`)?.focus();
  };

  const busy = pending || waitSeconds > 0;
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;

  return (
    <dialog
      ref={dialogRef}
      className="confirmation-dialog sudo-dialog"
      aria-busy={pending}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={trapFocus}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onDismiss();
      }}
    >
      <button
        className="confirmation-dialog__close"
        type="button"
        aria-label="Pencereyi kapat"
        disabled={pending}
        onClick={onDismiss}
      >
        <X aria-hidden="true" size={18} />
      </button>
      <span className="confirmation-dialog__icon sudo-dialog__icon" aria-hidden="true">
        <LockKeyhole size={22} />
      </span>
      <h2 id={titleId}>{title}</h2>
      <p id={descriptionId}>{description}</p>

      {loading ? (
        <div className="sudo-dialog__state">
          <ActionProgress label={copy.loading} />
        </div>
      ) : loadError ? (
        <div className="sudo-dialog__state">
          <p className="sudo-dialog__feedback" data-tone="danger" role="alert">
            <AlertCircle aria-hidden="true" size={16} />
            <span>{loadError}</span>
          </p>
          <button className="secondary-button sudo-dialog__retry" type="button" onClick={() => void load()}>
            Yeniden dene
          </button>
        </div>
      ) : methods && methods.methods.length === 0 ? (
        <div className="sudo-dialog__fallback">
          <p><strong>{copy.fallbackLead}</strong></p>
          <p>{copy.fallbackDetail}</p>
          <form action="/api/account/sudo/reauthenticate" method="post">
            <input type="hidden" name="csrfToken" value={methods.csrfToken} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <button className="primary-button" type="submit">
              <ShieldCheck aria-hidden="true" size={16} />
              Microsoft ile yeniden doğrula
            </button>
          </form>
        </div>
      ) : methods && tab ? (
        <>
          <div className="sudo-tabs" role="tablist" aria-label="Doğrulama yöntemi">
            {methods.methods.map((method) => {
              const selected = method === tab;
              const Icon = method === "password" ? KeyRound : method === "passkey" ? Fingerprint : Smartphone;
              return (
                <button
                  key={method}
                  className="sudo-tab"
                  type="button"
                  role="tab"
                  id={`${baseId}-tab-${method}`}
                  aria-selected={selected}
                  aria-controls={`${baseId}-panel-${method}`}
                  tabIndex={selected ? 0 : -1}
                  disabled={pending}
                  onClick={() => {
                    setAutoFocusPanel(false);
                    setTab(method);
                    setFeedback(null);
                  }}
                  onKeyDown={onTabKeyDown}
                >
                  <Icon aria-hidden="true" size={15} />
                  {tabLabels[method]}
                </button>
              );
            })}
          </div>
          {feedback ? (
            <p className="sudo-dialog__feedback" data-tone={feedback.tone} role="alert">
              <AlertCircle aria-hidden="true" size={16} />
              <span>
                {feedback.detail}
                {waitSeconds > 0 ? ` ${copy.waitPrefix} ${formatWait(waitSeconds)}.` : null}
              </span>
            </p>
          ) : null}
          <div
            className="sudo-panel"
            role="tabpanel"
            id={`${baseId}-panel-${tab}`}
            aria-labelledby={`${baseId}-tab-${tab}`}
          >
            {tab === "password" ? (
              <form className="sudo-form" onSubmit={(event) => void submitSecret(event, "password")}>
                <div className="sudo-field">
                  <label htmlFor={`${baseId}-password`}>Parola</label>
                  <input
                    key="password"
                    id={`${baseId}-password`}
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    autoFocus={autoFocusPanel}
                    required
                    maxLength={1_024}
                    disabled={busy}
                    value={password}
                    onChange={(event) => setPassword(event.currentTarget.value)}
                  />
                </div>
                <button className="primary-button" type="submit" disabled={busy || password.length === 0}>
                  {pending ? <ActionProgress label="Doğrulanıyor" /> : "Doğrula"}
                </button>
              </form>
            ) : tab === "totp" ? (
              <form className="sudo-form" onSubmit={(event) => void submitSecret(event, "totp")}>
                <div className="sudo-field">
                  <label htmlFor={`${baseId}-code`}>Doğrulama kodu</label>
                  <small id={`${baseId}-code-hint`}>Doğrulama uygulamandaki güncel kodu gir.</small>
                  <input
                    key="code"
                    id={`${baseId}-code`}
                    name="code"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9 ]*"
                    autoComplete="one-time-code"
                    aria-describedby={`${baseId}-code-hint`}
                    autoFocus={autoFocusPanel}
                    required
                    maxLength={12}
                    disabled={busy}
                    value={code}
                    onChange={(event) => setCode(event.currentTarget.value)}
                  />
                </div>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={busy || !/^\d{4,10}$/.test(code.replace(/\s+/g, ""))}
                >
                  {pending ? <ActionProgress label="Doğrulanıyor" /> : "Doğrula"}
                </button>
              </form>
            ) : (
              <div className="sudo-form">
                <p className="sudo-panel__hint">
                  Passkey&rsquo;inle doğrulamak için cihazının kilidini (parmak izi, yüz tanıma ya da cihaz şifresi) kullan.
                </p>
                <button className="primary-button" type="button" autoFocus={autoFocusPanel} disabled={busy} onClick={() => void runPasskey()}>
                  {pending ? <ActionProgress label="Passkey bekleniyor" /> : (
                    <><Fingerprint aria-hidden="true" size={16} />Passkey ile doğrula</>
                  )}
                </button>
              </div>
            )}
          </div>
        </>
      ) : null}
    </dialog>
  );
}
