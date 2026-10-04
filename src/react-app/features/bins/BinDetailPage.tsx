import { systemApi } from '../settings/api';
import { downloadBytes } from '../settings/download';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, Save, Trash2, Braces, RefreshCw } from "lucide-react";
import { BinApiError, getBin, removeBin, saveBin, saveBinMetadata, restoreBinVersion } from "./api";
import { createDraft, isDirty, parseJson, receiveRecord, savedDraft } from "./editor-state";
import type { Draft } from "./editor-state";
import type { BinRecord, MetadataInput } from "./types";
import { listCollections } from "../collections/api";

import { listSchemas } from "../schemas/api";
import { SchemaIssues } from "../schemas/SchemaIssues";
import { BinApiPanel } from "../docs/BinApiPanel";
import { ExpiryLabel, expiryFromInput, localDateTime } from "./expiry";
import { JsonTree } from './JsonTree';
import { JsonFormEditor } from "./JsonFormEditor";

const JsonEditor = lazy(() => import("./JsonEditor"));
const BinHistory = lazy(() => import("./BinHistory"));
type Tab = "表单编辑" | "编辑器" | "树形视图" | "历史版本" | "API" | "设置";
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function metadataOf(record: BinRecord): MetadataInput {
  const { name, description, visibility, collectionId, schemaId, schemaLocked, expiresAt } = record.meta;
  return { name, description, visibility, collectionId, schemaId, schemaLocked, expiresAt, refreshSchema: false };
}

