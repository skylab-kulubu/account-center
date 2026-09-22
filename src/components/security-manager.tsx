"use client";

import {
  AlertTriangle,
  Fingerprint,
  KeyRound,
  Plus,
  ShieldCheck,
  Smartphone,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ModalDialog } from "@/components/modal-dialog";
import { PasskeyAddDialog } from "@/components/security-passkey-dialog";
import { PasswordForm } from "@/components/security-password-form";
import {
  FeedbackAlert,
  feedbackFor,
  formattedCreatedAt,
  loginPath,
  parseSecurityPayload,
  sharedCopy,
  useWaitSeconds,
} from "@/components/security-shared";
import type { Feedback, SecurityCredentialRow, SecurityPayload } from "@/components/security-shared";
import { TotpSetupWizard } from "@/components/security-totp-wizard";
import { SettingsGroup, StatusBadge } from "@/components/settings";
import { useSudo } from "@/components/sudo-provider";
import { ActionProgress, RetryableError } from "@/components/ui-states";
import { responseJson, runWithSudo, securityRequest } from "@/lib/security-client";
import { webauthnCreateSupported } from "@/lib/webauthn";

const RETURN_TO = "/security";

export const securityCopy = {
  loading: "Güvenlik ayarların yükleniyor",
  loadFailed: { title: "Güvenlik ayarları yüklenemedi", detail: "Kimlik hizmetine şu anda ulaşılamıyor. Kısa bir süre sonra yeniden deneyebilirsin." },
  contract: { title: "Güvenlik ayarları güvenle durduruldu", detail: "Kimlik hizmetinin yanıtı desteklenen biçimle eşleşmedi. Hiçbir ham veri gösterilmedi." },
  password: {
    title: "Parola",
    has: "Parolan tanımlı. Değiştirmeden önce kimliğini yeniden doğrularsın.",
    none: "Hesabında parola yok. Bir parola belirlersen kullanıcı adın ya da e-posta adresinle de giriş yapabilirsin.",
    change: "Parolayı değiştir",
    set: "Parola belirle",
  },
  totp: {
    title: "Doğrulama uygulaması",
    description: "Telefonundaki bir doğrulama uygulamasından alınan tek kullanımlık kodlar girişini ve hassas işlemleri korur.",
    empty: "Tanımlı bir doğrulama uygulaması yok.",
    add: "Doğrulama uygulaması ekle",
    kind: "Doğrulama uygulaması",
  },
  passkeys: {
    title: "Passkey’ler",
    description: "Parmak izi, yüz tanıma ya da cihaz kilidiyle parolasız giriş yap. Passkey’ler yildizskylab.com için kaydedilir ve her SKY LAB girişinde geçerlidir.",
    empty: "Kayıtlı bir passkey yok.",
    add: "Passkey ekle",
    unsupported: "Bu tarayıcı passkey eklemeyi desteklemiyor. Güncel bir tarayıcı ya da SKY LAB uygulaması kullan.",
    legacy: "Eski tür güvenlik anahtarı; giriş ve doğrulamada kullanılmaz, yalnız kaldırılabilir.",
    kind: "Passkey",
  },
  remove: {
    button: "Kaldır",
    title: (kind: string) => `${kind} kaldırılsın mı?`,
    body: (label: string) => `“${label}” kaldırılacak. Bu yöntemle artık giriş yapamaz ya da kimliğini doğrulayamazsın.`,
    lastPasskey: "Bu, hesabındaki son passkey. Parolan olmadığı için kaldırdıktan sonra SKY LAB’e yalnız YTÜ Microsoft hesabınla girebilirsin.",
    confirm: "Kaldır",
    removed: (kind: string) => `${kind} kaldırıldı.`,
    notFound: "Kimlik bilgisi bulunamadı; liste yenilendi.",
  },
  hint: "Bu sayfadaki hiçbir işlem seni Keycloak’a ya da başka bir siteye göndermez; her adım my.yildizskylab.com içinde tamamlanır ve Sudo modu ister.",
} as const;

const transportLabels: Record<string, string> = {
  internal: "Bu cihaz",
  hybrid: "Telefon / QR",
  usb: "USB",
  nfc: "NFC",
  ble: "Bluetooth",
  "smart-card": "Akıllı kart",
};

type Flow =
  | { kind: "password" }
  | { kind: "totp" }
  | { kind: "passkey" }
  | { kind: "remove"; section: "totp" | "passkeys"; credential: SecurityCredentialRow };

type Notice = { tone: "positive" | "warning"; title: string; detail: string };

function credentialName(row: SecurityCredentialRow, fallback: string) {
  return row.label?.trim() || fallback;
}

