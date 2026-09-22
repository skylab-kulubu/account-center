"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { SudoDialog } from "@/components/sudo-dialog";
import type { SudoVerification } from "@/components/sudo-dialog";

/**
 * Window events that open the dialog from outside the React tree. No product
 * screen triggers Sudo mode until the security page ships (A5), so the
 * browser tests use these to drive the real dialog; they are the only
 * consumer. `SUDO_REQUEST_EVENT` behaves like `ensureSudo()`, and
 * `SUDO_RESULT_EVENT` carries `{ verified, expiresAt }`.
 */
export const SUDO_REQUEST_EVENT = "account-center:sudo-request";
export const SUDO_RESULT_EVENT = "account-center:sudo-result";
/** A local proof with less life than this is treated as stale; the server enforces the real deadline. */
const LOCAL_SUDO_MARGIN_MS = 15_000;

export type EnsureSudoOptions = {
  /**
   * Set when a mutation just answered `428 sudo_required`: the server has the
   * final word, so any deadline this page remembered is dropped before the
   * dialog opens.
   */
  challenged?: boolean;
};

export type SudoContextValue = {
  /**
   * Resolves `true` once the person holds a fresh sudo proof: immediately when
   * one is known locally, otherwise after the dialog succeeds (the dialog
   * itself closes at once when the server reports an active proof). Resolves
   * `false` when the person dismisses the dialog. Call it after a mutation
   * answered `428 sudo_required` (with `challenged: true`), then retry.
   */
  ensureSudo: (options?: EnsureSudoOptions) => Promise<boolean>;
  /** Forgets the locally remembered deadline; the next `ensureSudo` asks the server again. */
  invalidateSudo: () => void;
  /** Deadline of the last proof this page saw, or `null`. */
  sudoExpiresAt: Date | null;
};

const SudoContext = createContext<SudoContextValue | null>(null);

type Notice = { tone: "positive" | "neutral" | "warning"; title: string; detail: string };

const notices: Record<string, Notice> = {
  confirmed: {
    tone: "positive",
    title: "Kimliğin doğrulandı",
    detail: "Microsoft ile yeniden doğrulama tamamlandı. Yaklaşık 5 dakika boyunca hassas işlemleri yeniden doğrulamadan yapabilirsin.",
  },
  cancelled: {
    tone: "neutral",
    title: "Yeniden doğrulama tamamlanmadı",
    detail: "Hesabında değişiklik yapılmadı. İstediğinde yeniden deneyebilirsin.",
  },
  method_available: {
    tone: "warning",
    title: "Microsoft ile doğrulama gerekmiyor",
    detail: "Hesabında parola, passkey ya da doğrulama uygulaması var. Hassas işlemden önce kimliğini bunlarla doğrula; Microsoft ile yeniden doğrulama yalnız hiçbiri olmayanlar içindir.",
  },
  unavailable: {
    tone: "warning",
    title: "Yeniden doğrulama kaydedilemedi",
    detail: "Doğrulama başlatılamadı ya da sonucu kaydedilemedi. Kısa bir süre sonra yeniden dene.",
  },
};

/**
 * Announces how the Microsoft round trip ended and strips `?sudo=` from the
 * address. It never marks sudo locally: the proof lives on the server and
 * the dialog learns about it from `GET /api/account/sudo/methods`.
 */
function ReauthenticationNotice() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  // The Microsoft round trip ends in a full navigation, so the outcome is read once at mount.
  const [notice] = useState<Notice | null>(() => notices[searchParams.get("sudo") ?? ""] ?? null);
  const handled = useRef(false);

  useEffect(() => {
    if (!notice || handled.current) return;
    handled.current = true;
    const remaining = new URLSearchParams(searchParams.toString());
    remaining.delete("sudo");
    const query = remaining.toString();
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
  }, [notice, pathname, searchParams]);

  if (!notice) return null;
  return (
    <div className="action-notice sudo-notice" data-tone={notice.tone} role="status">
      <strong>{notice.title}</strong>
      <span>{notice.detail}</span>
    </div>
  );
}

/**
 * Hosts the Sudo mode dialog for the account pages. Any client component asks
 * for a fresh proof with `useSudo().ensureSudo()`; the provider opens the
 * dialog once for concurrent callers and remembers the deadline it saw so a
 * second sensitive action inside the window does not prompt again.
 */
export function SudoProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const expiresAtRef = useRef<Date | null>(null);
  const waiters = useRef<Array<(verified: boolean) => void>>([]);
  const returnFocus = useRef<HTMLElement | null>(null);

  const remember = useCallback((deadline: Date | null) => {
    expiresAtRef.current = deadline;
    setExpiresAt(deadline);
  }, []);

  const settle = useCallback((verified: boolean) => {
    const pending = waiters.current;
    waiters.current = [];
    setOpen(false);
    for (const resolve of pending) resolve(verified);
    const target = returnFocus.current;
    returnFocus.current = null;
    queueMicrotask(() => {
      if (target?.isConnected) target.focus();
    });
  }, []);

  const invalidateSudo = useCallback(() => remember(null), [remember]);

  const ensureSudo = useCallback((options: EnsureSudoOptions = {}) => new Promise<boolean>((resolve) => {
    if (options.challenged) remember(null);
    const known = expiresAtRef.current;
    if (known && known.getTime() - Date.now() > LOCAL_SUDO_MARGIN_MS) {
      resolve(true);
      return;
    }
    waiters.current.push(resolve);
    setOpen((current) => {
      if (!current && document.activeElement instanceof HTMLElement) {
        returnFocus.current = document.activeElement;
      }
      return true;
    });
  }), [remember]);

  useEffect(() => {
    const onRequest = (event: Event) => {
      const challenged = event instanceof CustomEvent && event.detail?.challenged === true;
      void ensureSudo({ challenged }).then((verified) => {
        window.dispatchEvent(new CustomEvent(SUDO_RESULT_EVENT, {
          detail: { verified, expiresAt: expiresAtRef.current?.toISOString() ?? null },
        }));
      });
    };
    window.addEventListener(SUDO_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(SUDO_REQUEST_EVENT, onRequest);
  }, [ensureSudo]);

  const onVerified = useCallback((verification: SudoVerification) => {
    const deadline = new Date(verification.expiresAt);
    remember(Number.isFinite(deadline.getTime()) ? deadline : null);
    settle(true);
  }, [remember, settle]);

  const onDismiss = useCallback(() => settle(false), [settle]);

  const value = useMemo<SudoContextValue>(
    () => ({ ensureSudo, invalidateSudo, sudoExpiresAt: expiresAt }),
    [ensureSudo, invalidateSudo, expiresAt],
  );

  return (
    <SudoContext.Provider value={value}>
      <Suspense fallback={null}>
        <ReauthenticationNotice />
      </Suspense>
      {children}
      {open ? (
        <SudoDialog returnTo={pathname} onVerified={onVerified} onDismiss={onDismiss} />
      ) : null}
    </SudoContext.Provider>
  );
}

export function useSudo(): SudoContextValue {
  const context = useContext(SudoContext);
  if (!context) throw new Error("useSudo must be used inside SudoProvider.");
  return context;
}

/** Whether a fetch answer is the sudo challenge a mutation route sends before doing anything. */
export function isSudoRequired(response: Response) {
  return response.status === 428;
}
