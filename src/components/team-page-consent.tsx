"use client";

import { Button, Notice, ToggleRow } from "@skylab-kulubu/skylcn-ui";
import Link from "next/link";
import { useId, useState } from "react";
import { PRIVACY_NOTICE_URL } from "@/lib/communication-preferences";
import { CONSENT_TEXT_URL } from "@/lib/promotional-consent";
import { isTeamPageConsentState, TEAM_PAGE_TEXT, TEAM_PAGE_TITLE } from "@/lib/team-page-consent";
import type { TeamPageConsentState } from "@/lib/team-page-consent";
import { isObject, responseJson, securityRequest } from "@/lib/security-client";

const ROUTE = "/api/account/team-page-consent";

type Problem = { title: string; detail: string; status: number };

const networkProblem: Problem = {
  title: "Bağlantı kurulamadı",
  detail: "İsteğin sunucuya ulaşmadı; ayarın değişmedi. Yeniden dene.",
  status: 0,
};

const fallbackProblem: Problem = {
  title: "Ayar kaydedilemedi",
  detail: "Ayarın değişmedi. Biraz sonra yeniden dene.",
  status: 500,
};

const contractProblem: Problem = {
  title: "Ekip sayfası ayarı güvenle durduruldu",
  detail: "Sunucu yanıtı beklenen biçimde değildi. Sayfayı yenileyip yeniden dene.",
  status: 502,
};

/** Only bounded `title`/`detail` text reaches the DOM; anything else falls back. */
function parseProblem(value: unknown, status: number): Problem {
  if (!isObject(value)) return { ...fallbackProblem, status };
  return {
    title: typeof value.title === "string" && value.title.length <= 160 ? value.title : fallbackProblem.title,
    detail: typeof value.detail === "string" && value.detail.length <= 512 ? value.detail : fallbackProblem.detail,
    status,
  };
}

type Feedback = { tone: "success"; message: string } | { tone: "danger"; problem: Problem };

type SectionProps = {
  /** `null` when the BFF could not read the consent: the section says so and offers no switch. */
  initial: TeamPageConsentState | null;
  csrfToken: string;
  /** Where a fresh login comes back to. */
  returnTo: string;
};

/**
 * The "Ekip sayfaları" switch: core's `ekip-sayfasi-v1` text as its label,
 * off unless the person's own consent is active. Turning it on records the
 * grant; turning it off withdraws it, and core hides the person from the
 * public team pages at once (a Board member keeps their name on the Board's
 * own page).
 */
export function TeamPageConsentSection({ initial, csrfToken, returnTo }: SectionProps) {
  const headingId = useId();
  const [state, setState] = useState(initial);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function change(checked: boolean) {
    if (pending) return;
    setPending(true);
    setFeedback(null);
    try {
      let response: Response;
      try {
        response = await securityRequest({ method: checked ? "POST" : "DELETE", path: ROUTE, csrfToken });
      } catch {
        setFeedback({ tone: "danger", problem: networkProblem });
        return;
      }
      const body = await responseJson(response);
      if (!response.ok) {
        setFeedback({ tone: "danger", problem: parseProblem(body, response.status) });
        return;
      }
      const next = isObject(body) && isTeamPageConsentState(body.teamPage) ? body.teamPage : null;
      if (next === null || (next === "active") !== checked) {
        setFeedback({ tone: "danger", problem: contractProblem });
        return;
      }
      setState(next);
      setFeedback({ tone: "success", message: checked ? "Ekip sayfası izni açıldı." : "Ekip sayfası izni kapatıldı." });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <div className="settings-section__heading">
        <h2 id={headingId}>{TEAM_PAGE_TITLE}</h2>
        <p>
          <a href={CONSENT_TEXT_URL} rel="noopener noreferrer" target="_blank">Açık Rıza Metni</a>
          {" · "}
          <a href={PRIVACY_NOTICE_URL} rel="noopener noreferrer" target="_blank">KVKK aydınlatma metni</a>
        </p>
      </div>
      <div aria-atomic="true" role="status">
        {feedback?.tone === "success" ? <Notice role={undefined} tone="success">{feedback.message}</Notice> : null}
      </div>
      {feedback?.tone === "danger" ? (
        <Notice
          action={feedback.problem.status === 401 ? (
            <Button render={<Link href={`/login?returnTo=${encodeURIComponent(returnTo)}`} />} size="sm" variant="link">
              Yeniden giriş yap
            </Button>
          ) : undefined}
          title={feedback.problem.title}
          tone="danger"
        >
          {feedback.problem.detail}
        </Notice>
      ) : null}
      {state === null ? (
        <Notice tone="warning">Ekip sayfası ayarı okunamadı. Sayfayı yenileyip yeniden dene.</Notice>
      ) : (
        <ToggleRow
          aria-label={TEAM_PAGE_TEXT}
          checked={state === "active"}
          disabled={pending}
          onCheckedChange={(checked) => void change(checked)}
          title={TEAM_PAGE_TEXT}
        />
      )}
    </section>
  );
}
