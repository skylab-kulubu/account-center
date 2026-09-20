"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, RefreshCw, ShieldCheck } from "lucide-react";
import { LogoLoader } from "@/components/logo-loader";

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
      if (response.status === 404) {
        setView({ kind: "missing" });
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

  if (view.kind === "loading") {
    return <div aria-live="polite" className="deletion-status-live"><LogoLoader label="Silme isteğinin durumu alınıyor" size={76} /></div>;
  }

  if (view.kind === "missing") {
    return (
      <div aria-live="polite" className="deletion-status-live">
        <section className="state-card deletion-status-card" aria-labelledby="deletion-status-title">
          <span className="state-card__icon" aria-hidden="true"><ShieldCheck size={24} /></span>
          <h1 id="deletion-status-title">Silme isteği bulunamadı</h1>
          <p>Bu tarayıcıda geçerli bir silme isteği yok veya durum bağlantısının süresi dolmuş.</p>
        </section>
      </div>
    );
  }

  if (view.kind === "unavailable") {
    return (
      <div aria-live="polite" className="deletion-status-live">
        <section className="state-card deletion-status-card" aria-labelledby="deletion-status-title">
          <span className="state-card__icon" aria-hidden="true"><AlertTriangle size={24} /></span>
          <h1 id="deletion-status-title">Durum alınamadı</h1>
          <p>Silme isteğin değişmedi. Kısa bir süre sonra yeniden kontrol edebilirsin.</p>
          <button className="primary-button" onClick={() => { setView({ kind: "loading" }); void load(); }} type="button">
            <RefreshCw aria-hidden="true" size={16} /> Yeniden kontrol et
          </button>
        </section>
      </div>
    );
  }

  const statusCopy = copy[view.value.status];
  const Icon = view.value.status === "completed" ? CheckCircle2 : Clock3;
  return (
    <div aria-live="polite" className="deletion-status-live">
      <section className="state-card deletion-status-card" aria-labelledby="deletion-status-title">
      <span className="state-card__icon" aria-hidden="true"><Icon size={24} /></span>
      <p className="eyebrow">Hesap silme durumu</p>
      <h1 id="deletion-status-title">{statusCopy.title}</h1>
      <p>{statusCopy.detail}</p>
      {view.value.partial && view.value.status !== "completed" ? (
        <p className="deletion-status-card__note">Tamamlanan adımlar korunuyor; hiçbir işlem baştan başlamayacak.</p>
      ) : null}
      {view.value.status !== "completed" ? (
        <p className="deletion-status-card__continue">Bu sayfayı kapatabilirsin; işlem arka planda güvenle devam eder.</p>
      ) : null}
      {view.value.status === "manual_intervention" ? (
        <button aria-busy={retrying} className="primary-button" disabled={retrying} onClick={() => void retry()} type="button">
          <RefreshCw aria-hidden="true" size={16} />
          {retrying ? "Yeniden deneniyor…" : "İşlemi yeniden dene"}
        </button>
      ) : null}
      <small className="deletion-status-card__updated">
        Son güncelleme: {new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(view.value.updatedAt))}
      </small>
      </section>
    </div>
  );
}
