import { useEffect, useState } from "react";

export function localDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
export function expiryFromInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}
export function ExpiryLabel({ expiresAt }: { expiresAt: string | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return <span>永不过期</span>;
  const minutes = Math.ceil((Date.parse(expiresAt) - now) / 60000);
  const remaining = minutes > 1440 ? `${Math.ceil(minutes / 1440)} 天` : minutes > 60 ? `${Math.ceil(minutes / 60)} 小时` : `${minutes} 分钟`;
  return <span title={new Date(expiresAt).toLocaleString("zh-CN")}>{minutes <= 0 ? "已到期，请到回收站恢复" : `剩余 ${remaining} · 到期 ${new Date(expiresAt).toLocaleString("zh-CN")}`}</span>;
}
