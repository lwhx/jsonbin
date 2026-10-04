import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

function focusable(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
  )).filter(element => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
}

export function ModalDialog({
  children,
  onClose,
  closeDisabled = false,
  labelledBy,
  ariaLabel,
  className = "",
}: {
  children: ReactNode;
  onClose?: () => void;
  closeDisabled?: boolean;
  labelledBy?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const moveFocusInside = () => {
      const first = focusable(dialog)[0];
      (first ?? dialog).focus();
    };
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) moveFocusInside();
    };

    moveFocusInside();
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("focusin", containFocus);
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (closeDisabled) ref.current?.focus();
  }, [closeDisabled]);

  function keyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && onClose && !closeDisabled) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusable(event.currentTarget);
    const first = items[0];
    const last = items.at(-1);
    if (!first) {
      event.preventDefault();
      event.currentTarget.focus();
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
      event.preventDefault();
      last!.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
      event.preventDefault();
      first.focus();
    }
  }

  return <div
    className="dialog-backdrop"
    role="presentation"
    onMouseDown={event => {
      if (event.currentTarget === event.target && onClose && !closeDisabled) onClose();
    }}
  >
    <div
      ref={ref}
      tabIndex={-1}
      className={`dialog ${className}`.trim()}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-label={ariaLabel}
      onKeyDown={keyDown}
      onMouseDown={event => event.stopPropagation()}
    >
      {children}
    </div>
  </div>;
}