function transportsDescription(row: SecurityCredentialRow) {
  const names = (row.transports ?? []).map((transport) => transportLabels[transport] ?? transport);
  return names.length > 0 ? names.join(" · ") : null;
}

function CredentialRow({
  row,
  icon,
  fallbackLabel,
  pending,
  onRemove,
}: {
  row: SecurityCredentialRow;
  icon: React.ReactNode;
  fallbackLabel: string;
  pending: boolean;
  onRemove: (row: SecurityCredentialRow, trigger: HTMLButtonElement) => void;
}) {
  const name = credentialName(row, fallbackLabel);
  const transports = transportsDescription(row);
  return (
    <div className="settings-row security-credential" data-has-trailing="" data-legacy={row.legacy ? "" : undefined}>
      <span className="settings-row__icon">{icon}</span>
      <span className="settings-row__copy">
        <strong>{name}</strong>
        <small>
          {row.legacy ? securityCopy.passkeys.legacy : formattedCreatedAt(row.createdAt)}
          {transports ? ` · ${transports}` : null}
        </small>
      </span>
      <div className="settings-row__trailing">
        <button
          className="quiet-danger-button"
          type="button"
          aria-label={`${name} — ${securityCopy.remove.button}`}
          disabled={pending}
          onClick={(event) => onRemove(row, event.currentTarget)}
        >
          <Trash2 aria-hidden="true" size={15} />
          {securityCopy.remove.button}
        </button>
      </div>
    </div>
  );
}

function RemoveDialog({
  flow,
  payload,
  pending,
  feedback,
  waitSeconds,
  onCancel,
  onConfirm,
}: {
  flow: Extract<Flow, { kind: "remove" }>;
  payload: SecurityPayload;
  pending: boolean;
  feedback: Feedback | null;
  waitSeconds: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const baseId = useId();
  const kind = flow.section === "totp" ? securityCopy.totp.kind : securityCopy.passkeys.kind;
  const name = credentialName(flow.credential, kind);
  const lastPasskeyWithoutPassword = flow.section === "passkeys" &&
    !flow.credential.legacy &&
    !payload.password &&
    payload.passkeys.filter((row) => !row.legacy).length === 1;
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
      <h2 id={titleId}>{securityCopy.remove.title(kind)}</h2>
      <p id={descriptionId}>{securityCopy.remove.body(name)}</p>
      {lastPasskeyWithoutPassword ? (
        <p className="security-feedback" data-tone="warning" role="note">
          <AlertTriangle aria-hidden="true" size={16} />
          <span>{securityCopy.remove.lastPasskey}</span>
        </p>
      ) : null}
      <FeedbackAlert feedback={feedback} waitSeconds={waitSeconds} />
      <div className="confirmation-dialog__actions">
        <button className="secondary-button" type="button" disabled={pending} onClick={onCancel}>
          Vazgeç
        </button>
        <button
          className="danger-button danger-button--inline"
          type="button"
          disabled={pending || waitSeconds > 0}
          onClick={onConfirm}
        >
          {pending ? <ActionProgress label="Kaldırılıyor" /> : (
            <><Trash2 aria-hidden="true" size={16} />{securityCopy.remove.confirm}</>
          )}
        </button>
      </div>
    </ModalDialog>
  );
}

/**
 * The security page: password, verification app and passkeys, all changed
 * in place through `/api/account/security/*` behind Sudo mode. The list is
 * always re-read from the server after a change; the server's inventory,
 * not the answer of a mutation, is what the page shows.
 */
