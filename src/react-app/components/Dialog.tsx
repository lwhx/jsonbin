import type { ReactNode, RefObject } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";

type Props = {
  titleId: string;
  children: ReactNode;
  onClose?: () => void;
  dismissible?: boolean;
  className?: string;
  focusContainer?: boolean;
  /** Explicit initial focus target; without it the first focusable in document order wins. */
  initialFocus?: RefObject<HTMLElement | null>;
};

export function Dialog({ titleId, children, onClose, dismissible = true, className = "", focusContainer = false, initialFocus }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const focusable = () => ref.current?.querySelector<HTMLElement>(
    "[autofocus], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
  ) ?? null;

  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    if (!dialog) return;
    (initialFocus?.current ?? focusable() ?? dialog).focus();
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) (focusable() ?? dialog).focus();
    };
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("focusin", containFocus);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const active = document.activeElement;
    const activeInside = active instanceof Node && dialog.contains(active);
    const activeDisabled = active instanceof HTMLButtonElement && active.disabled;
    if ((!activeInside || activeDisabled) && !focusable()) dialog.focus();
  });

  useEffect(() => {
    if (focusContainer) ref.current?.focus();
  }, [focusContainer]);

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
