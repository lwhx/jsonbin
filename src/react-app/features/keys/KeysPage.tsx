import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createKey, KeyApiError, listKeys, revokeKey, scopes, scopeLabels } from "./api";
import type { ApiKey, ApiScope } from "./api";
const defaultScopes: ApiScope[] = ["bin:read"];
const displayTime = (value: string | null, fallback: string) => value ? new Date(value).toLocaleString("zh-CN") : fallback;
export function KeysPage({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const client = useQueryClient(), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const query = useQuery({ queryKey: ["keys"], queryFn: ({ signal }) => listKeys(signal), retry: false });
  const [name, setName] = useState(""), [selected, setSelected] = useState<ApiScope[]>(defaultScopes), [expiration, setExpiration] = useState("");
  const [disclosure, setDisclosure] = useState<{ key: ApiKey; token: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<Error | null>(null), [notice, setNotice] = useState("");
  const dirty = Boolean(name || expiration || JSON.stringify(selected) !== JSON.stringify(defaultScopes) || disclosure);
  useEffect(() => { onDirtyChange(dirty || busy); }, [dirty, busy, onDirtyChange]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, busy]);
  function report(caught: unknown) { if (mounted.current) setError(caught instanceof Error ? caught : new Error("操作失败，请重试。")); }
  async function create() {
    if (busy || disclosure) return;
    let expiresAt: string | null = null;
    if (expiration) {
      const date = new Date(expiration);
      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) { setError(new Error("过期时间必须在未来。")); return; }
      expiresAt = date.toISOString();
    }
    setBusy(true); setError(null); setNotice("");
    try {
      const created = await createKey({ name, scopes: selected, expiresAt });
      if (!mounted.current) return;
      setDisclosure(created); setName(""); setSelected(defaultScopes); setExpiration("");
      await client.invalidateQueries({ queryKey: ["keys"] });
    } catch (caught) { report(caught); } finally { if (mounted.current) setBusy(false); }
  }
  async function copy() {
    if (!disclosure) return;
    try { await navigator.clipboard.writeText(disclosure.token); if (mounted.current) setNotice("密钥已复制，请保存到安全位置。"); }
    catch { if (mounted.current) setError(new Error("无法访问剪贴板，请手动选择并复制密钥。")); }
  }
  async function revoke(key: ApiKey) {
    if (busy || key.revokedAt || !window.confirm(`撤销密钥“${key.name}”？使用此密钥的新请求将无法通过认证。`)) return;
    setBusy(true); setError(null); setNotice("");
    try {
      await revokeKey(key.id); await client.invalidateQueries({ queryKey: ["keys"] });
      if (!mounted.current) return;
      if (disclosure?.key.id === key.id) setDisclosure(null);
      setNotice("密钥已撤销。");
    } catch (caught) { report(caught); } finally { if (mounted.current) setBusy(false); }
  }
  return <section className="keys-page"><header className="hero bins-hero"><div><span className="eyebrow">开发者</span><h1>API 密钥</h1>
    <p>为脚本或应用创建 Bearer Token，按所需权限授予访问。明文只在创建成功时显示一次。bin:delete 包括回收站永久删除；恢复需 bin:update 和 history:read。</p></div>
    <button className="secondary-button" disabled={busy} onClick={() => query.refetch()}>刷新密钥列表</button></header>
    {notice && <p className="detail-notice" role="status">{notice}</p>}
    {error && <div className="detail-error" role="alert">{error.message}
      {error instanceof KeyApiError && error.status === 401 && <button className="secondary-button" onClick={() => {
        if (!dirty || window.confirm("重新登录会离开当前页面，是否放弃未保存的内容和当前显示的密钥？")) client.invalidateQueries({ queryKey: ["auth-me"] });
      }}>重新登录</button>}</div>}
    {disclosure && <section className="panel detail-form key-disclosure" aria-label="新密钥明文"><h2>请保存新密钥</h2>
      <p>“{disclosure.key.name}”的明文只在此处显示一次。关闭此提示或刷新页面后无法再次查看。</p>
      <label>新 API 密钥<input aria-label="新 API 密钥" readOnly type="text" spellCheck={false} autoComplete="off" value={disclosure.token} onFocus={event => event.target.select()} /></label>
      <div className="detail-actions"><button className="secondary-button" type="button" onClick={copy}>复制密钥</button>
        <button className="primary-button" type="button" onClick={() => { setDisclosure(null); setNotice("明文已隐藏，请使用已保存的密钥调用 API。"); }}>我已保存密钥</button></div>
    </section>}
    <form className="panel detail-form" onSubmit={event => { event.preventDefault(); create(); }}>
      <h2>创建 API 密钥</h2>
      <label>密钥名称<input aria-label="密钥名称" required maxLength={160} disabled={busy || Boolean(disclosure)} value={name} autoComplete="off" onChange={event => setName(event.target.value)} /></label>
      <fieldset className="key-scopes" disabled={busy || Boolean(disclosure)}><legend>权限 Scope</legend>
        {scopes.map(scope => <label className="schema-checkbox" key={scope}><input type="checkbox" aria-label={scope} checked={selected.includes(scope)}
          onChange={event => setSelected(previous => scopes.filter(item => item === scope ? event.target.checked : previous.includes(item)))} />
          <span>{scopeLabels[scope]} <code>{scope}</code></span></label>)}
      </fieldset>
      <label>过期时间<input aria-label="过期时间" type="datetime-local" disabled={busy || Boolean(disclosure)} value={expiration} onChange={event => setExpiration(event.target.value)} /></label>
      <p>留空表示不过期；时间按当前设备时区输入。查看集合内数据仓需要 collection:read 和 bin:read；恢复历史版本需要 bin:update 和 history:read。密钥管理仅支持网页登录。</p>
      <button className="primary-button" type="submit" disabled={busy || Boolean(disclosure) || !name.trim() || !selected.length}>{busy ? "正在处理…" : "创建密钥"}</button>
    </form>
    <section className="panel collection-panel" aria-label="已创建的 API 密钥"><h2>已创建的密钥 · {query.data?.total ?? 0} 个</h2>
      {query.isPending ? <p role="status">正在加载密钥…</p> : query.isError ? <><p role="alert">{query.error.message}</p>
        <button className="secondary-button" onClick={() => query.refetch()}>重试密钥列表</button></> : query.data.items.length ?
        <ul className="key-list">{query.data.items.map(key => <li key={key.id}><div><h3>{key.name}</h3><code>{key.prefix}</code>
          <p>状态：{key.revokedAt ? "已撤销" : key.expiresAt && Date.parse(key.expiresAt) <= Date.now() ? "已过期" : "有效"}</p>
          <p>权限：{key.scopes.join(" · ")}</p><p>创建：{displayTime(key.createdAt, "—")} · 过期：{displayTime(key.expiresAt, "永不过期")}</p>
          <p>最后使用：{displayTime(key.lastUsedAt, "尚未使用")}{key.revokedAt && ` · 撤销：${displayTime(key.revokedAt, "—")}`}</p></div>
          <button className="danger-button" disabled={busy || Boolean(key.revokedAt)} onClick={() => revoke(key)} aria-label={`撤销密钥 ${key.name}`}>撤销密钥</button></li>)}</ul>
        : <p>暂无 API 密钥。</p>}
    </section>
    <section className="panel collection-panel"><h2>在脚本中调用</h2><p>将密钥保存到环境变量 JSONBIN_TOKEN，再发送 Authorization 请求头。</p>
      <pre className="key-example">{`curl '${window.location.origin}/api/v1/bins' \\\n  -H "Authorization: Bearer $JSONBIN_TOKEN"`}</pre>
    </section>
  </section>;
}
