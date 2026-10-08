import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

type Props = {
  /** Static text, or a resolver for lazily fetched values (e.g. revealed key tokens). */
  value: string | (() => string | Promise<string>);
  label?: string;
  copiedLabel?: string;
  failedLabel?: string;
  className?: string;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
};

const FEEDBACK_MS = 2000;

/** Copy-to-clipboard button with per-button icon/label feedback for ~2s. */
export function CopyButton({
  value,
  label = "复制",
  copiedLabel = "已复制",
  failedLabel = "复制失败",
  className = "secondary-button",
  title,
  ariaLabel,
  disabled = false,
}: Props) {
  const [state, setState] = useState<"idle" | "pending" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy() {
    if (state === "pending") return;
    setState("pending");
    let next: "copied" | "failed";
    try {
      const text = typeof value === "function" ? await value() : value;
      await navigator.clipboard.writeText(text);
      next = "copied";
    } catch {
      next = "failed";
    }
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), FEEDBACK_MS);
  }

  return <button type="button" className={className} title={title} aria-label={ariaLabel ?? label}
    disabled={disabled || state === "pending"} onClick={copy}>
    {state === "copied" ? <Check size={14} /> : <Copy size={14} />}
    {state === "pending" ? "正在复制…" : state === "copied" ? copiedLabel : state === "failed" ? failedLabel : label}
  </button>;
}
