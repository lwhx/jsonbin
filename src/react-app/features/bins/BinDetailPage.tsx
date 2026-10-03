import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, Save, Trash2, Braces, RefreshCw } from "lucide-react";
import { BinApiError, getBin, removeBin, saveBin, saveBinMetadata, restoreBinVersion } from "./api";
import { createDraft, isDirty, parseJson, receiveRecord, savedDraft } from "./editor-state";
import type { Draft } from "./editor-state";
import type { BinRecord, MetadataInput } from "./types";

const JsonEditor = lazy(() => import("./JsonEditor"));
const BinHistory = lazy(() => import("./BinHistory"));
type Tab = "编辑器" | "历史版本" | "API" | "设置";
function metadataOf(record: BinRecord): MetadataInput {
  const { name, description, visibility } = record.meta;
  return { name, description, visibility };
}

export function BinDetailPage({ id, dark, onBack, onDeleted, onDirtyChange }: {
  id: string; dark: boolean; onBack: () => void; onDeleted: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["bin", id], queryFn: ({ signal }) => getBin(id, undefined, signal), retry: false });
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [metadata, setMetadata] = useState<MetadataInput | null>(null);
  const [tab, setTab] = useState<Tab>("编辑器");
  const [busy, setBusy] = useState<"json" | "metadata" | "delete" | "reload" | "restore" | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteDialog = useRef<HTMLDivElement>(null);
  const metadataDirty = Boolean(draft && metadata && JSON.stringify(metadata) !== JSON.stringify(metadataOf(draft.record)));
  const dirty = Boolean(draft && (isDirty(draft) || metadataDirty));

  useEffect(() => {
    if (!query.data) return;
    // An automatic refresh must never replace either JSON or metadata drafts.
    setDraft(previous => previous && (isDirty(previous) || metadataDirty) ? previous : previous ? receiveRecord(previous, query.data!) : createDraft(query.data!));
    if (!dirty) setMetadata(metadataOf(query.data));
  }, [query.data]);
  useEffect(() => { onDirtyChange(dirty || Boolean(busy)); }, [dirty, busy, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  useEffect(() => {
    if (!deleteOpen) return;
    const dialog = deleteDialog.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    const focusInside = () => {
      const button = dialog.querySelector<HTMLButtonElement>("button:not(:disabled)");
      (button ?? dialog).focus();
    };
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) focusInside();
    };
    focusInside();
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("focusin", containFocus);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [deleteOpen]);
  useEffect(() => {
    if (deleteOpen && busy === "delete") deleteDialog.current?.focus();
  }, [deleteOpen, busy]);

  function report(caught: unknown) { setError(caught instanceof Error ? caught : new Error("操作失败，请稍后重试。")); }
  async function refresh() {
    if (busy || (dirty && !window.confirm("重新加载会丢弃未保存的内容，是否继续？"))) return;
    setBusy("reload"); setError(null); setNotice("");
    try {
      await client.cancelQueries({ queryKey: ["bin", id] });
      const record = await getBin(id);
      if (!mounted.current) return;
      await client.cancelQueries({ queryKey: ["bin", id] });
      if (!mounted.current) return;
      setDraft(createDraft(record)); setMetadata(metadataOf(record));
      client.setQueryData(["bin", id], record);
    } catch (caught) { report(caught); } finally { setBusy(null); }
  }
  async function saveJson() {
    if (!draft || busy) return;
    const parsed = parseJson(draft.text); if (!parsed.valid) return;
    const submittedText = draft.text;
    setBusy("json"); setError(null); setNotice("");
    try {
      await client.cancelQueries({ queryKey: ["bin", id] });
      const record = await saveBin(id, parsed.value, draft.record.etag);
      if (!mounted.current) return;
      await client.cancelQueries({ queryKey: ["bin", id] });
      if (!mounted.current) return;
      setDraft(previous => previous ? savedDraft(previous, record, submittedText) : createDraft(record));
      client.setQueryData(["bin", id], record);
      await client.invalidateQueries({ queryKey: ["bins"] });
      setNotice("保存成功，已生成新的版本。");
    } catch (caught) { report(caught); } finally { setBusy(null); }
  }
  async function saveSettings() {
    if (!draft || !metadata || busy) return;
    setBusy("metadata"); setError(null); setNotice("");
    try {
      await client.cancelQueries({ queryKey: ["bin", id] });
      const record = await saveBinMetadata(id, metadata, draft.record.etag);
      if (!mounted.current) return;
      await client.cancelQueries({ queryKey: ["bin", id] });
      if (!mounted.current) return;
      setDraft(previous => previous ? savedDraft(previous, record, previous.savedText) : createDraft(record));
      setMetadata(metadataOf(record)); client.setQueryData(["bin", id], record);
      await client.invalidateQueries({ queryKey: ["bins"] });
      setNotice("设置保存成功，JSON 版本保持不变。");
    } catch (caught) { report(caught); } finally { setBusy(null); }
  }
  async function restore(version: number) {
    if (!draft || busy || draft.record.meta.locked) return;
    if (!window.confirm(`将 v${version} 的内容恢复为新的最新版本？${dirty ? "未保存的 JSON 和设置修改将被丢弃。" : "已有历史版本不会改变。"}`)) return;
    setBusy("restore"); setError(null); setNotice("");
    try {
      await client.cancelQueries({ queryKey: ["bin", id] });
      const record = await restoreBinVersion(id, version, draft.record.etag);
      if (!mounted.current) return;
      await client.cancelQueries({ queryKey: ["bin", id] });
      if (!mounted.current) return;
      setDraft(createDraft(record)); setMetadata(metadataOf(record));
      client.setQueryData(["bin", id], record);
      await client.invalidateQueries({ queryKey: ["bins"] });
      await client.invalidateQueries({ queryKey: ["bin-versions", id] });
      setNotice(`已恢复 v${version}，生成新版本 v${record.meta.currentVersion}。`);
    } catch (caught) { report(caught); } finally { setBusy(null); }
  }
  async function confirmDelete() {
    if (busy) return;
    setBusy("delete"); setError(null);
    try {
      await removeBin(id);
      await client.invalidateQueries({ queryKey: ["bins"] });
      client.removeQueries({ queryKey: ["bin", id] });
      if (!mounted.current) return;
      onDirtyChange(false); onDeleted();
    } catch (caught) { report(caught); setDeleteOpen(false); } finally { setBusy(null); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice("已复制。"); }
    catch { setError(new Error("无法访问剪贴板，请手动选择并复制。")); }
  }

  if (!draft) return <section className="panel detail-empty">
    <button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={16} />返回数据仓</button>
    {query.isError ? <><h1>无法打开数据仓</h1><p role="alert">{query.error.message}</p>
      <button className="secondary-button" onClick={() => query.refetch()}>重试</button></> : <p role="status">正在加载数据仓…</p>}
  </section>;

  const record = draft.record;
  const parsed = parseJson(draft.text);
  const apiUrl = `${window.location.origin}/api/v1/bins/${encodeURIComponent(id)}`;
  const locked = record.meta.locked;
  return <section className="bin-detail">
    <div className="detail-actions">
      <button type="button" className="secondary-button" onClick={onBack} disabled={Boolean(busy)}><ArrowLeft size={16} />返回数据仓</button>
      <button type="button" className="secondary-button" onClick={refresh} disabled={Boolean(busy)}><RefreshCw size={15} />重新加载</button>
    </div>
    <header className="detail-heading">
      <div><span className="eyebrow">数据仓详情</span><h1>{record.meta.name}</h1><p>{record.meta.description || "暂无描述"}</p></div>
      <div className="detail-badges"><span className={`visibility-pill ${record.meta.visibility}`}>{record.meta.visibility === "private" ? "私有" : "公开"}</span>
        {dirty && <span className="dirty-badge">未保存</span>}{locked && <span>已锁定</span>}</div>
    </header>
    <div className="detail-info"><span>v{record.meta.currentVersion}</span><span>{record.meta.size} B</span>
      <span>更新于 {new Date(record.meta.updatedAt).toLocaleString("zh-CN")}</span></div>
    <div className="detail-id"><code>{id}</code><button type="button" className="secondary-button" onClick={() => copy(id)}><Copy size={14} />复制 Bin ID</button>
      <button type="button" className="secondary-button" onClick={() => copy(apiUrl)}><Copy size={14} />复制 API 地址</button></div>
    {notice && <p className="detail-notice" role="status">{notice}</p>}
    {error && <div className="detail-error" role="alert">{error.message}
      {error instanceof BinApiError && error.status === 412 && <button type="button" className="secondary-button" onClick={refresh}>重新加载最新版本</button>}
      {error instanceof BinApiError && error.status === 401 && <button type="button" className="secondary-button" onClick={() => {
        if (!dirty || window.confirm("重新登录会离开当前页面，是否放弃未保存的内容？")) client.invalidateQueries({ queryKey: ["auth-me"] });
      }}>重新登录</button>}
    </div>}
    <div className="detail-tabs" role="tablist" aria-label="数据仓详情">
      {(["编辑器", "树形视图", "历史版本", "API", "设置"] as const).map(item => {
        const disabled = item === "树形视图";
        return <button key={item} type="button" role="tab" aria-selected={tab === item} disabled={disabled}
          onClick={() => !disabled && setTab(item as Tab)}>{item}{disabled && <small>即将推出</small>}</button>;
      })}
    </div>
    <div className="panel detail-panel" role="tabpanel" aria-label={tab}>
      {tab === "编辑器" && <>
        <div className="editor-toolbar"><span>JSON</span>
          <button type="button" className="secondary-button" disabled={!parsed.valid || Boolean(busy) || locked}
            onClick={() => parsed.valid && setDraft({ ...draft, text: JSON.stringify(parsed.value, null, 2) })}><Braces size={15} />格式化</button>
          <button type="button" className="primary-button" disabled={!parsed.valid || !isDirty(draft) || Boolean(busy) || locked} onClick={saveJson}><Save size={15} />{busy === "json" ? "正在保存…" : "保存 JSON"}</button>
        </div>
        {!parsed.valid && <p className="detail-error" role="alert">{parsed.error}</p>}
        <Suspense fallback={<p role="status">正在加载 JSON 编辑器…</p>}>
          <JsonEditor value={draft.text} onChange={text => { setDraft(previous => previous ? { ...previous, text } : previous); setNotice(""); }} readOnly={locked || Boolean(busy)} dark={dark} />
        </Suspense>
      </>}
      {tab === "历史版本" && <Suspense fallback={<p role="status">正在加载版本历史…</p>}>
        <BinHistory record={record} dark={dark} busy={Boolean(busy)} onRestore={restore} />
      </Suspense>}
      {tab === "API" && <div className="bin-api"><h2>此数据仓的 API</h2><p>当前使用管理界面的 Session 认证；外部 API Key 调用将在后续阶段提供。</p>
        <pre>{`GET ${apiUrl}\n\nPUT ${apiUrl}\nContent-Type: application/json\nIf-Match: ${record.etag}\n\n${JSON.stringify({ value: record.value }, null, 2)}`}</pre>
        <p>写入成功生成新版本；ETag 过期返回 412，锁定返回 423。</p></div>}
      {tab === "设置" && metadata && <form className="detail-form" onSubmit={event => { event.preventDefault(); saveSettings(); }}>
        <label>名称<input required maxLength={160} value={metadata.name} disabled={Boolean(busy) || locked} onChange={event => setMetadata({ ...metadata, name: event.target.value })} /></label>
        <label>描述<textarea maxLength={1000} value={metadata.description} disabled={Boolean(busy) || locked} onChange={event => setMetadata({ ...metadata, description: event.target.value })} /></label>
        <label>可见性<select aria-label="可见性" value={metadata.visibility} disabled={Boolean(busy) || locked} onChange={event => setMetadata({ ...metadata, visibility: event.target.value as "private" | "public" })}><option value="private">私有</option><option value="public">公开</option></select></label>
        <p>当前所有读取仍需登录；公开只读访问将在后续阶段提供。</p>
        <button type="submit" className="primary-button" disabled={!metadataDirty || !metadata.name.trim() || Boolean(busy) || locked}><Save size={15} />保存设置</button>
      </form>}
    </div>
    <footer className="detail-footer"><p>删除后元数据移入回收站，历史版本保留。</p>
      <button type="button" className="danger-button" onClick={() => setDeleteOpen(true)} disabled={Boolean(busy)}><Trash2 size={15} />删除数据仓</button></footer>
    {deleteOpen && <div className="dialog-backdrop"><div ref={deleteDialog} tabIndex={-1} className="dialog delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title"
      onKeyDown={event => {
        if (event.key === "Escape" && !busy) { event.preventDefault(); setDeleteOpen(false); }
        if (event.key !== "Tab") return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const first = buttons[0];
        const last = buttons.at(-1);
        if (!first) { event.preventDefault(); event.currentTarget.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
          event.preventDefault(); last!.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
          event.preventDefault(); first.focus();
        }
      }}>
      <h2 id="delete-title">删除数据仓？</h2><p>“{record.meta.name}”将移入回收站。{dirty && "未保存的修改将被丢弃。"}</p>
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => setDeleteOpen(false)}>取消</button>
        <button type="button" className="danger-button" disabled={Boolean(busy)} onClick={confirmDelete}>{busy === "delete" ? "正在删除…" : "确认删除"}</button></div>
    </div></div>}
  </section>;
}
