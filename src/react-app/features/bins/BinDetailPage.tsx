import { systemApi } from '../settings/api';
import { downloadBytes } from '../settings/download';
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, Save, Trash2, Braces, RefreshCw } from "lucide-react";
import { BinApiError, getBin, getBinIfChanged, removeBin, saveBin, saveBinMetadata, restoreBinVersion } from "./api";
import { createDraft, isDirty, parseJson, receiveRecord, savedDraft } from "./editor-state";
import type { Draft } from "./editor-state";
import type { BinRecord, MetadataInput } from "./types";
import { listCollections } from "../collections/api";

import { listSchemas } from "../schemas/api";
import { SchemaIssues } from "../schemas/SchemaIssues";
// The API tab drags in the whole docs example catalog; it is the only reason
// BinDetailPage would need it, so load it on first tab visit instead of at
// first paint.
const BinApiPanel = lazy(() => import("../docs/BinApiPanel").then(module => ({ default: module.BinApiPanel })));
import { ExpiryLabel, expiryFromInput, localDateTime } from "./expiry";
import { JsonTree } from './JsonTree';
import { JsonFormEditor, type JsonFormState } from "./JsonFormEditor";
import { Dialog } from "../../components/Dialog";
import { useConfirm } from "../../components/ConfirmDialog";
import { CopyButton } from "../../components/CopyButton";

const JsonEditor = lazy(() => import("./JsonEditor"));
const BinHistory = lazy(() => import("./BinHistory"));
type Tab = "表单编辑" | "编辑器" | "树形视图" | "历史版本" | "API" | "设置";
function isJsonObject(value: unknown): value is Record<string, import("./json-form-model").JsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function metadataOf(record: BinRecord): MetadataInput {
  const { name, slug, tags, favorite, pinned, description, visibility, collectionId, schemaId, schemaLocked, expiresAt } = record.meta;
  return { name, slug: slug ?? null, tags: tags ?? [], favorite: favorite ?? false, pinned: pinned ?? false, description, visibility, collectionId, schemaId, schemaLocked, expiresAt, refreshSchema: false };
}

