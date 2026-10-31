"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, LogIn, RefreshCw, ShieldCheck } from "lucide-react";
import { Button, Stepper, TaskPage } from "@skylab-kulubu/skylcn-ui";
import type { TaskPageProps } from "@skylab-kulubu/skylcn-ui";

type DeletionStatus = "blocking" | "pending" | "processing" | "completed" | "manual_intervention";

type StatusPayload = {
  status: DeletionStatus;
  partial: boolean;
  requestedAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** An operator carries out a service's step by hand (today the CMS's): the person's retry cannot help. */
  awaitingManualStep: boolean;
  csrfToken: string;
};

type ViewState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "unknown" }
  | { kind: "unavailable" }
  | { kind: "status"; value: StatusPayload };

const statuses: readonly DeletionStatus[] = ["blocking", "pending", "processing", "completed", "manual_intervention"];

/**
 * How long the club has to finish a request: thirty days from the
 * application (KVKK art. 13(2)). The same as core's DeletionDeadline, whose
 * received notice names the same day (core-backend
 * internal/account/deletion_notices.go).
 */
const DELETION_DEADLINE_MS = 30 * 24 * 60 * 60 * 1000;

const deadlineDay = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** The last day of a request made at requestedAt: DD.MM.YYYY in Istanbul. */
export function deletionDeadline(requestedAt: string): string {
  return deadlineDay.format(new Date(Date.parse(requestedAt) + DELETION_DEADLINE_MS));
}

/**
 * The three steps the person sees, whatever core's saga is doing: the
 * request received, the data being erased, done. A request core holds for
 * its team (manual_intervention) is still being erased.
 */
function currentStep(status: DeletionStatus): number {
  if (status === "blocking") return 0;
  if (status === "completed") return 3;
  return 1;
}

function isPayload(value: unknown): value is StatusPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.status === "string" && statuses.includes(record.status as DeletionStatus) &&
    typeof record.partial === "boolean" &&
    typeof record.requestedAt === "string" && Number.isFinite(Date.parse(record.requestedAt)) &&
    typeof record.updatedAt === "string" && Number.isFinite(Date.parse(record.updatedAt)) &&
    (record.completedAt === null || (
      typeof record.completedAt === "string" && Number.isFinite(Date.parse(record.completedAt))
    )) &&
    typeof record.awaitingManualStep === "boolean" &&
    typeof record.csrfToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(record.csrfToken)
  );
}

export function AccountDeletionStatus() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [retrying, setRetrying] = useState(false);
  const pollAttempt = useRef(0);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/account/deletion/status", {
        cache: "no-store",
        credentials: "same-origin",
      });
      // `409 outcome_unknown`: core refused the credentials sealed for the
      // recovery replay. A 404 on the recovery page (`?recovery=1`, where a
      // lost answer sends the person) means the recovery window closed before
      // an answer came. Either way the request may already be under way.
      if (response.status === 409) {
        setView({ kind: "unknown" });
        return;
      }
      if (response.status === 404) {
        const recovering = new URLSearchParams(window.location.search).get("recovery") === "1";
        setView({ kind: recovering ? "unknown" : "missing" });
        return;
      }
      if (!response.ok) throw new Error();
      const payload: unknown = await response.json();
      if (!isPayload(payload)) throw new Error();
      setView({ kind: "status", value: payload });
    } catch {
      setView({ kind: "unavailable" });
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (view.kind !== "status" || !["blocking", "pending", "processing"].includes(view.value.status)) {
      pollAttempt.current = 0;
      return;
    }
    let timer: number | undefined;
    const schedule = () => {
      if (document.visibilityState !== "visible") return;
      const delay = [5_000, 10_000, 30_000][Math.min(pollAttempt.current, 2)]!;
      timer = window.setTimeout(() => {
        pollAttempt.current += 1;
        void load();
      }, delay);
    };
    const onVisibility = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState === "visible") void load();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, view]);

  async function retry() {
    if (view.kind !== "status" || view.value.status !== "manual_intervention") return;
    setRetrying(true);
    try {
      const response = await fetch("/api/account/deletion/status/retry", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "x-csrf-token": view.value.csrfToken },
      });
      if (!response.ok) throw new Error();
      const payload: unknown = await response.json();
      if (!isPayload(payload)) throw new Error();
      setView({ kind: "status", value: payload });
    } catch {
      setView({ kind: "unavailable" });
    } finally {
      setRetrying(false);
    }
  }

  const recheck = () => {
    setView({ kind: "loading" });
    void load();
  };
  const recheckButton = (
    <Button onClick={recheck} size="lg" type="button" variant="solid">
      <RefreshCw aria-hidden="true" /> Yeniden kontrol et
    </Button>
  );

  let page: Omit<TaskPageProps, "align" | "className" | "children"> & { body?: TaskPageProps["children"] };
  if (view.kind === "loading") {
    page = { title: "Silme isteğinin durumu alınıyor", loading: true };
  } else if (view.kind === "missing") {
    page = {
      icon: ShieldCheck,
      tone: "brand",
      title: "Silme isteği bulunamadı",
      description: "Bu tarayıcıda geçerli bir silme isteği yok veya durum bağlantısının süresi dolmuş.",
    };
  } else if (view.kind === "unknown") {
    page = {
      icon: AlertTriangle,
      tone: "warning",
      title: "Durum doğrulanamadı",
      description: "Silme isteğin işleme alınmış olabilir. Durumu yeniden kontrol edebilir ya da yeniden giriş yapabilirsin.",
      actions: (
        <>
          {recheckButton}
          <Button render={<Link href="/login" />} size="lg" variant="outline">
            <LogIn aria-hidden="true" /> Yeniden giriş yap
          </Button>
        </>
      ),
    };
  } else if (view.kind === "unavailable") {
    page = {
      icon: AlertTriangle,
      tone: "warning",
      title: "Durum alınamadı",
      description: "Silme isteğin değişmedi. Kısa bir süre sonra yeniden kontrol edebilirsin.",
      actions: recheckButton,
    };
  } else {
    const { status, requestedAt, awaitingManualStep } = view.value;
    const step = currentStep(status);
    const deadline = deletionDeadline(requestedAt);
    const completed = step === 3;
    page = {
      icon: completed ? CheckCircle2 : Clock3,
      tone: completed ? "success" : "brand",
      eyebrow: "Hesap silme",
      title: completed ? "Hesabın silindi" : step === 0 ? "Talebin alınıyor" : "Verilerin siliniyor",
      description: completed ? undefined : `En geç ${deadline}`,
      body: (
        <Stepper
          current={step}
          steps={[
            { id: "received", label: "Talep alındı" },
            { id: "erasing", label: "Veriler siliniyor" },
            { id: "completed", label: "Tamamlandı" },
          ]}
        />
      ),
      // An operator carrying out a step by hand (the CMS's) ends this
      // manual intervention; the person's retry would only fail again.
      actions: status === "manual_intervention" && !awaitingManualStep ? (
        <Button aria-busy={retrying} disabled={retrying} onClick={() => void retry()} size="lg" type="button" variant="outline">
          <RefreshCw aria-hidden="true" />
          {retrying ? "Yeniden deneniyor…" : "İşlemi yeniden dene"}
        </Button>
      ) : undefined,
    };
  }

  // One TaskPage for every state, so its heading (a polite live region) reads each new state once.
  const { body, ...task } = page;
  return (
    <TaskPage {...task} align="center" className="relative z-1 bg-transparent">
      {body}
    </TaskPage>
  );
}
