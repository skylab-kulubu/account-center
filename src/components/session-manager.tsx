"use client";

import {
  AlertCircle,
  Laptop,
  LogOut,
  MonitorSmartphone,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { Button, ConfirmDialog } from "@skylab-kulubu/skylcn-ui";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { framedStateCard } from "@/components/framed-state";
import { StatusBadge } from "@/components/settings";
import { ActionProgress, EmptyState, RetryableError } from "@/components/ui-states";
import type { ManagedAccountSession } from "@/server/keycloak-account/types";

type SessionsPayload = {
  sessions: ManagedAccountSession[];
  csrfToken: string;
};

type SafeProblem = {
  title: string;
  detail: string;
};

type Confirmation =
  | { kind: "one"; reference: string; deviceName: string }
  | { kind: "all" };

const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Istanbul",
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown) {
  return value === null || (typeof value === "string" && value.length <= 512);
}

function validIsoDate(value: unknown) {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function validSession(value: unknown): value is ManagedAccountSession {
  if (!isObject(value)) return false;
  if (
    !validIsoDate(value.startedAt) ||
    !validIsoDate(value.lastAccessAt) ||
    !validIsoDate(value.expiresAt) ||
    !optionalText(value.browser) ||
    typeof value.current !== "boolean"
  ) return false;
  if (
    value.reference !== null &&
    (typeof value.reference !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.reference))
  ) return false;
  if ((value.current && value.reference !== null) || (!value.current && value.reference === null)) {
    return false;
  }
  if (value.device === null) return true;
  return isObject(value.device) &&
    optionalText(value.device.name) &&
    optionalText(value.device.operatingSystem) &&
    optionalText(value.device.operatingSystemVersion) &&
    (value.device.mobile === null || typeof value.device.mobile === "boolean");
}

function parsePayload(value: unknown): SessionsPayload | null {
  if (
    !isObject(value) ||
    !Array.isArray(value.sessions) ||
    !value.sessions.every(validSession) ||
    typeof value.csrfToken !== "string" ||
    value.csrfToken.length < 1 ||
    value.csrfToken.length > 128
  ) return null;
  const currentCount = value.sessions.filter((session) => session.current).length;
  if (value.sessions.length > 0 && currentCount !== 1) return null;
  return { sessions: value.sessions, csrfToken: value.csrfToken };
}

function parseProblem(value: unknown, fallback: SafeProblem): SafeProblem {
  if (!isObject(value)) return fallback;
  return {
    title: typeof value.title === "string" && value.title.length <= 160
      ? value.title
      : fallback.title,
    detail: typeof value.detail === "string" && value.detail.length <= 512
      ? value.detail
      : fallback.detail,
  };
}