export function BinDetailPage({ id, dark, onBack, onDeleted, onDirtyChange }: {
  id: string; dark: boolean; onBack: () => void; onDeleted: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["bin", id], queryFn: ({ signal }) => getBin(id, undefined, signal), retry: false });
  const collections = useQuery({ queryKey: ["collections"], queryFn: ({ signal }) => listCollections(signal), retry: false });
  const schemas = useQuery({ queryKey: ["schemas"], queryFn: ({ signal }) => listSchemas(signal), retry: false });
  const mounted = useRef(false);
  const exportController = useRef<AbortController | null>(null), exporting = useRef(false);
  useEffect(() => { mounted.current = true; const cancel = () => exportController.current?.abort(); window.addEventListener("jsonbin:logout", cancel); return () => { mounted.current = false; exportController.current?.abort(); window.removeEventListener("jsonbin:logout", cancel); }; }, []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [metadata, setMetadata] = useState<MetadataInput | null>(null);
  const [tab, setTab] = useState<Tab>("编辑器");
  const [busy, setBusy] = useState<"json" | "metadata" | "delete" | "reload" | "restore" | "lock" | "export" | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [formValid, setFormValid] = useState(true);
  const deleteDialog = useRef<HTMLDivElement>(null);
  const metadataDirty = Boolean(draft && metadata && JSON.stringify(metadata) !== JSON.stringify(metadataOf(draft.record)));
  const dirty = Boolean(draft && (isDirty(draft) || metadataDirty));
  const parsed = useMemo(() => draft ? parseJson(draft.text) : null, [draft?.text]);

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

  async function exportSaved() {
    if (busy || exporting.current) return;
    const abort = new AbortController(); exportController.current = abort; exporting.current = true; setBusy("export"); setError(null);
    try { const bytes = await systemApi.exportData({ scope: 'bin', id, format: 'value' }, abort.signal); if (!mounted.current || abort.signal.aborted) return;
      downloadBytes(bytes, `jsonbin-${id}-value.json`, 'application/json; charset=utf-8'); setNotice('已导出服务器保存的 JSON，草稿保留。');
    } catch (caught) { if (mounted.current && !abort.signal.aborted) report(caught); }
    finally { if (mounted.current) { exporting.current = false; setBusy(null); } }
  }
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
    if (metadata.expiresAt && Date.parse(metadata.expiresAt) <= Date.now()) {
      setError(new Error("到期时间必须晚于当前时间；已到期的数据仓请到回收站恢复。")); return;
    }
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
      await client.invalidateQueries({ queryKey: ["collections"] });
      await client.invalidateQueries({ queryKey: ["collection-bins"] });
      setNotice(metadata.collectionId && record.meta.collectionId === null ? "集合已删除，数据仓已保留在未分组中；JSON 版本保持不变。" : "设置保存成功，JSON 版本保持不变。");
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
    if (busy || !draft || draft.record.meta.locked) return;
    setBusy("delete"); setError(null);
    try {
      await removeBin(id, undefined, draft.record.etag);
      await client.invalidateQueries({ queryKey: ["bins"] });
      client.removeQueries({ queryKey: ["bin", id] });
      await client.invalidateQueries({ queryKey: ["collections"] });
      await client.invalidateQueries({ queryKey: ["collection-bins"] });
      if (!mounted.current) return;
      onDirtyChange(false); onDeleted();
    } catch (caught) { report(caught); setDeleteOpen(false); } finally { setBusy(null); }
  }
  async function toggleLock() {
    if (!draft || busy || dirty) return;
    const locked = !draft.record.meta.locked;
    setBusy("lock"); setError(null); setNotice("");
    try {
      await client.cancelQueries({ queryKey: ["bin", id] });
      const record = await saveBinMetadata(id, { locked }, draft.record.etag);
      if (!mounted.current) return;
      await client.cancelQueries({ queryKey: ["bin", id] });
      if (!mounted.current) return;
      setDraft(createDraft(record)); setMetadata(metadataOf(record));
      client.setQueryData(["bin", id], record);
      await client.invalidateQueries({ queryKey: ["bins"] });
      setNotice(locked ? "数据仓已锁定，修改和删除已禁止；读取不受影响。" : "数据锁已解除，可以继续编辑。模型锁保持不变。");
    } catch (caught) { report(caught); } finally { setBusy(null); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice("已复制。"); }
    catch { setError(new Error("无法访问剪贴板，请手动选择并复制。")); }
  }

  if (!draft || !parsed) return <section className="panel detail-empty">
    <button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={16} />返回数据仓</button>
    {query.isError ? <><h1>无法打开数据仓</h1><p role="alert">{query.error.message}</p>
      <button className="secondary-button" onClick={() => query.refetch()}>重试</button></> : <p role="status">正在加载数据仓…</p>}
  </section>;

  const record = draft.record;
  const apiUrl = `${window.location.origin}/api/v1/bins/${encodeURIComponent(id)}`;
  const locked = record.meta.locked;
  return <section className="bin-detail">
    <div className="detail-actions">
      <button type="button" className="secondary-button" onClick={() => void exportSaved()} disabled={Boolean(busy)}>导出已保存 JSON</button>
      <button type="button" className="secondary-button" onClick={onBack} disabled={Boolean(busy)}><ArrowLeft size={16} />返回数据仓</button>
      <button type="button" className="secondary-button" onClick={refresh} disabled={Boolean(busy)}><RefreshCw size={15} />重新加载</button>
    </div>
    <header className="detail-heading">
      <div><span className="eyebrow">数据仓详情</span><h1>{record.meta.name}</h1><p>{record.meta.description || "暂无描述"}</p></div>
      <div className="detail-badges"><span className={`visibility-pill ${record.meta.visibility}`}>{record.meta.visibility === "private" ? "私有" : "公开"}</span>
        {dirty && <span className="dirty-badge">未保存</span>}{locked && <span>已锁定</span>}</div>
    </header>
    <div className="detail-info"><span>v{record.meta.currentVersion}</span><span>{record.meta.size} B</span>
      <span>更新于 {new Date(record.meta.updatedAt).toLocaleString("zh-CN")}</span><ExpiryLabel expiresAt={record.meta.expiresAt} /></div>
    <div className="detail-id"><code>{id}</code><button type="button" className="secondary-button" onClick={() => copy(id)}><Copy size={14} />复制 Bin ID</button>
      <button type="button" className="secondary-button" onClick={() => copy(apiUrl)}><Copy size={14} />复制 API 地址</button></div>
    {notice && <p className="detail-notice" role="status">{notice}</p>}
    {error && <div className="detail-error" role="alert">{error.message}
      {error instanceof BinApiError && <SchemaIssues issues={error.issues} />}
      {error instanceof BinApiError && error.status === 412 && <button type="button" className="secondary-button" onClick={refresh}>重新加载最新版本</button>}
      {error instanceof BinApiError && error.status === 401 && <button type="button" className="secondary-button" onClick={() => {
        if (!dirty || window.confirm("重新登录会离开当前页面，是否放弃未保存的内容？")) client.invalidateQueries({ queryKey: ["auth-me"] });
      }}>重新登录</button>}
    </div>}
    <div className="detail-tabs" role="tablist" aria-label="数据仓详情">
      {(["表单编辑", "编辑器", "树形视图", "历史版本", "API", "设置"] as const).map(item =>
        <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>{item}</button>)}
    </div>
    <div className="panel detail-panel" role="tabpanel" aria-label={tab}>
      {tab === "表单编辑" && (parsed.valid && isJsonObject(parsed.value) ? <>
        <div className="editor-toolbar"><span>键值表单</span>
          <button type="button" className="primary-button"
            disabled={!formValid || !isDirty(draft) || Boolean(busy) || locked} onClick={saveJson}>
            <Save size={15} />{busy === "json" ? "正在保存…" : "保存 JSON"}
          </button>
        </div>
        <JsonFormEditor value={parsed.value} sourceText={draft.text} disabled={locked || Boolean(busy)}
          onValidityChange={setFormValid}
          onChange={text => { setDraft(previous => previous ? { ...previous, text } : previous); setNotice(""); }} />
      </> : <div className="json-form-invalid">
        <p className="detail-error" role="alert">{parsed.valid ? "表单编辑仅支持根对象（{ }）。数组、字符串、数字等根值请使用代码编辑器。" : parsed.error + "请返回编辑器修正后再使用表单编辑。"}</p>
        <button type="button" className="secondary-button" onClick={() => setTab("编辑器")}>返回编辑器</button>
      </div>)}
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
      {tab === "树形视图" && (parsed.valid
        ? <JsonTree value={parsed.value} dirty={isDirty(draft)} onCopy={copy} />
        : <div className="json-tree-invalid"><p className="detail-error" role="alert">{parsed.error}请返回编辑器修正后查看树形视图。</p>
          <button type="button" className="secondary-button" onClick={() => setTab('编辑器')}>返回编辑器</button></div>)}
      {tab === "历史版本" && <Suspense fallback={<p role="status">正在加载版本历史…</p>}>
        <BinHistory record={record} dark={dark} busy={Boolean(busy)} onRestore={restore} />
      </Suspense>}
      {tab === "API" && <BinApiPanel bin={{id: record.meta.id, etag: record.etag, visibility: record.meta.visibility, locked: record.meta.locked, expiresAt: record.meta.expiresAt}} />}
      {tab === "设置" && metadata && <form className="detail-form" onSubmit={event => { event.preventDefault(); saveSettings(); }}>
        <label>到期时间<input type="datetime-local" step="1" aria-label="到期时间" value={localDateTime(metadata.expiresAt)} disabled={Boolean(busy) || locked}
          onChange={event => setMetadata({ ...metadata, expiresAt: expiryFromInput(event.target.value) })} /></label>
        <p>使用本地时区，留空表示永不过期。到期后停止正常读写，可在回收站恢复；数据锁不会延长已设置的期限。</p>
        <label>名称<input required maxLength={160} value={metadata.name} disabled={Boolean(busy) || locked} onChange={event => setMetadata({ ...metadata, name: event.target.value })} /></label>
        <label>描述<textarea maxLength={1000} value={metadata.description} disabled={Boolean(busy) || locked} onChange={event => setMetadata({ ...metadata, description: event.target.value })} /></label>
        <label>可见性<select aria-label="可见性" value={metadata.visibility} disabled={Boolean(busy) || locked} onChange={event => setMetadata({ ...metadata, visibility: event.target.value as "private" | "public" })}><option value="private">私有</option><option value="public">公开</option></select></label>
        <label>集合<select aria-label="集合" value={metadata.collectionId ?? ""} disabled={Boolean(busy) || locked || collections.isPending || collections.isError}
          onChange={event => setMetadata({ ...metadata, collectionId: event.target.value || null })}>
          <option value="">未分组</option>
          {metadata.collectionId && !collections.data?.items.some(item => item.id === metadata.collectionId && item.status === "active") && <option value={metadata.collectionId}>当前集合不可用</option>}
          {collections.data?.items.filter(item => item.status === "active").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        {collections.isError && <p role="alert">{collections.error.message}<button type="button" className="secondary-button" onClick={() => collections.refetch()}>重试集合选项</button></p>}
        <label>数据模型<select aria-label="数据模型" value={metadata.schemaId ?? ""}
          disabled={Boolean(busy) || locked || record.meta.schemaLocked || schemas.isPending || schemas.isError}
          onChange={event => setMetadata({ ...metadata, schemaId: event.target.value || null, refreshSchema: false })}>
          <option value="">不绑定模型</option>
          {metadata.schemaId && !schemas.data?.items.some(item => item.id === metadata.schemaId) && <option value={metadata.schemaId}>已删除的模型（绑定修订仍有效）</option>}
          {schemas.data?.items.map(item => <option key={item.id} value={item.id}>{item.name} · 最新 r{item.currentRevision}</option>)}
        </select></label>
        {schemas.isError && <p role="alert">{schemas.error.message}<button type="button" className="secondary-button" onClick={() => schemas.refetch()}>重试模型选项</button></p>}
        {record.meta.schemaId && <p>当前绑定修订 r{record.meta.schemaRevision}。新绑定与升级会先校验已保存的 JSON。</p>}
        <label className="schema-checkbox"><input type="checkbox" aria-label="使用模型最新修订" checked={metadata.refreshSchema ?? false}
          disabled={Boolean(busy) || locked || record.meta.schemaLocked || !metadata.schemaId || metadata.schemaId !== record.meta.schemaId || !schemas.data?.items.some(item => item.id === metadata.schemaId)}
          onChange={event => setMetadata({ ...metadata, refreshSchema: event.target.checked })} />使用模型最新修订</label>
        <label className="schema-checkbox"><input type="checkbox" aria-label="锁定模型绑定" checked={metadata.schemaLocked} disabled={Boolean(busy) || locked || !metadata.schemaId}
          onChange={event => setMetadata({ ...metadata, schemaLocked: event.target.checked })} />锁定模型绑定</label>
        {record.meta.schemaLocked && <p>模型绑定已锁定；更换、解除或升级前，请先取消锁定并单独保存。</p>}
        <p>{metadata.visibility === "public" ? "公开后，任何持有 API 地址的人都能匿名读取当前 JSON 和元数据；历史版本及写入仍需认证。" : "私有数据仓的所有读取都需要 Session 或具有所需 Scope 的 API 密钥。"}</p>
        <button type="submit" className="primary-button" disabled={!metadataDirty || !metadata.name.trim() || Boolean(busy) || locked}><Save size={15} />保存设置</button>
        <h3>数据锁</h3>
        <p>锁定后禁止修改 JSON、设置、恢复历史和删除；读取保持可用。解锁单独生效，不改变模型锁。</p>
        {dirty && <p>请先保存未保存的内容，或重新加载后再操作数据锁。</p>}
        <button type="button" className="secondary-button" disabled={Boolean(busy) || dirty} onClick={toggleLock}>{busy === "lock" ? "正在更新数据锁…" : locked ? "解除数据锁" : "锁定数据仓"}</button>
      </form>}
    </div>
    <footer className="detail-footer"><p>删除后元数据移入回收站，历史版本保留。</p>
      <button type="button" className="danger-button" onClick={() => setDeleteOpen(true)} disabled={Boolean(busy) || locked}><Trash2 size={15} />删除数据仓</button></footer>
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
