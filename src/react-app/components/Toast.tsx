import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";

export type ToastKind = "success" | "error" | "info";
type Toast = { id: number; kind: ToastKind; message: string };
type ToastFn = (message: string, kind?: ToastKind) => void;

const ToastContext = createContext<ToastFn | null>(null);

const AUTO_DISMISS_MS = 3500;
const ERROR_DISMISS_MS = 6000;

/**
 * Transient global feedback for actions whose own page is about to go away
 * (navigate after create, batch results) or that should not displace a page's
 * persistent notice/error area. Mirrors the ConfirmProvider wiring in
 * components/ConfirmDialog.tsx.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts(list => list.filter(toast => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback<ToastFn>((message, kind = "success") => {
    const id = ++nextId.current;
    // A short stack keeps this feedback, not a log.
    setToasts(list => [...list.slice(-2), { id, kind, message }]);
    timers.current.set(id, setTimeout(() => dismiss(id), kind === "error" ? ERROR_DISMISS_MS : AUTO_DISMISS_MS));
  }, [dismiss]);

  return <ToastContext.Provider value={push}>
    {children}
    <div className="toast-stack" role="region" aria-label="通知">
      {toasts.map(toast => <div key={toast.id} className={`toast toast-${toast.kind}`}
        role={toast.kind === "error" ? "alert" : "status"}>
        <span>{toast.message}</span>
        <button type="button" className="toast-close" aria-label="关闭通知" onClick={() => dismiss(toast.id)}>×</button>
      </div>)}
    </div>
  </ToastContext.Provider>;
}

export function useToast() {
  const push = useContext(ToastContext);
  if (!push) throw new Error("useToast must be used inside ToastProvider");
  return push;
}