export function BinDetailPage({ id, dark, onBack, onDeleted, onDirtyChange }: {
  id: string; dark: boolean; onBack: () => void; onDeleted: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const client = useQueryClient();
  const confirm = useConfirm();
  const query = useQuery({ queryKey: ["bin", id], queryFn: ({ signal }) => getBinIfChanged(id, client.getQueryData<BinRecord>(["bin", id]), undefined, signal), retry: false, refetchInterval: 15_000 });
  const collections = useQuery({ queryKey: ["collections"], queryFn: ({ signal }) => listCollections(signal), retry: false });
  const schemas = useQuery({ queryKey: ["schemas"], queryFn: ({ signal }) => listSchemas(signal), retry: false });
  const mounted = useRef(false);
  const exportController = useRef<AbortController | null>(null), exporting = useRef(false);
  useEffect(() => { mounted.current = true; const cancel = () => exportController.current?.abort(); window.addEventListener("jsonbin:logout", cancel); window.addEventListener("jsonbin:logout-pending", cancel); return () => { mounted.current = false; exportController.current?.abort(); window.removeEventListener("jsonbin:logout", cancel); window.removeEventListener("jsonbin:logout-pending", cancel); }; }, []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [metadata, setMetadata] = useState<MetadataInput | null>(null);
  const [tab, setTab] = useState<Tab>("编辑器");
  const [busy, setBusy] = useState<"json" | "metadata" | "delete" | "reload" | "restore" | "lock" | "export" | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [formSession, setFormSession] = useState<JsonFormState | null>(null);
  const [formRevision, setFormRevision] = useState(0);
  const [saveMessage, setSaveMessage] = useState("");
  const metadataDirty = Boolean(draft && metadata && JSON.stringify(metadata) !== JSON.stringify(metadataOf(draft.record)));
  const dirty = Boolean(draft && (metadataDirty || formSession?.dirty || isDirty(draft)));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const parsed = useMemo(() => draft ? parseJson(draft.text) : null, [draft?.text]);
  // An invalid form session never propagates its text into the draft, so the
  // draft still parses as the PREVIOUS valid input. Saving at that moment
  // would persist something else than what the user is looking at: every save
  // entry point (buttons, Ctrl/Cmd+S, saveJson itself) consumes this rule.
  const activeFormInvalid = tab === "表单编辑" && formSession?.valid === false;
  const canSaveJson = Boolean(draft && isDirty(draft) && parsed?.valid && !activeFormInvalid && !busy && !draft.record.meta.locked);

  useEffect(() => {
    if (!query.data) return;
    // An automatic refresh must never replace either JSON or metadata drafts.
    setDraft(previous => previous && (isDirty(previous) || dirtyRef.current) ? previous : previous ? receiveRecord(previous, query.data!) : createDraft(query.data!));
    if (!dirty) setMetadata(metadataOf(query.data));
  }, [query.data]);
  // Propagate draft protection before paint so a rapid browser Back cannot race a passive effect.
  useLayoutEffect(() => { onDirtyChange(dirty || Boolean(busy)); }, [dirty, busy, onDirtyChange]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isLocked = Boolean(draft?.record.meta.locked);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (tab === "设置") {
          if (metadataDirty && !busy && !isLocked) void saveSettings();
        } else if (tab === "表单编辑" || tab === "编辑器") {
          if (canSaveJson) void saveJson();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [tab, metadataDirty, busy, draft, parsed, canSaveJson, saveSettings, saveJson]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);

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
    if (busy || (dirty && !await confirm({
      title: "重新加载数据仓？",
      message: "重新加载会丢弃未保存的 JSON 和设置修改。",
      confirmLabel: "重新加载",
      cancelLabel: "继续编辑",
      danger: true,
    }))) return;
    setBusy("reload"); setError(null); setNotice("");
    try {
      await client.cancelQueries({ queryKey: ["bin", id] });
      const record = await getBin(id);
      if (!mounted.current) return;
      await client.cancelQueries({ queryKey: ["bin", id] });
      if (!mounted.current) return;
      setDraft(createDraft(record)); setMetadata(metadataOf(record)); setFormSession(null); setFormRevision(value => value + 1);
      client.setQueryData(["bin", id], record);
    } catch (caught) { report(caught); } finally { setBusy(null); }
  }
  async function saveJson() {
    if (!draft || busy) return;
    // The function entry consumes the same rule as the buttons and the
    // shortcut: an invalid form session must never save its stale draft text.
    if (tab === "表单编辑" && formSession?.valid === false) return;
    const parsed = parseJson(draft.text); if (!parsed.valid) return;
    const submittedText = draft.text;
    const message = saveMessage.trim() || undefined;
    setBusy("json"); setError(null); setNotice("");
    try {
      await client.cancelQueries({ queryKey: ["bin", id] });
      const record = await saveBin(id, parsed.value, draft.record.etag, undefined, message);
      if (!mounted.current) return;
      await client.cancelQueries({ queryKey: ["bin", id] });
      if (!mounted.current) return;
      setDraft(previous => previous ? savedDraft(previous, record, submittedText) : createDraft(record));
      setFormSession(null);
      setSaveMessage("");
      client.setQueryData(["bin", id], record);
      await client.invalidateQueries({ queryKey: ["bins"] });
      await client.invalidateQueries({ queryKey: ["bin-versions", id] });
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
    if (!await confirm({
      title: `恢复历史版本 v${version}？`,
      message: `将 v${version} 的内容恢复为新的最新版本。${dirty ? "未保存的 JSON 和设置修改将被丢弃。" : "已有历史版本不会改变。"}`,
      confirmLabel: "恢复版本",
      danger: dirty,
    })) return;
    setBusy("restore"); setError(null); setNotice("");
    try {
      await client.cancelQueries({ queryKey: ["bin", id] });
      const record = await restoreBinVersion(id, version, draft.record.etag);
      if (!mounted.current) return;
      await client.cancelQueries({ queryKey: ["bin", id] });
      if (!mounted.current) return;
      setDraft(createDraft(record)); setMetadata(metadataOf(record)); setFormSession(null); setFormRevision(value => value + 1);
      client.setQueryData(["bin", id], record);
      await client.invalidateQueries({ queryKey: ["bins"] });
      await client.invalidateQueries({ queryKey: ["bin-versions", id] });
      setNotice(`已恢复 v${version}，生成新版本 v${record.meta.currentVersion}。`);
    } catch (caught) { report(caught); } finally { setBusy(null); }
  }
  async function publish(version: number) {
    if (!draft || busy || draft.record.meta.locked) return;
    if (!await confirm({
      title: `发布配置版本 v${version}？`,
      message: `将生产已发布指针 (Published Version) 指向 v${version}。通过 /published 读取的外部应用将即时切换到该版本。`,
      confirmLabel: "确认发布",
    })) return;
    setBusy("metadata"); setError(null); setNotice("");
    try {
      const res = await fetch(`/api/v1/bins/${id}/publish`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "If-Match": draft.record.etag },
        body: JSON.stringify({ version }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(new Error(body.error === "schema_validation_failed" ? "该历史版本不符合当前数据模型，无法发布。" : "发布失败，可能版本冲突，请重试。"));
        return;
      }
      const updated = await res.json();
      if (!mounted.current) return;
      setDraft(createDraft(updated)); setMetadata(metadataOf(updated));
      client.setQueryData(["bin", id], updated);
      await client.invalidateQueries({ queryKey: ["bins"] });
      setNotice(`已成功发布配置 v${version}！`);
    } catch {
      setError(new Error("网络异常，无法发布配置。"));
    } finally {
      setBusy(null);
    }
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
      setDraft(createDraft(record)); setMetadata(metadataOf(record)); setFormSession(null); setFormRevision(value => value + 1);
      client.setQueryData(["bin", id], record);
      await client.invalidateQueries({ queryKey: ["bins"] });
      setNotice(locked ? "数据仓已锁定，修改和删除已禁止；读取不受影响。" : "数据锁已解除，可以继续编辑。模型锁保持不变。");
    } catch (caught) { report(caught); } finally { setBusy(null); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice("已复制。"); }
    catch { setError(new Error("无法访问剪贴板，请手动选择并复制。")); }
  }
  async function requestTabChange(nextTab: Tab) {
    if (nextTab === tab) return;
    if (tab === "表单编辑" && formSession?.dirty && !formSession.valid) {
      const discard = await confirm({
        title: "放弃无效的表单修改？",
        message: "当前表单包含无法生成 JSON 的修改。请继续修正，或明确放弃后切换。",
        confirmLabel: "放弃并切换",
        cancelLabel: "继续修正",
        danger: true,
      });
      if (!discard) {
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="表单编辑"] [aria-invalid="true"]')?.focus());
        return;
      }
      setFormSession(null);
      setFormRevision(value => value + 1);
    }
    setTab(nextTab);
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
    <div className="detail-id"><code>{id}</code>
      <CopyButton label="复制 Bin ID" value={id} />
      <CopyButton label="复制 API 地址" value={apiUrl} />
      <CopyButton label="复制 JSON" title="复制当前 JSON 内容" value={draft.text} />
      <button type="button" className="secondary-button" onClick={async () => {
        try {
          const res = await fetch(`/api/v1/bins/${id}/clone`, {
            method: "POST",
            credentials: "include",
            headers: { "If-Match": record.etag },
          });
          if (res.ok) {
            const data = await res.json();
            setNotice("克隆成功，正在跳转…");
            window.location.hash = `#/bins/${data.meta.id}`;
          } else {
            setError(new Error("克隆失败，可能版本已变更，请刷新重试。"));
          }
        } catch {
          setError(new Error("网络异常，无法克隆数据仓。"));
        }
      }} title="基于当前快照克隆为新数据仓"><Copy size={14} />克隆</button>
    </div>
    {notice && <p className="detail-notice" role="status">{notice}</p>}
    {error && <div className="detail-error" role="alert">{error.message}
      {error instanceof BinApiError && <SchemaIssues issues={error.issues} />}
      {error instanceof BinApiError && error.status === 412 && <button type="button" className="secondary-button" onClick={refresh}>重新加载最新版本</button>}
      {error instanceof BinApiError && error.status === 401 && <button type="button" className="secondary-button" onClick={async () => {
        if (!dirty || await confirm({
          title: "重新登录？",
          message: "重新登录会离开当前页面，未保存的内容将丢失。",
          confirmLabel: "重新登录",
          cancelLabel: "继续编辑",
          danger: true,
        })) client.invalidateQueries({ queryKey: ["auth-me"] });
      }}>重新登录</button>}
    </div>}
    <div className="detail-tabs" role="tablist" aria-label="数据仓详情" onKeyDown={event => {
      const tabs = ['表单编辑', '编辑器', '树形视图', '历史版本', 'API', '设置'] as const;
      const index = tabs.indexOf(tab);
      let nextIndex = index;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      else return;
      event.preventDefault();
      const nextTab = tabs[nextIndex];
      void requestTabChange(nextTab);
      const button = event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]')[nextIndex];
      button?.focus();
    }}>
      {(['表单编辑', '编辑器', '树形视图', '历史版本', 'API', '设置'] as const).map(item => {
        const hasDirty = (item === '设置' && metadataDirty) || ((item === '表单编辑' || item === '编辑器') && isDirty(draft));
        return (
          <button key={item} id={`detail-tab-${item}`} type="button" role="tab" aria-selected={tab === item}
            tabIndex={tab === item ? 0 : -1} aria-controls={`detail-panel-${item}`}
            onFocus={() => { if (tab !== item) void requestTabChange(item); }}
            onClick={() => void requestTabChange(item)}>
            {item}
            {hasDirty && <span className="tab-dirty-indicator" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
    <div id={`detail-panel-${tab}`} className="panel detail-panel" role="tabpanel" aria-label={tab} aria-labelledby={`detail-tab-${tab}`}>
      {tab === "表单编辑" && (parsed.valid && isJsonObject(parsed.value) ? <>
        <div className="editor-toolbar"><span>键值表单</span>
          <button type="button" className="primary-button"
            disabled={!canSaveJson} onClick={saveJson}>
            <Save size={15} />{busy === "json" ? "正在保存…" : "保存 JSON"}
          </button>
        </div>
        <JsonFormEditor key={formRevision} value={parsed.value} sourceText={draft.text} baselineText={draft.savedText} readOnly={locked} busy={Boolean(busy)}
          onStateChange={setFormSession}
          onChange={text => { setDraft(previous => previous ? { ...previous, text } : previous); setNotice(""); }} />
      </> : <div className="json-form-invalid">
        <p className="detail-error" role="alert">{parsed.valid ? "表单编辑仅支持根对象（{ }）。数组、字符串、数字等根值请使用代码编辑器。" : parsed.error + "请返回编辑器修正后再使用表单编辑。"}</p>
        <button type="button" className="secondary-button" onClick={() => setTab("编辑器")}>返回编辑器</button>
      </div>)}
      {tab === "编辑器" && <>
        <div className="editor-toolbar"><span>JSON</span>
          <input
            type="text"
            aria-label="版本变更说明"
            placeholder="本次保存的变更说明（可选，显示在版本历史中）"
            value={saveMessage}
            onChange={event => setSaveMessage(event.target.value)}
            disabled={Boolean(busy) || locked}
            maxLength={500}
            style={{ flex: 1, minWidth: "160px", padding: "6px 10px", borderRadius: "6px", border: "1px solid var(--border)", background: "transparent", color: "inherit", fontSize: "12px" }}
          />
          <button type="button" className="secondary-button" disabled={!parsed.valid || Boolean(busy) || locked}
            onClick={() => parsed.valid && setDraft({ ...draft, text: JSON.stringify(parsed.value, null, 2) })}><Braces size={15} />格式化</button>
          <button type="button" className="primary-button" disabled={!canSaveJson} onClick={saveJson}><Save size={15} />{busy === "json" ? "正在保存…" : "保存 JSON"}</button>
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
        <BinHistory record={record} dark={dark} busy={Boolean(busy)} onRestore={restore} onPublish={publish} />
      </Suspense>}
      {tab === "API" && <Suspense fallback={<p role="status">正在加载 API 文档…</p>}><BinApiPanel bin={{id: record.meta.id, etag: record.etag, visibility: record.meta.visibility, locked: record.meta.locked, expiresAt: record.meta.expiresAt}} /></Suspense>}
      {tab === "设置" && metadata && <form className="detail-form" onSubmit={event => { event.preventDefault(); saveSettings(); }}>
        <label>到期时间<input type="datetime-local" step="1" aria-label="到期时间" value={localDateTime(metadata.expiresAt)} disabled={Boolean(busy) || locked}
          onChange={event => setMetadata({ ...metadata, expiresAt: expiryFromInput(event.target.value) })} /></label>
        <p>使用本地时区，留空表示永不过期。到期后停止正常读写，可在回收站恢复；数据锁不会延长已设置的期限。</p>
        <label>名称<input required maxLength={160} value={metadata.name} disabled={Boolean(busy) || locked} onChange={event => setMetadata({ ...metadata, name: event.target.value })} /></label>
        <label>自定义别名 (Slug)<input placeholder="如 my-app-config，留空表示移除" value={metadata.slug ?? ""} disabled={Boolean(busy) || locked} onChange={event => setMetadata({ ...metadata, slug: event.target.value.toLowerCase().trim() || null })} /></label>
        <label>标签 (Tags)<input placeholder="用逗号或空格分隔，如 prod, vps" value={metadata.tags?.join(", ") ?? ""} disabled={Boolean(busy) || locked} onChange={event => setMetadata({ ...metadata, tags: event.target.value.split(/[,，\s]+/).map(t => t.trim()).filter(Boolean) })} /></label>
        <div style={{ display: "flex", gap: "20px" }}>
          <label className="schema-checkbox"><input type="checkbox" checked={metadata.pinned ?? false} disabled={Boolean(busy) || locked} onChange={event => setMetadata({ ...metadata, pinned: event.target.checked })} />置顶展示</label>
          <label className="schema-checkbox"><input type="checkbox" checked={metadata.favorite ?? false} disabled={Boolean(busy) || locked} onChange={event => setMetadata({ ...metadata, favorite: event.target.checked })} />加入收藏</label>
        </div>
        <label>描述<textarea maxLength={1000} value={metadata.description} disabled={Boolean(busy) || locked} onChange={event => setMetadata({ ...metadata, description: event.target.value })} /></label>
        <label>可见性<select aria-label="可见性" value={metadata.visibility} disabled={Boolean(busy) || locked} onChange={event => setMetadata({ ...metadata, visibility: event.target.value as "private" | "public" })}><option value="private">私有</option><option value="public">公开</option></select></label>
        <p>{metadata.visibility === "public" ? "公开后，任何持有 API 地址的人都能匿名读取当前 JSON 和元数据；历史版本及写入仍需认证。" : "私有数据仓的所有读取都需要 Session 或具有所需 Scope 的 API 密钥。"}</p>
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
        <label>内容搜索索引模式
          <select
            aria-label="内容搜索索引模式"
            value={metadata.contentSearchMode ?? "off"}
            disabled={Boolean(busy) || locked}
            onChange={event => setMetadata({ ...metadata, contentSearchMode: event.target.value as "off" | "keys" | "all" })}
          >
            <option value="off">关闭 (不参与内容搜索)</option>
            <option value="keys">仅索引键 (Keys 及 JSON Pointer)</option>
            <option value="all">全量索引 (键与数值)</option>
          </select>
        </label>
        {metadata.contentSearchMode === "all" && (
          <p style={{ color: "#eab308", fontSize: "12px" }}>
            ⚠️ 提示：JSON 内容可能包含 Token、Cookie 或密码等敏感值。开启全量内容搜索后这些值将参与搜索匹配。
          </p>
        )}
        <button type="submit" className="primary-button" disabled={!metadataDirty || !metadata.name.trim() || Boolean(busy) || locked}><Save size={15} />保存设置</button>
        <h3>数据锁</h3>
        <p>锁定后禁止修改 JSON、设置、恢复历史和删除；读取保持可用。解锁单独生效，不改变模型锁。</p>
        {dirty && <p>请先保存未保存的内容，或重新加载后再操作数据锁。</p>}
        <button type="button" className="secondary-button" disabled={Boolean(busy) || dirty} onClick={toggleLock}>{busy === "lock" ? "正在更新数据锁…" : locked ? "解除数据锁" : "锁定数据仓"}</button>
      </form>}
    </div>
    <footer className="detail-footer"><p>删除后元数据移入回收站，历史版本保留。</p>
      <button type="button" className="danger-button" onClick={() => setDeleteOpen(true)} disabled={Boolean(busy) || locked}><Trash2 size={15} />删除数据仓</button></footer>
    {deleteOpen && <Dialog titleId="delete-title" className="delete-dialog" onClose={() => setDeleteOpen(false)} dismissible={!busy} focusContainer={busy === "delete"}>
      <h2 id="delete-title">删除数据仓？</h2><p>“{record.meta.name}”将移入回收站。{dirty && "未保存的修改将被丢弃。"}</p>
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => setDeleteOpen(false)}>取消</button>
        <button type="button" className="danger-button" disabled={Boolean(busy)} onClick={confirmDelete}>{busy === "delete" ? "正在删除…" : "确认删除"}</button></div>
    </Dialog>}
  </section>;
}