export function SecurityManager() {
  const router = useRouter();
  const { ensureSudo, invalidateSudo } = useSudo();
  const [payload, setPayload] = useState<SecurityPayload | null>(null);
  const [problem, setProblem] = useState<{ title: string; detail: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [removePending, setRemovePending] = useState(false);
  const [removeFeedback, setRemoveFeedback] = useState<Feedback | null>(null);
  const removeWait = useWaitSeconds(removeFeedback);
  const firstLoadStarted = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const focusNotice = useRef(false);

  const onAuthenticationRequired = useCallback(() => {
    router.replace(loginPath(RETURN_TO));
  }, [router]);

  const load = useCallback(async (preserve = false) => {
    if (!preserve) setLoading(true);
    setProblem(null);
    try {
      const response = await fetch("/api/account/security", { cache: "no-store", credentials: "same-origin" });
      const body = await responseJson(response);
      if (response.status === 401) {
        onAuthenticationRequired();
        return;
      }
      if (!response.ok) {
        setProblem({
          title: securityCopy.loadFailed.title,
          detail: typeof (body as { detail?: unknown } | null)?.detail === "string"
            ? String((body as { detail: string }).detail)
            : securityCopy.loadFailed.detail,
        });
        return;
      }
      const parsed = parseSecurityPayload(body);
      if (!parsed) {
        setProblem(securityCopy.contract);
        return;
      }
      setPayload(parsed);
    } catch {
      setProblem(securityCopy.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [onAuthenticationRequired]);

  useEffect(() => {
    if (firstLoadStarted.current) return;
    firstLoadStarted.current = true;
    void load();
  }, [load]);

  useEffect(() => {
    if (!focusNotice.current || !notice) return;
    focusNotice.current = false;
    noticeRef.current?.focus();
  }, [notice]);

  const openFlow = useCallback(async (next: Flow, element: HTMLElement) => {
    trigger.current = element;
    setNotice(null);
    if (next.kind === "password" || next.kind === "totp") {
      // Sudo mode comes first so the form only appears for a person who just proved it is them.
      const verified = await ensureSudo();
      if (!verified) return;
    }
    setFlow(next);
  }, [ensureSudo]);

  const closeFlow = useCallback(() => {
    setFlow(null);
    setRemoveFeedback(null);
    const element = trigger.current;
    trigger.current = null;
    queueMicrotask(() => {
      if (element?.isConnected) element.focus();
    });
  }, []);

  const finishFlow = useCallback(async (message: string) => {
    setFlow(null);
    setRemoveFeedback(null);
    focusNotice.current = true;
    setNotice({ tone: "positive", title: "İşlem tamamlandı", detail: message });
    trigger.current = null;
    await load(true);
  }, [load]);

  const remove = async () => {
    if (!flow || flow.kind !== "remove" || !payload || removePending) return;
    const { credential, section } = flow;
    setRemovePending(true);
    setRemoveFeedback(null);
    try {
      const outcome = await runWithSudo(
        () => securityRequest({
          method: "DELETE",
          path: `/api/account/security/credentials/${encodeURIComponent(credential.reference)}`,
          csrfToken: payload.csrfToken,
        }),
        ensureSudo,
      );
      if (outcome.kind === "ok") {
        await finishFlow(securityCopy.remove.removed(section === "totp" ? securityCopy.totp.kind : securityCopy.passkeys.kind));
        return;
      }
      const next = feedbackFor(outcome, (error, detail) => {
        if (error === "credential_not_found") return { tone: "warning", detail: detail || securityCopy.remove.notFound };
        return null;
      }, onAuthenticationRequired);
      if (next === "reload-csrf") {
        setRemoveFeedback({ tone: "warning", detail: sharedCopy.csrfRenewed });
        await load(true);
        return;
      }
      setRemoveFeedback(next);
      if (outcome.kind === "error" && outcome.status === 404) await load(true);
    } catch {
      setRemoveFeedback({ tone: "warning", detail: sharedCopy.network });
    } finally {
      setRemovePending(false);
    }
  };

  if (loading && !payload) {
    return (
      <section className="state-card session-state" aria-label={securityCopy.loading}>
        <ActionProgress label={securityCopy.loading} />
      </section>
    );
  }

  if (problem || !payload) {
    return (
      <RetryableError
        detail={problem?.detail ?? securityCopy.loadFailed.detail}
        onRetry={() => void load()}
        pending={loading}
        title={problem?.title ?? securityCopy.loadFailed.title}
      />
    );
  }

  const busy = flow !== null;
  // Rendered only after the browser fetched the inventory, so the probe never disagrees with server markup.
  const createSupported = webauthnCreateSupported();
  const passkeys = payload.passkeys.filter((row) => !row.legacy);
  const totpLabels = payload.totp.map((row) => row.label ?? "").filter(Boolean);
  const passkeyLabels = payload.passkeys.map((row) => row.label ?? "").filter(Boolean);
  const csrfRenewed = async () => {
    invalidateSudo();
    await load(true);
  };

  return (
    <>
      {notice ? (
        <div
          ref={noticeRef}
          className="action-notice security-notice"
          data-tone={notice.tone}
          role="status"
          tabIndex={-1}
        >
          <strong>{notice.title}</strong>
          <span>{notice.detail}</span>
        </div>
      ) : null}

      <SettingsGroup title={securityCopy.password.title}>
        <div className="settings-row" data-has-trailing="">
          <span className="settings-row__icon"><KeyRound aria-hidden="true" size={19} /></span>
          <span className="settings-row__copy">
            <strong>{securityCopy.password.title}</strong>
            <small>{payload.password ? securityCopy.password.has : securityCopy.password.none}</small>
          </span>
          <div className="settings-row__trailing security-row-actions">
            <StatusBadge tone={payload.password ? "positive" : "warning"}>
              {payload.password ? "Tanımlı" : "Tanımlı değil"}
            </StatusBadge>
            <button
              className="security-action"
              type="button"
              disabled={busy}
              onClick={(event) => void openFlow({ kind: "password" }, event.currentTarget)}
            >
              {payload.password ? securityCopy.password.change : securityCopy.password.set}
            </button>
          </div>
        </div>
        {flow?.kind === "password" ? (
          <PasswordForm
            csrfToken={payload.csrfToken}
            hasPassword={payload.password}
            ensureSudo={ensureSudo}
            onDone={(message) => void finishFlow(message)}
            onCancel={closeFlow}
            onCsrfRenewed={csrfRenewed}
            onAuthenticationRequired={onAuthenticationRequired}
          />
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={securityCopy.totp.title} description={securityCopy.totp.description}>
        {payload.totp.length === 0 ? (
          <div className="settings-row security-empty">
            <span className="settings-row__icon"><Smartphone aria-hidden="true" size={19} /></span>
            <span className="settings-row__copy">
              <strong>{securityCopy.totp.empty}</strong>
              <small>Kod üreten bir uygulama ekleyerek hesabını ikinci bir adımla koru.</small>
            </span>
          </div>
        ) : payload.totp.map((row) => (
          <CredentialRow
            key={row.reference}
            row={row}
            icon={<Smartphone aria-hidden="true" size={19} />}
            fallbackLabel={securityCopy.totp.kind}
            pending={busy}
            onRemove={(credential, element) => void openFlow({ kind: "remove", section: "totp", credential }, element)}
          />
        ))}
        <div className="security-group-actions">
          <button
            className="security-action"
            type="button"
            disabled={busy}
            onClick={(event) => void openFlow({ kind: "totp" }, event.currentTarget)}
          >
            <Plus aria-hidden="true" size={15} />
            {securityCopy.totp.add}
          </button>
        </div>
        {flow?.kind === "totp" ? (
          <TotpSetupWizard
            csrfToken={payload.csrfToken}
            ensureSudo={ensureSudo}
            existingLabels={totpLabels}
            onDone={(message) => void finishFlow(message)}
            onCancel={closeFlow}
            onCsrfRenewed={csrfRenewed}
            onAuthenticationRequired={onAuthenticationRequired}
          />
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={securityCopy.passkeys.title} description={securityCopy.passkeys.description}>
        {payload.passkeys.length === 0 ? (
          <div className="settings-row security-empty">
            <span className="settings-row__icon"><Fingerprint aria-hidden="true" size={19} /></span>
            <span className="settings-row__copy">
              <strong>{securityCopy.passkeys.empty}</strong>
              <small>Bir passkey eklersen parolasız ve kimlik avına dayanıklı giriş yaparsın.</small>
            </span>
          </div>
        ) : payload.passkeys.map((row) => (
          <CredentialRow
            key={row.reference}
            row={row}
            icon={<Fingerprint aria-hidden="true" size={19} />}
            fallbackLabel={securityCopy.passkeys.kind}
            pending={busy}
            onRemove={(credential, element) => void openFlow({ kind: "remove", section: "passkeys", credential }, element)}
          />
        ))}
        <div className="security-group-actions">
          <button
            className="security-action"
            type="button"
            disabled={busy || !createSupported}
            aria-describedby={!createSupported ? "passkey-unsupported" : undefined}
            onClick={(event) => void openFlow({ kind: "passkey" }, event.currentTarget)}
          >
            <Plus aria-hidden="true" size={15} />
            {securityCopy.passkeys.add}
          </button>
          {!createSupported ? (
            <small id="passkey-unsupported" className="security-group-actions__hint">{securityCopy.passkeys.unsupported}</small>
          ) : null}
        </div>
      </SettingsGroup>

      <aside className="security-note">
        <ShieldCheck aria-hidden="true" size={19} />
        <span>
          <strong>
            {passkeys.length === 0 && payload.totp.length === 0
              ? "Hesabına ek bir giriş yöntemi eklemeni öneriyoruz."
              : "Kimlik bilgilerin tarayıcıya kaydedilmez."}
          </strong>
          <small>{securityCopy.hint}</small>
        </span>
      </aside>

      {flow?.kind === "passkey" ? (
        <PasskeyAddDialog
          csrfToken={payload.csrfToken}
          ensureSudo={ensureSudo}
          existingLabels={passkeyLabels}
          onDone={(message) => void finishFlow(message)}
          onDismiss={closeFlow}
          onCsrfRenewed={csrfRenewed}
          onAuthenticationRequired={onAuthenticationRequired}
        />
      ) : null}
      {flow?.kind === "remove" ? (
        <RemoveDialog
          flow={flow}
          payload={payload}
          pending={removePending}
          feedback={removeFeedback}
          waitSeconds={removeWait}
          onCancel={closeFlow}
          onConfirm={() => void remove()}
        />
      ) : null}
    </>
  );
}
