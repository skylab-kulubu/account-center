"use client";

import { AlertCircle, ShieldCheck, Smartphone, WalletCards, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { StatusBadge } from "@/components/settings";
import { useSudo } from "@/components/sudo-provider";
import { ActionProgress } from "@/components/ui-states";
import { GOOGLE_WALLET_BUTTON_SRC, isGoogleWalletSaveUrl } from "@/lib/skypass-wallet";

type SafeProblem = { title: string; detail: string; status: number };

type Feedback =
  | { tone: "success"; message: string }
  | { tone: "danger"; problem: SafeProblem };

type Pending = "verify" | "link" | "revoke" | null;

type Platform = "unknown" | "apple-mobile" | "other";

const LINK_ROUTE = "/api/account/skypass/wallet/google";
const LOGIN_HREF = "/login?returnTo=%2Fclub-profile";
/** A proof with less life than this is renewed first: core may take up to 20 s to write the pass. */
const SUDO_LINK_MARGIN_MS = 60_000;

const networkProblem: SafeProblem = {
  title: "Bağlantı kurulamadı",
  detail: "İsteğin sunucuya ulaşmadı. İnternet bağlantını kontrol edip yeniden dene.",
  status: 0,
};

const linkFallback: SafeProblem = {
  title: "Google Cüzdan bağlantısı alınamadı",
  detail: "Kısa bir süre sonra yeniden deneyebilirsin.",
  status: 500,
};

const revokeFallback: SafeProblem = {
  title: "Pas kaldırılamadı",
  detail: "Kısa bir süre sonra yeniden deneyebilirsin.",
  status: 500,
};

const contractProblem: SafeProblem = {
  title: "Google Cüzdan işlemi güvenle durduruldu",
  detail: "Sunucu yanıtı beklenen biçimde değildi; hiçbir bağlantı açılmadı. Sayfayı yenileyip yeniden dene.",
  status: 502,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseJson(response: Response) {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

/** Only bounded `title`/`detail` text and the retry hint reach the DOM; anything else falls back. */
function parseProblem(value: unknown, status: number, fallback: SafeProblem): SafeProblem & { code?: string } {
  if (!isObject(value)) return { ...fallback, status };
  const seconds = typeof value.retryAfterSeconds === "number" && Number.isSafeInteger(value.retryAfterSeconds) &&
    value.retryAfterSeconds > 0 && value.retryAfterSeconds <= 3_600
    ? value.retryAfterSeconds
    : null;
  const detail = typeof value.detail === "string" && value.detail.length <= 512 ? value.detail : fallback.detail;
  return {
    title: typeof value.title === "string" && value.title.length <= 160 ? value.title : fallback.title,
    detail: seconds === null ? detail : `${detail} Yaklaşık ${seconds} saniye sonra yeniden deneyebilirsin.`,
    status,
    ...(typeof value.code === "string" && value.code.length <= 64 ? { code: value.code } : {}),
  };
}

/**
 * Google Wallet has no iPhone or iPad app, so the button is not offered
 * there. iPadOS asks for desktop sites as a Mac by default; a real Mac has
 * no touch screen, so a "Macintosh" with touch points is an iPad. Decided in
 * the browser only: the server never sees `maxTouchPoints`.
 */
export function isAppleMobile(userAgent: string, maxTouchPoints: number) {
  if (/\b(?:iPhone|iPad|iPod)\b/.test(userAgent)) return true;
  return /\bMacintosh\b/.test(userAgent) && maxTouchPoints > 1;
}

const subscribeToNothing = () => () => {};

function usePlatform(): Platform {
  return useSyncExternalStore(
    subscribeToNothing,
    () => (isAppleMobile(navigator.userAgent, navigator.maxTouchPoints ?? 0) ? "apple-mobile" : "other"),
    () => "unknown",
  );
}

/**
 * Opens an empty tab synchronously inside the click, so the browser counts
 * it as a user gesture even though the link arrives after a request. The
 * tab gets no opener; it is pointed at the save link with `replace` (no
 * blank entry in its history) once the link is here, or closed on failure.
 * `null` when the browser refused a new tab.
 */
function openPendingTab(): Window | null {
  let tab: Window | null = null;
  try {
    tab = window.open("", "_blank");
  } catch {
    return null;
  }
  if (!tab) return null;
  try {
    tab.opener = null;
    tab.document.title = "Google Cüzdan";
    tab.document.body.textContent = "Google Cüzdan bağlantısı hazırlanıyor…";
  } catch {
    // The empty tab is ours (about:blank); if a browser walls it off, the navigation below still works.
  }
  return tab;
}

function FeedbackBanner({ feedback }: { feedback: Feedback }) {
  if (feedback.tone === "success") {
    return (
      <p className="form-feedback" data-tone="success" role="status">
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

/**
 * SkyPass in Google Wallet (core `docs/skypass-google-wallet.md`). Rendered
 * only while core says Google Wallet is on. The save link has no expiry and
 * whoever saves it first owns the pass, so it lives in a local variable for
 * the one navigation it is fetched for: it is never put in state, the DOM,
 * storage, a log, a query string or an error message.
 *
 * Asking for the link needs Sudo mode. Without a fresh proof the click only
 * opens the Sudo dialog and asks for a second press, so the tab is always
 * opened by a click of its own (popup blockers allow it) rather than after a
 * dialog of unknown length. Ending the pass needs no Sudo mode.
 */
export function SkyPassWalletCard({ initialIssued, csrfToken }: { initialIssued: boolean; csrfToken: string }) {
  const [issued, setIssued] = useState(initialIssued);
  const [off, setOff] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const { ensureSudo, invalidateSudo, sudoExpiresAt } = useSudo();
  const platform = usePlatform();
  const revokeTrigger = useRef<HTMLButtonElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<"revoke" | "add" | null>(null);
  const headingId = useId();

  useEffect(() => {
    if (pending || confirmRevoke || !restoreFocus.current) return;
    const target = restoreFocus.current === "revoke" ? revokeTrigger.current : addButton.current;
    restoreFocus.current = null;
    if (target?.isConnected) target.focus();
  }, [confirmRevoke, issued, pending]);

  async function send(method: "POST" | "DELETE") {
    return fetch(LINK_ROUTE, {
      method,
      cache: "no-store",
      credentials: "same-origin",
      headers: { "x-csrf-token": csrfToken },
    });
  }

  function fail(problem: SafeProblem & { code?: string }) {
    if (problem.code === "skypass_google_wallet_off") setOff(true);
    setFeedback({ tone: "danger", problem });
  }

  async function verifyFirst(challenged: boolean) {
    setPending("verify");
    try {
      if (await ensureSudo(challenged ? { challenged: true } : undefined)) {
        restoreFocus.current = "add";
        setFeedback({
          tone: "success",
          message: "Kimliğin doğrulandı. Pası eklemek için “Google Cüzdan’a ekle” düğmesine yeniden bas.",
        });
      }
    } finally {
      setPending(null);
    }
  }

  const add = () => {
    if (pending) return;
    setFeedback(null);
    if (!sudoExpiresAt || sudoExpiresAt.getTime() - Date.now() < SUDO_LINK_MARGIN_MS) {
      void verifyFirst(false);
      return;
    }
    const tab = openPendingTab();
    setPending("link");
    void (async () => {
      try {
        let response: Response;
        try {
          response = await send("POST");
        } catch {
          tab?.close();
          fail(networkProblem);
          return;
        }
        if (response.status === 428) {
          // The server has the last word on the proof's life: verify, then ask for a fresh click.
          tab?.close();
          invalidateSudo();
          await verifyFirst(true);
          return;
        }
        const body = await responseJson(response);
        if (!response.ok) {
          tab?.close();
          fail(parseProblem(body, response.status, linkFallback));
          return;
        }
        const saveUrl = isObject(body) ? body.saveUrl : undefined;
        if (!isGoogleWalletSaveUrl(saveUrl)) {
          tab?.close();
          fail(contractProblem);
          return;
        }
        setIssued(true);
        if (tab && !tab.closed) {
          tab.location.replace(saveUrl);
          setFeedback({
            tone: "success",
            message: "Google Cüzdan yeni sekmede açıldı. Pası orada kaydet; kapıda telefonundaki kodu göstermen yeterli.",
          });
        } else {
          // No new tab was allowed: this tab goes to Google instead.
          window.location.assign(saveUrl);
        }
      } finally {
        setPending(null);
      }
    })();
  };

  const revoke = async () => {
    if (pending) return;
    setPending("revoke");
    setFeedback(null);
    try {
      let response: Response;
      try {
        response = await send("DELETE");
      } catch {
        restoreFocus.current = "revoke";
        fail(networkProblem);
        return;
      }
      if (response.status !== 204) {
        restoreFocus.current = "revoke";
        fail(parseProblem(await responseJson(response), response.status, revokeFallback));
        return;
      }
      setIssued(false);
      restoreFocus.current = "add";
      setFeedback({
        tone: "success",
        message: "Pas kaldırıldı. Telefonundaki kopyanın kodları artık kapıyı açmaz; istersen yeniden ekleyebilirsin.",
      });
    } finally {
      setConfirmRevoke(false);
      setPending(null);
    }
  };

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <div className="settings-section__heading">
        <h2 id={headingId}>Google Cüzdan</h2>
        <p>
          SkyPass’ini Google Cüzdan’a ekleyerek sky-app olmadan da kapıdan geçebilirsin. Kartta adın ve SKY numaran
          görünür, fotoğraf yer almaz; kapı kodu her dakika yenilenir ve kapıda internet bağlantısı gerekir.
        </p>
      </div>
      {feedback ? <FeedbackBanner feedback={feedback} /> : null}
      <div className="wallet-card">
        <span className="wallet-card__summary">
          <span className="settings-row__icon" aria-hidden="true">
            <WalletCards size={19} />
          </span>
          <span className="settings-row__copy">
            <strong>SkyPass</strong>
            <small>
              {off
                ? "Google Cüzdan şu anda kapalı; daha sonra yeniden dene."
                : issued
                  ? "Pasın etkin. Yeni bir telefona eklemek ya da kartı güncellemek için yeniden ekleyebilirsin."
                  : "Henüz Google Cüzdan’a eklenmedi."}
            </small>
          </span>
          <StatusBadge tone={issued ? "positive" : "neutral"}>{issued ? "Pas etkin" : "Pas yok"}</StatusBadge>
        </span>
        {off ? null : (
          <span className="wallet-card__actions">
            {platform === "other" ? (
              <button
                ref={addButton}
                className="google-wallet-button"
                type="button"
                disabled={pending !== null}
                aria-busy={pending === "link" || pending === "verify"}
                onClick={add}
              >
                {/* Google's own button artwork, unaltered (brand guidelines); next/image would re-encode it. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt="Google Cüzdan’a ekle" src={GOOGLE_WALLET_BUTTON_SRC} />
              </button>
            ) : null}
            {platform === "apple-mobile" ? (
              <span className="wallet-card__platform-note">
                Google Cüzdan iPhone’da yok; Apple Cüzdan desteği daha sonra gelecek.
              </span>
            ) : null}
            {pending === "link" ? <ActionProgress label="Bağlantı hazırlanıyor" /> : null}
            {issued ? (
              <button
                ref={revokeTrigger}
                className="quiet-danger-button"
                type="button"
                disabled={pending !== null}
                onClick={() => setConfirmRevoke(true)}
              >
                <XCircle aria-hidden="true" size={16} />
                Cüzdandan kaldır
              </button>
            ) : null}
          </span>
        )}
        <small className="wallet-card__note">
          <Smartphone aria-hidden="true" size={14} />
          Telefonunu kaybettiysen ya da değiştirdiysen pası kaldır: eski telefondaki kodlar hemen geçersiz olur.
        </small>
      </div>
      {confirmRevoke ? (
        <ConfirmationDialog
          title="Pas Google Cüzdan’dan kaldırılsın mı?"
          description="Telefonundaki SkyPass’in kodları hemen kapıyı açmaz olur ve kart Google Cüzdan’da süresi dolmuşlara taşınır. Yeniden eklediğinde yeni bir pas oluşturulur."
          confirmLabel="Pası kaldır"
          pendingLabel="Kaldırılıyor"
          icon={<XCircle size={22} />}
          pending={pending === "revoke"}
          onCancel={() => {
            restoreFocus.current = "revoke";
            setConfirmRevoke(false);
          }}
          onConfirm={() => void revoke()}
        />
      ) : null}
    </section>
  );
}
