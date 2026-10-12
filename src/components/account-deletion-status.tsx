"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, CheckCircle2, Clock3, LogIn, RefreshCw, ShieldCheck } from "lucide-react";
import { Button, Notice, TaskPage } from "@skylab-kulubu/skylcn-ui";
import type { TaskPageProps } from "@skylab-kulubu/skylcn-ui";

type DeletionStatus = "blocking" | "pending" | "processing" | "completed" | "manual_intervention";

type StatusPayload = {
  status: DeletionStatus;
  partial: boolean;
  updatedAt: string;
  completedAt: string | null;
  csrfToken: string;
};

type ViewState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "unknown" }
  | { kind: "unavailable" }
  | { kind: "status"; value: StatusPayload };

const copy: Record<DeletionStatus, { title: string; detail: string }> = {
  blocking: {
    title: "Erişimin güvenle kapatılıyor",
    detail: "SKY LAB uygulamalarına yeni erişim durduruluyor. Ardından silme adımları başlayacak.",
  },
  pending: {
    title: "Silme isteğin sırada",
    detail: "İsteğin güvenle kaydedildi. Yoğunluğa göre işlem biraz zaman alabilir.",
  },
  processing: {
    title: "Hesabın siliniyor",
    detail: "Bağlı sistemlerdeki kişisel verilerin sırayla siliniyor veya kimliğinden ayrılıyor.",
  },
  completed: {
    title: "Hesabın silindi",
    detail: "Silme işlemi tamamlandı. Zorunlu operasyon kayıtları artık hesabınla ilişkilendirilemez.",
  },
  manual_intervention: {
    title: "Ekibimizin incelemesi gerekiyor",
    detail: "Bazı adımlar otomatik tamamlanamadı. Erişimin kapalı kalacak; işlemi güvenle yeniden deneyebilirsin.",
  },
};

function isPayload(value: unknown): value is StatusPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.status === "string" && record.status in copy &&
    typeof record.partial === "boolean" &&
    typeof record.updatedAt === "string" && Number.isFinite(Date.parse(record.updatedAt)) &&
    (record.completedAt === null || (
      typeof record.completedAt === "string" && Number.isFinite(Date.parse(record.completedAt))
    )) &&
    typeof record.csrfToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(record.csrfToken)
  );
}

const subscribeToNothing = () => () => {};

export function AccountDeletionStatus() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [retrying, setRetrying] = useState(false);
  const hydrated = useSyncExternalStore(subscribeToNothing, () => true, () => false);
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
    // skylcn's loader sizes itself with an inline style, which this page's CSP
    // refuses in server-rendered HTML; it appears once React runs in the browser.
    page = { title: "Silme isteğinin durumu alınıyor", loading: hydrated };
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
    const { status, partial, updatedAt } = view.value;
    const completed = status === "completed";
    page = {
      icon: completed ? CheckCircle2 : Clock3,
      tone: completed ? "success" : "brand",
      eyebrow: "Hesap silme durumu",
      title: copy[status].title,
      description: copy[status].detail,
      body: (
        <>
          {partial && !completed ? (
            <Notice tone="info">Tamamlanan adımlar korunuyor; hiçbir işlem baştan başlamayacak.</Notice>
          ) : null}
          {!completed ? (
            <p className="m-0 text-center text-xs leading-relaxed text-muted-foreground">
              Bu sayfayı kapatabilirsin; işlem arka planda güvenle devam eder.
            </p>
          ) : null}
          <small className="text-center text-2xs text-subtle-foreground">
            Son güncelleme: {new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(updatedAt))}
          </small>
        </>
      ),
      actions: status === "manual_intervention" ? (
        <Button aria-busy={retrying} disabled={retrying} onClick={() => void retry()} size="lg" type="button" variant="solid">
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
