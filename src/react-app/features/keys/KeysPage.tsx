import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createKey, KeyApiError, listKeys, purgeKey, revealKeyToken, revokeKey, scopes, scopeLabels, updateKey } from "./api";
import type { ApiKey, ApiScope } from "./api";
import { useConfirm } from "../../components/ConfirmDialog";
import { CopyButton } from "../../components/CopyButton";
const defaultScopes: ApiScope[] = ["bin:read"];
const displayTime = (value: string | null, fallback: string) => value ? new Date(value).toLocaleString("zh-CN") : fallback;
const toLocalInput = (iso: string) => { const d = new Date(iso); const pad = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
type EditState = { id: string; name: string; scopes: ApiScope[]; resourceMode: "all" | "restricted"; binIdsText: string; collectionIdsText: string; expiration: string; rateLimitText: string };
export function KeysPage({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const client = useQueryClient(), mounted = useRef(false);
  const confirm = useConfirm();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const query = useQuery({ queryKey: ["keys"], queryFn: ({ signal }) => listKeys(signal), retry: false });
  const [name, setName] = useState(""), [selected, setSelected] = useState<ApiScope[]>(defaultScopes), [expiration, setExpiration] = useState("");
  const [rateLimitText, setRateLimitText] = useState("");
  const [resourceMode, setResourceMode] = useState<"all" | "restricted">("all");
  const [binIdsText, setBinIdsText] = useState("");
  const [collectionIdsText, setCollectionIdsText] = useState("");
  const [disclosure, setDisclosure] = useState<{ key: ApiKey; token: string } | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState<Error | null>(null), [notice, setNotice] = useState("");
  const dirty = Boolean(editing) || Boolean(name || expiration || rateLimitText || resourceMode !== "all" || binIdsText || collectionIdsText || JSON.stringify(selected) !== JSON.stringify(defaultScopes));
  useEffect(() => { onDirtyChange(dirty || busy); }, [dirty, busy, onDirtyChange]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, busy]);
  function report(caught: unknown) {
    if (mounted.current) {
      if (caught instanceof KeyApiError) {
        if (caught.status === 422) {
          setError(new Error("请检查名称、权限、资源范围 UUID 格式和未来的过期时间。"));
          return;
        }
      }
      setError(caught instanceof Error ? caught : new Error("操作失败，请重试。"));
    }
  }
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
      const binIds = binIdsText.split(/[,，\s]+/).map(v => v.trim()).filter(Boolean);
      const collectionIds = collectionIdsText.split(/[,，\s]+/).map(v => v.trim()).filter(Boolean);
      const resourceAccess = resourceMode === "all" ? { mode: "all" as const } : { mode: "restricted" as const, binIds, collectionIds };
      const parsedLimit = rateLimitText.trim() === "" ? undefined : Number(rateLimitText);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 0 || parsedLimit > 10000)) { setError(new Error("限流必须是 0～10000 的整数（0 表示不限）。")); return; }
      const created = await createKey({ name, scopes: selected, expiresAt, resourceAccess, ...(parsedLimit === undefined ? {} : { rateLimitPerMinute: parsedLimit === 0 ? null : parsedLimit }) });
      if (!mounted.current) return;
      setDisclosure(created); setName(""); setSelected(defaultScopes); setExpiration(""); setRateLimitText("");
      setResourceMode("all"); setBinIdsText(""); setCollectionIdsText("");
      await client.invalidateQueries({ queryKey: ["keys"] });
    } catch (caught) { report(caught); } finally { if (mounted.current) setBusy(false); }
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
  function startEdit(key: ApiKey) {
    setEditing({
      id: key.id,
      name: key.name,
      scopes: [...key.scopes],
      resourceMode: key.resourceAccess?.mode === "restricted" ? "restricted" : "all",
      binIdsText: key.resourceAccess?.mode === "restricted" ? key.resourceAccess.binIds.join("\n") : "",
      collectionIdsText: key.resourceAccess?.mode === "restricted" ? key.resourceAccess.collectionIds.join("\n") : "",
      expiration: key.expiresAt ? toLocalInput(key.expiresAt) : "",
      rateLimitText: key.rateLimitPerMinute === null || key.rateLimitPerMinute === undefined ? "" : String(key.rateLimitPerMinute),
    });
    setError(null); setNotice("");
  }
  async function saveEdit() {
    if (busy || !editing) return;
    const original = query.data?.items.find(item => item.id === editing.id);
    if (!original) return;
    // expiresAt 只有被明确修改时才提交：undefined 表示不变，null 表示清除。
    let expiresAt: string | null | undefined;
    const originalLocal = original.expiresAt ? toLocalInput(original.expiresAt) : "";
    if (editing.expiration !== originalLocal) {
      if (!editing.expiration) expiresAt = null;
      else {
        const date = new Date(editing.expiration);
        if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) { setError(new Error("过期时间必须在未来。")); return; }
        expiresAt = date.toISOString();
      }
    }
    const binIds = editing.binIdsText.split(/[,，\s]+/).map(v => v.trim()).filter(Boolean);
    const collectionIds = editing.collectionIdsText.split(/[,，\s]+/).map(v => v.trim()).filter(Boolean);
    setBusy(true); setError(null); setNotice("");
    try {
      let rateLimitPerMinute: number | null | undefined;
      if (editing.rateLimitText.trim() !== "") {
        const parsed = Number(editing.rateLimitText);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10000) { setError(new Error("限流必须是 0～10000 的整数（0 表示不限）。")); return; }
        rateLimitPerMinute = parsed === 0 ? null : parsed;
      }
      await updateKey(editing.id, {
        name: editing.name,
        scopes: editing.scopes,
        expiresAt,
        ...(rateLimitPerMinute === undefined ? {} : { rateLimitPerMinute }),
        resourceAccess: editing.resourceMode === "all" ? { mode: "all" } : { mode: "restricted", binIds, collectionIds },
      });
      if (!mounted.current) return;
      setEditing(null); setNotice(`密钥“${original.name}”已更新，新的权限立即对后续请求生效。`);
      await client.invalidateQueries({ queryKey: ["keys"] });
    } catch (caught) {
      if (caught instanceof KeyApiError && caught.status === 409 && mounted.current) setError(caught);
      else report(caught);
    } finally { if (mounted.current) setBusy(false); }
  }
  async function revoke(key: ApiKey) {
    if (busy || key.revokedAt || !await confirm({
      title: "撤销 API 密钥",
      message: `撤销“${key.name}”后，使用此密钥的新请求将无法通过认证，但记录仍会保留。`,
      confirmLabel: "撤销密钥",
      danger: true,
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
    if (busy || !await confirm({
      title: "永久删除 API 密钥",
      message: `确定要永久删除“${key.name}”吗？删除后记录和保存的完整密钥都无法恢复。`,
      confirmLabel: "永久删除",
      danger: true,
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
      {error instanceof KeyApiError && error.status === 401 && <button className="secondary-button" onClick={async () => {
        if (!dirty || await confirm({
          title: "重新登录？",
          message: "重新登录会离开当前页面，未保存的表单内容将丢失。",
          confirmLabel: "重新登录",
          cancelLabel: "继续编辑",
          danger: true,
        })) client.invalidateQueries({ queryKey: ["auth-me"] });
      }}>重新登录</button>}</div>}
    {disclosure && <section className="panel detail-form key-disclosure" aria-label="新密钥明文"><h2>新密钥已创建</h2>
      <p>“{disclosure.key.name}”现在可以直接复制；关闭此提示或刷新页面后，也可以在下方密钥列表中重新显示。</p>
      <label>新 API 密钥<input aria-label="新 API 密钥" readOnly type="text" spellCheck={false} autoComplete="off" value={disclosure.token} onFocus={event => event.target.select()} /></label>
      <div className="detail-actions"><CopyButton label="复制密钥" value={disclosure.token} />
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
      <fieldset className="key-scopes" disabled={busy}>
        <legend>资源范围</legend>
        <label className="schema-checkbox">
          <input type="radio" name="resource-mode" value="all" checked={resourceMode === "all"} onChange={() => setResourceMode("all")} />
          <span>所有资源</span>
        </label>
        <label className="schema-checkbox">
          <input type="radio" name="resource-mode" value="restricted" checked={resourceMode === "restricted"} onChange={() => setResourceMode("restricted")} />
          <span>限制资源</span>
        </label>
        {resourceMode === "restricted" && <div className="detail-form" style={{ padding: 0, marginTop: "12px" }}>
          <label>允许的 Bin ID
            <textarea aria-label="允许的 Bin ID" value={binIdsText} onChange={e => setBinIdsText(e.target.value)} placeholder="每行或用逗号分隔 UUID" />
          </label>
          <label>允许的 Collection ID
            <textarea aria-label="允许的 Collection ID" value={collectionIdsText} onChange={e => setCollectionIdsText(e.target.value)} placeholder="每行或用逗号分隔 UUID" />
          </label>
          <p>限制模式下，直接授权的 Bin 或当前位于授权 Collection 中的 Bin 可访问；Bin 移出集合后权限立即失效。</p>
        </div>}
      </fieldset>
      <label>过期时间<input aria-label="过期时间" type="datetime-local" disabled={busy} value={expiration} onChange={event => setExpiration(event.target.value)} /></label>
      <label>限流（请求/分钟）<input aria-label="限流" type="number" min={0} max={10000} placeholder="默认 120，0 表示不限" disabled={busy} value={rateLimitText} onChange={event => setRateLimitText(event.target.value)} /></label>
      <p>留空表示不过期；时间按当前设备时区输入。查看集合内数据仓需要 collection:read 和 bin:read；恢复历史版本需要 bin:update 和 history:read。密钥管理仅支持网页登录。</p>
      <button className="primary-button" type="submit" disabled={busy || !name.trim() || !selected.length}>{busy ? "正在处理…" : "创建密钥"}</button>
    </form>
    <section className="panel collection-panel" aria-label="已创建的 API 密钥"><h2>已创建的密钥 · {query.data?.total ?? 0} 个</h2>
      {query.isPending ? <p role="status">正在加载密钥…</p> : query.isError ? <><p role="alert">{query.error.message}</p>
        <button className="secondary-button" onClick={() => query.refetch()}>重试密钥列表</button></> : query.data.items.length ?
        <ul className="key-list">{query.data.items.map(key => <li key={key.id}><div className="key-card-main"><h3>{key.name}</h3><code>{key.prefix}</code>
          <p>状态：{key.revokedAt ? "已撤销" : key.expiresAt && Date.parse(key.expiresAt) <= Date.now() ? "已过期" : "有效"}</p>
          <p>权限：{key.scopes.join(" · ")}</p>
          <p>资源范围：{key.resourceAccess?.mode === "restricted" ? `${key.resourceAccess.binIds.length} 个 Bin · ${key.resourceAccess.collectionIds.length} 个 Collection` : "所有资源"}</p>
          <p>创建：{displayTime(key.createdAt, "—")} · 过期：{displayTime(key.expiresAt, "永不过期")}</p>
          <p>最后使用：{displayTime(key.lastUsedAt, "尚未使用")}{key.revokedAt && ` · 撤销：${displayTime(key.revokedAt, "—")}`}</p>
          <p>限流：{key.rateLimitPerMinute === null ? "不限" : `${key.rateLimitPerMinute ?? 120} 次/分钟`}</p>
          <div style={{ marginTop: "8px", padding: "6px 10px", background: "var(--border)", borderRadius: "4px", fontSize: "12px", display: "flex", gap: "16px" }}>
            <span>已授权总请求：<strong>约 {key.usageTotal ?? 0}</strong> 次</span>
            <span>今日已授权：<strong>约 {key.usageDaily?.[new Date().toISOString().slice(0, 10)] ?? 0}</strong> 次</span>
          </div>
          <p className="usage-note">使用统计为近似值，可能延迟；不参与权限或限流判定。
            {key.usageStatus === "unavailable" ? " 当前统计暂不可用，展示已保存的历史数字。" :
              key.usageStatus === "delayed" ? " 历史增量正在等待日结。" :
              key.usageAsOf ? ` 最近读取：${displayTime(key.usageAsOf, "—")}。` : ""}
          </p>
          {revealed[key.id] && <label className="key-revealed">完整密钥<input aria-label={`API 密钥 ${key.name}`} readOnly type="text" spellCheck={false} autoComplete="off" value={revealed[key.id]} onFocus={event => event.target.select()} /></label>}
          {!key.revealable && <p className="key-unavailable">此密钥创建于旧版本，完整明文当时没有保存；它仍可继续用于 API，若需要查看完整值请新建替代密钥。</p>}
        </div>
          {editing?.id === key.id && <form className="detail-form key-edit-form" style={{ borderTop: "1px solid var(--border)", marginTop: "12px", paddingTop: "12px" }}
            onSubmit={event => { event.preventDefault(); saveEdit(); }}>
            <label>密钥名称<input aria-label={`编辑名称 ${key.name}`} required maxLength={160} disabled={busy} value={editing.name}
              onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
            <fieldset className="key-scopes" disabled={busy}><legend>权限 Scope</legend>
              {scopes.map(scope => <label className="schema-checkbox" key={scope}><input type="checkbox" aria-label={`编辑 ${scope} ${key.name}`}
                checked={editing.scopes.includes(scope)}
                onChange={event => setEditing({ ...editing, scopes: scopes.filter(item => item === scope ? event.target.checked : editing.scopes.includes(item)) })} />
                <span>{scopeLabels[scope]} <code>{scope}</code></span></label>)}
            </fieldset>
            <fieldset className="key-scopes" disabled={busy}>
              <legend>资源范围</legend>
              <label className="schema-checkbox">
                <input type="radio" name={`resource-mode-${key.id}`} value="all" checked={editing.resourceMode === "all"} onChange={() => setEditing({ ...editing, resourceMode: "all" })} />
                <span>所有资源</span>
              </label>
              <label className="schema-checkbox">
                <input type="radio" name={`resource-mode-${key.id}`} value="restricted" checked={editing.resourceMode === "restricted"} onChange={() => setEditing({ ...editing, resourceMode: "restricted" })} />
                <span>限制资源</span>
              </label>
              {editing.resourceMode === "restricted" && <div style={{ marginTop: "12px" }}>
                <label>允许的 Bin ID<textarea aria-label={`编辑允许的 Bin ID ${key.name}`} value={editing.binIdsText} onChange={e => setEditing({ ...editing, binIdsText: e.target.value })} placeholder="每行或用逗号分隔 UUID" /></label>
                <label>允许的 Collection ID<textarea aria-label={`编辑允许的 Collection ID ${key.name}`} value={editing.collectionIdsText} onChange={e => setEditing({ ...editing, collectionIdsText: e.target.value })} placeholder="每行或用逗号分隔 UUID" /></label>
              </div>}
            </fieldset>
            <label>过期时间<input aria-label={`编辑过期时间 ${key.name}`} type="datetime-local" disabled={busy} value={editing.expiration}
              onChange={event => setEditing({ ...editing, expiration: event.target.value })} /></label>
            <label>限流（请求/分钟，留空保持不变，0 表示不限）<input aria-label={`编辑限流 ${key.name}`} type="number" min={0} max={10000} disabled={busy} value={editing.rateLimitText}
              onChange={event => setEditing({ ...editing, rateLimitText: event.target.value })} placeholder="默认 120" /></label>
            <p>修改立即对后续请求生效，使用统计与已保存的密钥值保持不变；清空过期时间表示永不过期。</p>
            <div className="detail-actions">
              <button className="primary-button" type="submit" disabled={busy || !editing.name.trim() || !editing.scopes.length}>{busy ? "正在保存…" : "保存修改"}</button>
              <button className="secondary-button" type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button>
            </div>
          </form>}
          <div className="key-card-actions">
            {key.revealable && <button className="secondary-button" type="button" disabled={busy} onClick={() => toggleReveal(key)}
              aria-label={`${revealed[key.id] ? "隐藏密钥" : "显示密钥"} ${key.name}`}>{revealed[key.id] ? "隐藏密钥" : "显示密钥"}</button>}
            {key.revealable && <CopyButton label="复制密钥" ariaLabel={`复制密钥 ${key.name}`} disabled={busy}
              value={async () => revealed[key.id] ?? (await revealKeyToken(key.id)).token} />}
            {!key.revokedAt && <button className="secondary-button" type="button" disabled={busy} onClick={() => editing?.id === key.id ? setEditing(null) : startEdit(key)}
              aria-label={`编辑权限 ${key.name}`}>{editing?.id === key.id ? "取消编辑" : "编辑权限"}</button>}
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