async function responseJson(response: Response) {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function displayDeviceName(session: ManagedAccountSession) {
  return [
    session.device?.name,
    session.device?.operatingSystem,
    session.device?.operatingSystemVersion,
  ].filter((value, index, values) => value && values.indexOf(value) === index).join(" · ") ||
    session.browser ||
    "Bilinmeyen cihaz";
}

function SessionCard({
  session,
  onRevoke,
  pending,
}: {
  session: ManagedAccountSession;
  onRevoke: (confirmation: Confirmation, trigger: HTMLButtonElement) => void;
  pending: boolean;
}) {
  const DeviceIcon = session.device?.mobile ? Smartphone : Laptop;
  const deviceName = displayDeviceName(session);
  return (
    <article className="session-card">
      <span className="session-card__icon" aria-hidden="true">
        <DeviceIcon size={20} />
      </span>
      <span className="session-card__copy">
        <strong>{deviceName}</strong>
        <small>{session.browser ?? "Tarayıcı bilgisi yok"}</small>
        <span className="session-card__times">
          <span>Son erişim <time dateTime={session.lastAccessAt}>{dateFormatter.format(new Date(session.lastAccessAt))}</time></span>
          <span>Başlangıç <time dateTime={session.startedAt}>{dateFormatter.format(new Date(session.startedAt))}</time></span>
          <span>Süre sonu <time dateTime={session.expiresAt}>{dateFormatter.format(new Date(session.expiresAt))}</time></span>
        </span>
      </span>
      <span className="session-card__action">
        {session.current ? (
          <StatusBadge tone="positive">Bu oturum</StatusBadge>
        ) : (
          <Button
            type="button"
            disabled={pending}
            onClick={(event) => onRevoke(
              {
                kind: "one",
                reference: session.reference!,
                deviceName,
              },
              event.currentTarget,
            )}
            size="lg"
            variant="destructive"
          >
            <LogOut aria-hidden="true" size={16} />
            Oturumu kapat
          </Button>
        )}
      </span>
    </article>
  );
}

const unavailableProblem: SafeProblem = {
  title: "Oturumlar yüklenemedi",
  detail: "Kimlik hizmetine şu anda ulaşılamıyor. Kısa bir süre sonra yeniden deneyebilirsin.",
};

export function SessionManager() {
  const router = useRouter();
  const [payload, setPayload] = useState<SessionsPayload | null>(null);
  const [problem, setProblem] = useState<SafeProblem | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  /** The last question asked: its words stay on the dialog while it animates out. */
  const [shownConfirmation, setShownConfirmation] = useState<Confirmation | null>(null);
  const [pending, setPending] = useState(false);
  const [actionProblem, setActionProblem] = useState<SafeProblem | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const firstLoadStarted = useRef(false);
  const confirmationTrigger = useRef<HTMLElement | null>(null);
  const successFeedback = useRef<HTMLParagraphElement | null>(null);
  const successFocusTarget = useRef<"feedback" | "trigger" | null>(null);

  const openConfirmation = useCallback((next: Confirmation, trigger: HTMLElement) => {
    confirmationTrigger.current = trigger;
    setShownConfirmation(next);
    setConfirmation(next);
  }, []);

  const closeConfirmation = useCallback(() => {
    setConfirmation(null);
    const trigger = confirmationTrigger.current;
    confirmationTrigger.current = null;
    queueMicrotask(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  }, []);

  const load = useCallback(async (preserve = false) => {
    if (!preserve) setLoading(true);
    setProblem(null);
    try {
      const response = await fetch("/api/account/sessions", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const body = await responseJson(response);
      if (response.status === 401) {
        router.replace("/login?returnTo=%2Fsessions");
        return;
      }
      if (!response.ok) {
        setProblem(parseProblem(body, unavailableProblem));
        return;
      }
      const parsed = parsePayload(body);
      if (!parsed) {
        setProblem({
          title: "Oturumlar güvenle durduruldu",
          detail: "Kimlik hizmetinin yanıtı desteklenen biçimle eşleşmedi. Hiçbir ham oturum bilgisi gösterilmedi.",
        });
        return;
      }
      setPayload(parsed);
    } catch {
      setProblem(unavailableProblem);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    if (firstLoadStarted.current) return;
    firstLoadStarted.current = true;
    void load();
  }, [load]);

  useEffect(() => {
    const targetKind = successFocusTarget.current;
    if (pending || confirmation || !targetKind) return;
    const target = targetKind === "feedback"
      ? successFeedback.current
      : confirmationTrigger.current;
    if (target?.isConnected) target.focus();
    successFocusTarget.current = null;
    confirmationTrigger.current = null;
  }, [confirmation, pending, success]);

  const revoke = async () => {
    if (!confirmation || !payload) return;
    setPending(true);
    setActionProblem(null);
    setSuccess(null);
    const all = confirmation.kind === "all";
    const url = all
      ? "/api/account/sessions"
      : `/api/account/sessions/${encodeURIComponent(confirmation.reference)}`;
    try {
      const response = await fetch(url, {
        method: "DELETE",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "x-csrf-token": payload.csrfToken },
      });
      if (response.status === 401) {
        router.replace("/login?returnTo=%2Fsessions");
        return;
      }
      if (response.status !== 204) {
        const body = await responseJson(response);
        setActionProblem(parseProblem(body, {
          title: "Oturum kapatılamadı",
          detail: "Oturumların değişmedi. Kısa bir süre sonra yeniden deneyebilirsin.",
        }));
        return;
      }
      successFocusTarget.current = all ? "trigger" : "feedback";
      setConfirmation(null);
      setSuccess(all ? "Diğer oturumlar kapatıldı." : "Oturum kapatıldı.");
      await load(true);
    } catch {
      setActionProblem({
        title: "Oturum kapatılamadı",
        detail: "Oturumların değişmedi. Kısa bir süre sonra yeniden deneyebilirsin.",
      });
    } finally {
      setPending(false);
    }
  };

  if (loading && !payload) {
    return (
      <section className={`${framedStateCard} session-state`} aria-label="Oturumlar yükleniyor">
        <ActionProgress label="Güvenli oturumların yükleniyor" size={72} />
      </section>
    );
  }

  if (problem) {
    return (
      <RetryableError
        detail={problem.detail}
        onRetry={() => void load()}
        pending={loading}
        title={problem.title}
      />
    );
  }

  const sessions = payload?.sessions ?? [];
  const otherCount = sessions.filter((session) => !session.current).length;
  const confirmationTitle = shownConfirmation?.kind === "all" ? "Diğer tüm oturumları kapat" : "Oturumu kapat";

  return (
    <>
      {success ? (
        <p
          ref={successFeedback}
          className="session-feedback"
          data-tone="success"
          role="status"
          tabIndex={-1}
        >
          <ShieldCheck aria-hidden="true" size={17} />
          {success}
        </p>
      ) : null}
      {actionProblem ? (
        <div className="session-feedback" data-tone="danger" role="alert">
          <AlertCircle aria-hidden="true" size={17} />
          <span><strong>{actionProblem.title}</strong>{actionProblem.detail}</span>
        </div>
      ) : null}
      {sessions.length > 0 ? (
        <section className="session-list" aria-label="Açık oturumlar">
          {sessions.map((session) => (
            <SessionCard
              key={session.reference ?? "current"}
              session={session}
              onRevoke={openConfirmation}
              pending={pending}
            />
          ))}
        </section>
      ) : (
        <EmptyState
          detail="Kimlik hesabın için görüntülenebilir aktif bir oturum bulunmuyor."
          icon={MonitorSmartphone}
          title="Açık oturum bulunamadı"
        />
      )}
      <section className="session-actions" aria-labelledby="session-actions-title">
        <span>
          <strong id="session-actions-title">Diğer cihazlardaki erişim</strong>
          <small>Şu an kullandığın cihazdaki oturumun açık kalır.</small>
        </span>
        <Button
          type="button"
          disabled={pending}
          aria-disabled={otherCount === 0 || pending}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          onClick={(event) => {
            if (otherCount > 0 && !pending) {
              openConfirmation({ kind: "all" }, event.currentTarget);
            }
          }}
          size="lg"
          variant="destructive"
        >
          <LogOut aria-hidden="true" size={16} />
          Diğer tüm oturumları kapat
        </Button>
      </section>
      <ConfirmDialog
        open={confirmation !== null}
        onOpenChange={(open) => { if (!open) closeConfirmation(); }}
        title={confirmationTitle}
        description={shownConfirmation?.kind === "one"
          ? `${shownConfirmation.deviceName} cihazındaki hesabına erişim sona erecek. Şu an kullandığın oturum açık kalacak.`
          : "Bu cihaz dışındaki tüm açık oturumlarda hesabına erişim sona erecek. Şu an kullandığın oturum açık kalacak."}
        actionLabel={confirmationTitle}
        destructive
        pending={pending}
        onAction={() => void revoke()}
      />
    </>
  );
}
