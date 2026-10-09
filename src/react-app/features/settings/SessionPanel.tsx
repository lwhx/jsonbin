import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";

type Item = {
  id: string;
  provider: "password" | "github";
  issuedAt: string;
  expiresAt: string;
  current: boolean;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch("/api/v1/auth" + path, { credentials: "include", cache: "no-store", ...init });
  if (!response.ok) throw new Error(response.status === 401 ? "当前登录已失效，请重新登录。" : "会话服务暂时不可用，请稍后重试。");
  return response.json() as Promise<T>;
}

/** Session identity/admin UI. The API never exposes cookie or token values. */
export function SessionPanel({ onLoggedOut }: { onLoggedOut: () => void }) {
  const confirm = useConfirm(), toast = useToast();
  const [busy, setBusy] = useState(false);
  const sessions = useQuery({
    queryKey: ["auth-sessions"],
    queryFn: () => request<{ items: Item[] }>("/sessions"),
    retry: false,
  });

  async function revoke(item: Item) {
    if (!await confirm({
      title: item.current ? "退出当前设备？" : "撤销设备会话？",
      message: item.current ? "当前设备将立即退出，未保存内容可能丢失。" : "该设备下次请求时将需要重新登录；其他设备保持登录。",
      confirmLabel: "撤销会话", cancelLabel: "取消", danger: true,
    })) return;
    setBusy(true);
    try {
      await request<{ ok: boolean }>("/sessions/" + encodeURIComponent(item.id), { method: "DELETE" });
      if (item.current) { onLoggedOut(); return; }
      await sessions.refetch();
      toast("该设备的会话已撤销。");
    } catch {
      toast("撤销失败，服务器尚未确认操作，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function revokeAll() {
    if (!await confirm({
      title: "退出所有设备？",
      message: "这会立即撤销所有浏览器和手机的现有登录，包括当前设备；再次访问需要重新登录。操作不能撤销。",
      confirmLabel: "退出所有设备", cancelLabel: "取消", danger: true,
    })) return;
    setBusy(true);
    try {
      await request<{ ok: boolean }>("/logout-all", { method: "POST" });
      onLoggedOut();
    } catch {
      toast("退出所有设备失败，服务器尚未确认撤销，当前登录状态已保留。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel session-management-panel" aria-label="登录设备管理">
      <header className="section-heading">
        <div>
          <h2>登录设备</h2>
          <p>登录有效期为固定 14 天。关闭浏览器不会退出；只有主动撤销或到期才会失效。</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void sessions.refetch()} disabled={busy || sessions.isFetching}>刷新</button>
      </header>
      {sessions.isPending && <p role="status">正在读取登录设备…</p>}
      {sessions.isError && <p role="alert">无法读取设备会话，请稍后重试。<button type="button" className="secondary-button" onClick={() => void sessions.refetch()}>重试</button></p>}
      {sessions.data && (sessions.data.items.length === 0
        ? <p role="status">当前没有已登记的设备会话。旧版 Cookie 在迁移期内可能不显示于此列表。</p>
        : <ul className="session-list" style={{ margin: "12px 0", paddingLeft: "20px" }}>
          {sessions.data.items.map(item => <li key={item.id} style={{ padding: "8px 0" }}>
            <strong>{item.provider === "github" ? "GitHub" : "账号密码"}{item.current ? " · 当前设备" : ""}</strong>
            <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.8 }}>{item.id.slice(0, 8)} · 登录：{new Date(item.issuedAt).toLocaleString("zh-CN")}</span>
            <button type="button" className="secondary-button" style={{ marginLeft: 12 }}
              disabled={busy} onClick={() => void revoke(item)} aria-label={`撤销会话 ${item.id.slice(0, 8)}`}>撤销</button>
          </li>)}
        </ul>)}
      <button type="button" className="secondary-button" disabled={busy || sessions.isPending || sessions.isError}
        onClick={() => void revokeAll()}>退出所有设备</button>
    </section>
  );
}
