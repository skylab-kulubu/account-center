"use client";

import { GraduationCap, Plus, Star } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { FeedbackAlert, loginPath } from "@/components/security-shared";
import { ActionProgress } from "@/components/ui-states";
import { isPrimaryEmailNudge, primaryEmailNudgeIntentPath } from "@/lib/primary-email-nudge";
import type { PrimaryEmailNudge } from "@/lib/primary-email-nudge";
import { isObject, responseJson, securityRequest } from "@/lib/security-client";

/**
 * K4c, in the words of CONTEXT.md: the Primary e-mail is the School e-mail,
 * "Şifremi unuttum" mails only the Primary e-mail, and a graduate's school
 * mailbox may close. The nudge points into the e-mail page's own flows (the
 * Primary e-mail choice, adding a Personal e-mail); both still ask for Sudo
 * mode there exactly as before.
 */
export const primaryEmailNudgeCopy = {
  title: "Mezun olunca okul postan kapanabilir",
  makePersonalPrimary: {
    detail: (address: string) =>
      `Parolanı unutursan sıfırlama bağlantısı birincil adresine, yani okul e-postana gider. Doğruladığın kişisel adresini (${address}) birincil yaparsan okul postan kapandığında da hesabına ulaşabilirsin.`,
    action: "Kişisel adresi birincil yap",
  },
  addPersonal: {
    detail: "Parolanı unutursan sıfırlama bağlantısı birincil adresine, yani okul e-postana gider. Kişisel bir adres ekleyip doğrularsan onu birincil yapabilir, okul postan kapandığında da hesabına ulaşabilirsin.",
    action: "Kişisel adres ekle",
  },
  dismiss: "Bir daha gösterme",
  dismissing: "Kaydediliyor",
  dismissed: "Bu öneriyi bir daha göstermeyeceğiz. Birincil adresini istediğin zaman E-posta ve giriş sayfasından değiştirebilirsin.",
  dismissFailed: "Öneri kapatılamadı. Biraz sonra yeniden dene.",
} as const;

/** The `primaryEmailNudge` member of `GET /api/account/email`; missing (an older BFF) or unknown (a newer one) is no nudge. */
export function parsePrimaryEmailNudge(value: unknown): PrimaryEmailNudge | null {
  return isPrimaryEmailNudge(value) ? value : null;
}

type CardProps = {
  nudge: PrimaryEmailNudge;
  /** The proven Personal e-mail named by `make-personal-primary`. */
  personalEmail: string | null;
  csrfToken: string;
  /** Runs the nudge's flow in the current page (the e-mail page); without it the action links there. */
  onAct?: (nudge: PrimaryEmailNudge, element: HTMLElement) => void;
  /** Another flow of the page is open. */
  disabled?: boolean;
  onAuthenticationRequired: () => void;
};

/**
 * The nudge: what can go wrong, the one action that prevents it, and "Bir
 * daha gösterme", which is stored server-side for the person (every device).
 * After a dismissal a short status takes its place and the focus, so neither
 * the focus nor a screen reader is left on a removed button.
 */
export function PrimaryEmailNudgeCard({ nudge, personalEmail, csrfToken, onAct, disabled = false, onAuthenticationRequired }: CardProps) {
  const titleId = useId();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (dismissed) statusRef.current?.focus();
  }, [dismissed]);

  if (dismissed) {
    return (
      <p ref={statusRef} className="email-nudge-dismissed" role="status" tabIndex={-1}>
        {primaryEmailNudgeCopy.dismissed}
      </p>
    );
  }

  const dismiss = async () => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      const response = await securityRequest({
        method: "POST",
        path: "/api/account/email/nudge/dismiss",
        csrfToken,
        body: { nudge },
      });
      if (response.status === 401) {
        onAuthenticationRequired();
        return;
      }
      if (!response.ok) {
        setFailed(true);
        return;
      }
      setDismissed(true);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  const copy = nudge === "make-personal-primary" ? primaryEmailNudgeCopy.makePersonalPrimary : primaryEmailNudgeCopy.addPersonal;
  const detail = nudge === "make-personal-primary"
    ? primaryEmailNudgeCopy.makePersonalPrimary.detail(personalEmail ?? "")
    : primaryEmailNudgeCopy.addPersonal.detail;
  const icon = nudge === "make-personal-primary" ? <Star aria-hidden="true" size={16} /> : <Plus aria-hidden="true" size={16} />;

  return (
    <section className="email-nudge" aria-labelledby={titleId}>
      <span className="email-nudge__icon" aria-hidden="true">
        <GraduationCap size={19} />
      </span>
      <div className="email-nudge__body">
        <h2 id={titleId}>{primaryEmailNudgeCopy.title}</h2>
        <p>{detail}</p>
        <FeedbackAlert feedback={failed ? { tone: "warning", detail: primaryEmailNudgeCopy.dismissFailed } : null} />
        <div className="email-nudge__actions">
          {onAct ? (
            <button
              className="primary-button"
              type="button"
              disabled={disabled || pending}
              onClick={(event) => onAct(nudge, event.currentTarget)}
            >
              {icon}
              {copy.action}
            </button>
          ) : (
            <Link className="primary-button" href={primaryEmailNudgeIntentPath(nudge)}>
              {icon}
              {copy.action}
            </Link>
          )}
          <button className="secondary-button" type="button" disabled={disabled || pending} onClick={() => void dismiss()}>
            {pending ? <ActionProgress label={primaryEmailNudgeCopy.dismissing} /> : primaryEmailNudgeCopy.dismiss}
          </button>
        </div>
      </div>
    </section>
  );
}

type HomeNudge = { nudge: PrimaryEmailNudge; personalEmail: string | null; csrfToken: string };

/** `GET /api/account/email/nudge`; anything outside it is no nudge. */
function parseHomeNudge(value: unknown): HomeNudge | null {
  if (!isObject(value)) return null;
  const nudge = parsePrimaryEmailNudge(value.primaryEmailNudge);
  if (
    nudge === null ||
    typeof value.csrfToken !== "string" ||
    value.csrfToken.length < 1 ||
    value.csrfToken.length > 128 ||
    !(value.personalEmail === null || (typeof value.personalEmail === "string" && value.personalEmail.length > 0 && value.personalEmail.length <= 320)) ||
    (nudge === "make-personal-primary") !== (value.personalEmail !== null)
  ) return null;
  return { nudge, personalEmail: value.personalEmail, csrfToken: value.csrfToken };
}

/**
 * The overview's copy of the nudge, read after the page is shown from
 * `GET /api/account/email/nudge`, which answers `200` with no nudge for any
 * failure behind the session; anything but a clean answer shows nothing.
 */
export function HomePrimaryEmailNudge() {
  const router = useRouter();
  const [state, setState] = useState<HomeNudge | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/account/email/nudge", { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) return;
        const parsed = parseHomeNudge(await responseJson(response));
        if (active) setState(parsed);
      } catch {
        // No nudge; the page works without it.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (!state) return null;
  return (
    <PrimaryEmailNudgeCard
      nudge={state.nudge}
      personalEmail={state.personalEmail}
      csrfToken={state.csrfToken}
      onAuthenticationRequired={() => router.replace(loginPath("/"))}
    />
  );
}
