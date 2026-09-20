"use client";

import { AlertCircle, RotateCcw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useId } from "react";
import { LogoLoader } from "@/components/logo-loader";

export function PageSkeleton({
  label = "Sayfa yükleniyor",
  rows = 3,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div className="page-stack page-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      <span className="skeleton skeleton--eyebrow" aria-hidden="true" />
      <span className="skeleton skeleton--title" aria-hidden="true" />
      <span className="skeleton skeleton--description" aria-hidden="true" />
      <div className="skeleton-card" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <div className="skeleton-row" data-skeleton-row key={index}>
            <span className="skeleton skeleton--icon" />
            <span className="skeleton-row__copy">
              <span className="skeleton skeleton--line" />
              <span className="skeleton skeleton--line skeleton--line-short" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function EmptyState({
  detail,
  icon: Icon,
  title,
}: {
  detail: string;
  icon: LucideIcon;
  title: string;
}) {
  const headingId = useId();
  return (
    <section className="state-card" aria-labelledby={headingId}>
      <span className="state-card__icon" aria-hidden="true">
        <Icon size={26} strokeWidth={1.6} />
      </span>
      <h2 id={headingId}>{title}</h2>
      <p>{detail}</p>
    </section>
  );
}

export function RetryableError({
  detail,
  onRetry,
  pending = false,
  title,
}: {
  detail: string;
  onRetry: () => void;
  pending?: boolean;
  title: string;
}) {
  const headingId = useId();
  return (
    <section className="state-card account-data-problem" role="alert" aria-labelledby={headingId}>
      <span className="state-card__icon" aria-hidden="true">
        <AlertCircle size={26} strokeWidth={1.6} />
      </span>
      <h2 id={headingId}>{title}</h2>
      <p>{detail}</p>
      <button
        aria-busy={pending}
        className="primary-button"
        disabled={pending}
        type="button"
        onClick={onRetry}
      >
        <RotateCcw aria-hidden="true" size={16} />
        {pending ? "Yükleniyor…" : "Yeniden dene"}
      </button>
    </section>
  );
}

export function ActionProgress({ label }: { label: string }) {
  return (
    <span className="action-progress" role="status" aria-live="polite">
      <LogoLoader announce={false} label={label} size={20} />
      <span>{label}</span>
    </span>
  );
}
