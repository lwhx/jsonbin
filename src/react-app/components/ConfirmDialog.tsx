import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Dialog } from "./Dialog";

export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type Request = { options: ConfirmOptions; resolve: (value: boolean) => void };
type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const active = useRef(false);
  const confirm = useCallback<ConfirmFn>((options) => {
    if (active.current) return Promise.resolve(false);
    active.current = true;
    return new Promise<boolean>(resolve => setRequest({ options, resolve }));
  }, []);

  function finish(value: boolean) {
    const current = request;
    setRequest(null);
    active.current = false;
    current?.resolve(value);
  }

  return <ConfirmContext.Provider value={confirm}>
    {children}
    {request && <Dialog titleId="confirm-dialog-title" onClose={() => finish(false)}>
      <div className="confirm-dialog">
        <h2 id="confirm-dialog-title">{request.options.title}</h2>
        <p>{request.options.message}</p>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={() => finish(false)}>
            {request.options.cancelLabel ?? "取消"}
          </button>
          <button type="button" autoFocus className={request.options.danger ? "danger-button" : "primary-button"}
            onClick={() => finish(true)}>
            {request.options.confirmLabel ?? "确认"}
          </button>
        </div>
      </div>
    </Dialog>}
  </ConfirmContext.Provider>;
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used inside ConfirmProvider");
  return confirm;
}
