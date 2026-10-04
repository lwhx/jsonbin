import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createKey, KeyApiError, listKeys, purgeKey, revealKeyToken, revokeKey, scopes, scopeLabels } from "./api";
import type { ApiKey, ApiScope } from "./api";
import { confirmDialog } from "../../components/ConfirmDialog";
const defaultScopes: ApiScope[] = ["bin:read"];
const displayTime = (value: string | null, fallback: string) => value ? new Date(value).toLocaleString("zh-CN") : fallback;
export function KeysPage({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const client = useQueryClient(), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const query = useQuery({ queryKey: ["keys"], queryFn: ({ signal }) => listKeys(signal), retry: false });
  const [name, setName] = useState(""), [selected, setSelected] = useState<ApiScope[]>(defaultScopes), [expiration, setExpiration] = useState("");
  const [disclosure, setDisclosure] = useState<{ key: ApiKey; token: string } | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState<Error | null>(null), [notice, setNotice] = useState("");
  const dirty = Boolean(name || expiration || JSON.stringify(selected) !== JSON.stringify(defaultScopes));
  useEffect(() => { onDirtyChange(dirty || busy); }, [dirty, busy, onDirtyChange]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, busy]);
  function report(caught: unknown) { if (mounted.current) setError(caught instanceof Error ? caught : new Error("操作失败，请重试。")); }
  function hideToken(id: string) {
    setRevealed(previous => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }
  async function create() {
    if (busy) return;
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
    try { await navigator.clipboard.writeText(disclosure.token); if (mounted.current) setNotice("密钥已复制。以后也可以从密钥列表重新查看或复制。"); }
    catch { if (mounted.current) setError(new Error("无法访问剪贴板，请手动选择并复制密钥。")); }
  }
  async function toggleReveal(key: ApiKey) {
    if (revealed[key.id]) { hideToken(key.id); return; }
    if (busy || !key.revealable) return;
    setBusy(true); setError(null); setNotice("");
    try {
      const result = await revealKeyToken(key.id);
      if (mounted.current) setRevealed(previous => ({ ...previous, [key.id]: result.token }));
    } catch (caught) { report(caught); } finally { if (mounted.current) setBusy(false); }
  }
  async function copyStored(key: ApiKey) {
    if (busy || !key.revealable) return;
    setBusy(true); setError(null); setNotice("");
    try {
      const token = revealed[key.id] ?? (await revealKeyToken(key.id)).token;
      await navigator.clipboard.writeText(token);
      if (mounted.current) setNotice(`密钥“${key.name}”已复制。`);
    } catch (caught) {
      if (caught instanceof KeyApiError) report(caught);
      else if (mounted.current) setError(new Error("无法访问剪贴板，请显示密钥后手动复制。"));
    } finally { if (mounted.current) setBusy(false); }
  }
  async function revoke(key: ApiKey) {
    if (busy || key.revokedAt) return;
    if (!await confirmDialog({
      title: "撤销 API 密钥？",
      message: `确定要撤销“${key.name}”吗？`,
      details: ["撤销后该 Token 会立即失效。", "密钥记录仍会保留，之后仍可永久删除。"],
      cancelLabel: "取消",
      confirmLabel: "撤销密钥",
      tone: "danger",
    })) return;
    setBusy(true); setError(null); setNotice("");
    try {
      await revokeKey(key.id); await client.invalidateQueries({ queryKey: ["keys"] });
      if (!mounted.current) return;
      if (disclosure?.key.id === key.id) setDisclosure(null);
      hideToken(key.id);
      setNotice("密钥已撤销。");
    } catch (caught) { report(caught); } finally { if (mounted.current) setBusy(false); }
  }
  async function remove(key: ApiKey) {
    if (busy) return;
    if (!await confirmDialog({
      title: "永久删除 API 密钥",
      message: `确定要永久删除“${key.name}”吗？`,
      details: ["密钥立即失效。", "R2 中的密钥记录会永久删除。", "保存的完整密钥无法恢复。"],
      cancelLabel: "取消",
      confirmLabel: "永久删除",
      tone: "danger",
    })) return;
    setBusy(true); setError(null); setNotice("");
    try {
      await purgeKey(key.id); await client.invalidateQueries({ queryKey: ["keys"] });
      if (!mounted.current) return;
      if (disclosure?.key.id === key.id) setDisclosure(null);
      hideToken(key.id);
      setNotice("密钥已永久删除。");
    } catch (caught) { report(caught); } finally { if (mounted.current) setBusy(false); }
  }
  return <section className="keys-page"><header className="hero bins-hero"><div><span className="eyebrow">开发者</span><h1>API 密钥</h1>
    <p>为脚本或应用创建 Bearer Token，按所需权限授予访问。新建密钥的完整 Token 会加密保存，可随时重新显示或复制。bin:delete 包括回收站永久删除；恢复需 bin:update 和 history:read。</p></div>
    <button className="secondary-button" disabled={busy} onClick={() => query.refetch()}>刷新密钥列表</button></header>
    {notice && <p className="detail-notice" role="status">{notice}</p>}
    {error && <div className="detail-error" role="alert">{error.message}
      {error instanceof KeyApiError && error.status === 401 && <button className="secondary-button" onClick={() => { void (async () => {
        if (dirty && !await confirmDialog({
          title: "重新登录？",
          message: "重新登录会离开当前页面，未保存的密钥表单内容将丢失。",
          cancelLabel: "继续编辑",
          confirmLabel: "放弃并重新登录",
          tone: "danger",
        })) return;
        client.invalidateQueries({ queryKey: ["auth-me"] });
      })(); }}>重新登录</button>}</div>}
    {disclosure && <section className="panel detail-form key-disclosure" aria-label="新密钥明文"><h2>新密钥已创建</h2>
      <p>“{disclosure.key.name}”现在可以直接复制；关闭此提示或刷新页面后，也可以在下方密钥列表中重新显示。</p>
      <label>新 API 密钥<input aria-label="新 API 密钥" readOnly type="text" spellCheck={false} autoComplete="off" value={disclosure.token} onFocus={event => event.target.select()} /></label>
      <div className="detail-actions"><button className="secondary-button" type="button" onClick={copy}>复制密钥</button>
        <button className="primary-button" type="button" onClick={() => { setDisclosure(null); setNotice("提示已关闭，需要时可从密钥列表重新查看。"); }}>关闭</button></div>
    </section>}
    <form className="panel detail-form" onSubmit={event => { event.preventDefault(); create(); }}>
      <h2>创建 API 密钥</h2>
      <label>密钥名称<input aria-label="密钥名称" required maxLength={160} disabled={busy} value={name} autoComplete="off" onChange={event => setName(event.target.value)} /></label>
      <fieldset className="key-scopes" disabled={busy}><legend>权限 Scope</legend>
        {scopes.map(scope => <label className="schema-checkbox" key={scope}><input type="checkbox" aria-label={scope} checked={selected.includes(scope)}
          onChange={event => setSelected(previous => scopes.filter(item => item === scope ? event.target.checked : previous.includes(item)))} />
          <span>{scopeLabels[scope]} <code>{scope}</code></span></label>)}
      </fieldset>
      <label>过期时间<input aria-label="过期时间" type="datetime-local" disabled={busy} value={expiration} onChange={event => setExpiration(event.target.value)} /></label>
      <p>留空表示不过期；时间按当前设备时区输入。查看集合内数据仓需要 collection:read 和 bin:read；恢复历史版本需要 bin:update 和 history:read。密钥管理仅支持网页登录。</p>
      <button className="primary-button" type="submit" disabled={busy || !name.trim() || !selected.length}>{busy ? "正在处理…" : "创建密钥"}</button>
    </form>
    <section className="panel collection-panel" aria-label="已创建的 API 密钥"><h2>已创建的密钥 · {query.data?.total ?? 0} 个</h2>
      {query.isPending ? <p role="status">正在加载密钥…</p> : query.isError ? <><p role="alert">{query.error.message}</p>
        <button className="secondary-button" onClick={() => query.refetch()}>重试密钥列表</button></> : query.data.items.length ?
        <ul className="key-list">{query.data.items.map(key => <li key={key.id}><div className="key-card-main"><h3>{key.name}</h3><code>{key.prefix}</code>
          <p>状态：{key.revokedAt ? "已撤销" : key.expiresAt && Date.parse(key.expiresAt) <= Date.now() ? "已过期" : "有效"}</p>
          <p>权限：{key.scopes.join(" · ")}</p><p>创建：{displayTime(key.createdAt, "—")} · 过期：{displayTime(key.expiresAt, "永不过期")}</p>
          <p>最后使用：{displayTime(key.lastUsedAt, "尚未使用")}{key.revokedAt && ` · 撤销：${displayTime(key.revokedAt, "—")}`}</p>
          {revealed[key.id] && <label className="key-revealed">完整密钥<input aria-label={`API 密钥 ${key.name}`} readOnly type="text" spellCheck={false} autoComplete="off" value={revealed[key.id]} onFocus={event => event.target.select()} /></label>}
          {!key.revealable && <p className="key-unavailable">此密钥创建于旧版本，完整明文当时没有保存；它仍可继续用于 API，若需要查看完整值请新建替代密钥。</p>}
        </div>
          <div className="key-card-actions">
            {key.revealable && <button className="secondary-button" type="button" disabled={busy} onClick={() => toggleReveal(key)}
              aria-label={`${revealed[key.id] ? "隐藏密钥" : "显示密钥"} ${key.name}`}>{revealed[key.id] ? "隐藏密钥" : "显示密钥"}</button>}
            {key.revealable && <button className="secondary-button" type="button" disabled={busy} onClick={() => copyStored(key)}
              aria-label={`复制密钥 ${key.name}`}>复制密钥</button>}
            <button className="danger-button" disabled={busy || Boolean(key.revokedAt)} onClick={() => revoke(key)} aria-label={`撤销密钥 ${key.name}`}>撤销密钥</button>
            <button className="danger-button" disabled={busy} onClick={() => remove(key)} aria-label={`删除密钥 ${key.name}`}>删除密钥</button>
          </div></li>)}</ul>
        : <p>暂无 API 密钥。</p>}
    </section>
    <section className="panel collection-panel"><h2>在脚本中调用</h2><p>将密钥保存到环境变量 JSONBIN_TOKEN，再发送 Authorization 请求头。</p>
      <pre className="key-example">{`curl '${window.location.origin}/api/v1/bins' \\\n  -H "Authorization: Bearer $JSONBIN_TOKEN"`}</pre>
    </section>
  </section>;
}
