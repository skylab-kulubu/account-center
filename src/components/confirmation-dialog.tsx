"use client";

import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useRef } from "react";
import { ActionProgress } from "@/components/ui-states";

const focusableControls =
  "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * Native modal confirmation for a destructive action: opens with
 * `showModal`, keeps Tab inside, treats Escape as cancel while idle and
 * blocks every control while the confirmed action is pending. The caller
 * owns focus restoration to the triggering control.
 */
export function ConfirmationDialog({
  title,
  description,
  confirmLabel,
  pendingLabel,
  icon,
  pending,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  icon: ReactNode;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      else dialog.removeAttribute("open");
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="confirmation-dialog"
      aria-busy={pending}
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(focusableControls));
        const first = controls.at(0);
        const last = controls.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        } else if (!event.currentTarget.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
    >
      <button
        className="confirmation-dialog__close"
        type="button"
        aria-label="Pencereyi kapat"
        autoFocus
        disabled={pending}
        onClick={onCancel}
      >
        <X aria-hidden="true" size={18} />
      </button>
      <span className="confirmation-dialog__icon" aria-hidden="true">{icon}</span>
      <h2 id={titleId}>{title}</h2>
      <p>{description}</p>
      <div className="confirmation-dialog__actions">
        <button className="secondary-button" type="button" disabled={pending} onClick={onCancel}>
          Vazgeç
        </button>
        <button className="danger-button danger-button--inline" type="button" disabled={pending} onClick={onConfirm}>
          {pending ? <ActionProgress label={pendingLabel} /> : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
