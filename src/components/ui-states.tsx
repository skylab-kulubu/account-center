"use client";

import { AlertCircle, RotateCcw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button, SkylabLoader, StateCard } from "@skylab-kulubu/skylcn-ui";
import { framedStateCard } from "@/components/framed-state";

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
  icon,
  title,
}: {
  detail: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <StateCard className={framedStateCard} description={detail} icon={icon} title={title} tone="brand" />
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
  return (
    <div role="alert">
      <StateCard className={framedStateCard} description={detail} icon={AlertCircle} title={title} tone="danger">
        <Button aria-busy={pending} disabled={pending} onClick={onRetry} size="lg" type="button" variant="solid">
          <RotateCcw aria-hidden="true" />
          {pending ? "Yükleniyor…" : "Yeniden dene"}
        </Button>
      </StateCard>
    </div>
  );
}

/** A wait said in words beside skylcn's loader: 20 px inside a button, 72 px for a section's loading state. */
export function ActionProgress({ label, size = 20 }: { label: string; size?: 20 | 72 }) {
  return (
    <span className="action-progress" role="status" aria-live="polite">
      <SkylabLoader className="text-current" size={size} />
      <span>{label}</span>
    </span>
  );
}
