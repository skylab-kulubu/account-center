"use client";

import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

function trapFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ),
  );
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
}

type ModalDialogProps = {
  titleId: string;
  descriptionId?: string;
  className?: string;
  pending?: boolean;
  icon: ReactNode;
  iconClassName?: string;
  onDismiss: () => void;
  children: ReactNode;
};

/**
 * A modal `<dialog>` in the confirmation-dialog style: opened with
 * `showModal()`, focus kept inside, Escape and the close button dismiss it
 * (never while an action is pending).
 */
export function ModalDialog({
  titleId,
  descriptionId,
  className,
  pending = false,
  icon,
  iconClassName,
  onDismiss,
  children,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
    return () => {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      else dialog.removeAttribute("open");
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={["confirmation-dialog", className].filter(Boolean).join(" ")}
      aria-busy={pending}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={trapFocus}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onDismiss();
      }}
    >
      <button
        className="confirmation-dialog__close"
        type="button"
        aria-label="Pencereyi kapat"
        disabled={pending}
        onClick={onDismiss}
      >
        <X aria-hidden="true" size={18} />
      </button>
      <span className={["confirmation-dialog__icon", iconClassName].filter(Boolean).join(" ")} aria-hidden="true">
        {icon}
      </span>
      {children}
    </dialog>
  );
}
