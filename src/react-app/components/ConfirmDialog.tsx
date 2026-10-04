import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { ModalDialog } from "./ModalDialog";

export type ConfirmDialogOptions = {
  title: string;
  message: string;
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
};

type Request = ConfirmDialogOptions & { resolve: (accepted: boolean) => void };
let dispatcher: ((request: Request) => void) | null = null;

export function confirmDialog(options: ConfirmDialogOptions) {
  return new Promise<boolean>(resolve => {
    if (!dispatcher) {
      resolve(false);
      return;
    }
    dispatcher({ ...options, resolve });
  });
}

export function ConfirmDialogHost() {
  const [queue, setQueue] = useState<Request[]>([]);
  const current = queue[0] ?? null;

  useEffect(() => {
    dispatcher = request => setQueue(previous => [...previous, request]);
    return () => {
      dispatcher = null;
      setQueue(previous => {
        for (const request of previous) request.resolve(false);
        return [];
      });
    };
  }, []);

  function finish(accepted: boolean) {
    if (!current) return;
    current.resolve(accepted);
    setQueue(previous => previous.slice(1));
  }

  if (!current) return null;

  const id = "confirm-dialog-title";
  const danger = current.tone === "danger";
  return <ModalDialog
    labelledBy={id}
    className={`confirm-dialog ${danger ? "confirm-dialog-danger" : ""}`}
    onClose={() => finish(false)}
  >
    <div className="confirm-dialog-heading">
      <span className={`confirm-dialog-icon ${danger ? "danger" : ""}`} aria-hidden="true">
        <TriangleAlert size={19} />
      </span>
      <div>
        <h2 id={id}>{current.title}</h2>
        <p>{current.message}</p>
      </div>
    </div>
    {current.details?.length ? <ul className="confirm-dialog-details">
      {current.details.map(detail => <li key={detail}>{detail}</li>)}
    </ul> : null}
    <div className="dialog-actions confirm-dialog-actions">
      <button type="button" className="secondary-button" data-dialog-cancel="true" onClick={() => finish(false)}>
        {current.cancelLabel ?? "取消"}
      </button>
      <button
        type="button"
        className={danger ? "danger-button" : "primary-button"}
        data-dialog-confirm="true"
        onClick={() => finish(true)}
      >
        {current.confirmLabel ?? "确认"}
      </button>
    </div>
  </ModalDialog>;
}
