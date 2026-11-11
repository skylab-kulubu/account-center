"use client";

import { ConfirmDialog } from "@skylab-kulubu/skylcn-ui";
import { SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { appPreferenceLabel } from "@/lib/app-preferences";
import type { AppPreferenceSummary } from "@/lib/app-preferences";

const ROUTE = "/api/account/app-preferences";
const RETURN_TO = "/login?returnTo=%2Fapp-preferences";

const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Istanbul",
});

type Target = { kind: "one"; app: string } | { kind: "all" };
type Feedback = { tone: "success" | "danger"; message: string; login?: boolean } | null;

/** A refused reset, so the dialog stays open and says why. */
class ResetFailure extends Error {
  constructor(message: string, readonly login = false) {
    super(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function problemTitle(response: Response) {
  try {
    const body = await response.json() as unknown;
    if (isObject(body) && typeof body.title === "string" && body.title.length <= 160) return body.title;
  } catch {
    // fall through
  }
  return "Ayarlar sıfırlanamadı. Biraz sonra yeniden dene.";
}

async function resetOne(app: string, csrfToken: string) {
  let response: Response;
  try {
    response = await fetch(`${ROUTE}/${encodeURIComponent(app)}`, {
      method: "DELETE",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "x-csrf-token": csrfToken },
    });
  } catch {
    throw new ResetFailure("Bağlantı kurulamadı. İnternet bağlantını kontrol edip yeniden dene.");
  }
  if (response.status !== 204) throw new ResetFailure(await problemTitle(response), response.status === 401);
}

function failureText(error: unknown) {
  return error instanceof ResetFailure ? error.message : "Ayarlar sıfırlanamadı. Biraz sonra yeniden dene.";
}

/**
 * The apps that keep view settings for the person: name, key count, last
 * change and a reset. Values are never shown; Account Center never has them.
 */
export function AppPreferencesList({ initial, csrfToken }: { initial: AppPreferenceSummary[]; csrfToken: string }) {
  const [items, setItems] = useState(initial);
  const [target, setTarget] = useState<Target | null>(null);
  /** The last question asked: its words stay on the dialog while it animates out. */
  const [shown, setShown] = useState<Target | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const feedbackRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (feedback && !target) feedbackRef.current?.focus();
  }, [feedback, target]);

  const open = (next: Target) => {
    setFeedback(null);
    setShown(next);
    setTarget(next);
  };

  const reset = async () => {
    if (!target) return;
    const apps = target.kind === "all" ? items.map(({ app }) => app) : [target.app];
    for (const app of apps) {
      try {
        await resetOne(app, csrfToken);
      } catch (error) {
        if (error instanceof ResetFailure && error.login) {
          setTarget(null);
          setFeedback({ tone: "danger", message: error.message, login: true });
          return;
        }
        throw error;
      }
      // Each app that answered is gone, even when a later one fails.
      setItems((current) => current.filter((item) => item.app !== app));
    }
    setFeedback({
      tone: "success",
      message: target.kind === "all" ? "Bütün uygulama ayarları sıfırlandı." : `${appPreferenceLabel(target.app)} ayarları sıfırlandı.`,
    });
  };

  const question = shown?.kind === "one"
    ? `${appPreferenceLabel(shown.app)} ayarları varsayılana dönsün mü?`
    : "Bütün uygulama ayarları varsayılana dönsün mü?";

  return (
    <section className="settings-section" aria-labelledby="app-preferences-heading">
      <div className="settings-section__heading">
        <h2 id="app-preferences-heading">Kayıtlı ayarlar</h2>
      </div>
      {feedback ? (
        <p
          ref={feedbackRef}
          className="student-card-feedback"
          data-tone={feedback.tone}
          role={feedback.tone === "danger" ? "alert" : "status"}
          tabIndex={-1}
        >
          {feedback.message}
          {feedback.login ? <> <Link href={RETURN_TO}>Yeniden giriş yap</Link></> : null}
        </p>
      ) : null}
      <div className="settings-group">
        {items.length === 0 ? (
          <div className="settings-row">
            <span className="settings-row__copy"><small>Kayıtlı ayar yok.</small></span>
          </div>
        ) : items.map((item) => (
          <div className="settings-row" data-has-trailing="" key={item.app}>
            <span className="settings-row__icon"><SlidersHorizontal aria-hidden="true" size={19} /></span>
            <span className="settings-row__copy">
              <strong>{appPreferenceLabel(item.app)}</strong>
              <small>
                {item.keys} ayar · Son değişiklik{" "}
                <time dateTime={item.updatedAt}>{dateFormatter.format(new Date(item.updatedAt))}</time>
              </small>
            </span>
            <div className="settings-row__trailing">
              <button
                className="security-action"
                data-tone="danger"
                type="button"
                aria-label={`${appPreferenceLabel(item.app)} ayarlarını sıfırla`}
                onClick={() => open({ kind: "one", app: item.app })}
              >
                Sıfırla
              </button>
            </div>
          </div>
        ))}
        {items.length > 1 ? (
          <div className="settings-row" data-has-trailing="">
            <span className="settings-row__copy"><small>Bütün uygulamalar varsayılan görünüme döner.</small></span>
            <div className="settings-row__trailing">
              <button className="security-action" data-tone="danger" type="button" onClick={() => open({ kind: "all" })}>
                Tümünü sıfırla
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(next) => { if (!next) setTarget(null); }}
        title={question}
        actionLabel={shown?.kind === "all" ? "Tümünü sıfırla" : "Sıfırla"}
        stallMessage="Sunucu yanıt vermedi. İstek iptal edilmedi; sonucu sayfayı yenileyince görürsün."
        destructive
        onAction={reset}
        failureMessage={failureText}
        onLateFailure={(error) => setFeedback({ tone: "danger", message: failureText(error) })}
      />
    </section>
  );
}
