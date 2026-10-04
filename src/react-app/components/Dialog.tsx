import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

type Props = {
  titleId: string;
  children: ReactNode;
  onClose?: () => void;
  dismissible?: boolean;
  className?: string;
};

export function Dialog({ titleId, children, onClose, dismissible = true, className = "" }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    if (!dialog) return;
    const focusable = dialog.querySelector<HTMLElement>(
      "[autofocus], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
    );
    (focusable ?? dialog).focus();
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) (focusable ?? dialog).focus();
    };
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("focusin", containFocus);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  function keyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && dismissible && onClose) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
    )).filter(item => item.tabIndex >= 0);
    const first = items[0], last = items.at(-1);
    if (!first || !last) {
      event.preventDefault();
      event.currentTarget.focus();
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
      event.preventDefault(); first.focus();
    }
  }

  return <div className="dialog-backdrop" role="presentation"
    onMouseDown={event => { if (event.target === event.currentTarget && dismissible) onClose?.(); }}>
    <div ref={ref} tabIndex={-1} className={`dialog ${className}`.trim()} role="dialog"
      aria-modal="true" aria-labelledby={titleId} onKeyDown={keyDown}>
      {children}
    </div>
  </div>;
}
