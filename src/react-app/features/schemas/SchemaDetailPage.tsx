import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConfirm } from "../../components/ConfirmDialog";
import { getSchema, saveSchema, removeSchema, validateSample, SchemaApiError } from "./api";
import type { SchemaRecord, SchemaDefinition, ValidationResult } from "./api";
import { SchemaIssues } from "./SchemaIssues";
const initialText = JSON.stringify({ $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { title: { type: "string" } }, required: ["title"] }, null, 2);
function fields(record: SchemaRecord) { return { name: record.meta.name, description: record.meta.description, text: JSON.stringify(record.schema, null, 2) }; }
const initialForm = { name: "", description: "", text: initialText };
export function SchemaDetailPage({ id, onBack, onSaved, onDeleted, onDirtyChange }: {
  id: string | null; onBack: () => void; onSaved: (id: string) => void; onDeleted: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const client = useQueryClient(), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const query = useQuery({ queryKey: ["schema", id], queryFn: ({ signal }) => getSchema(id!, signal), enabled: Boolean(id), retry: false });
  const [baseline, setBaseline] = useState<SchemaRecord | null>(null), [form, setForm] = useState(initialForm);
  const [busy, setBusy] = useState(false), [error, setError] = useState<Error | null>(null), [notice, setNotice] = useState("");
  const [sample, setSample] = useState('{"title":"示例"}'), [result, setResult] = useState<ValidationResult | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline ? fields(baseline) : initialForm);
  useEffect(() => { if (query.data && !dirty) { setBaseline(query.data); setForm(fields(query.data)); setResult(null); } }, [query.data]);
  useEffect(() => { onDirtyChange(dirty || busy); }, [dirty, busy, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  function report(caught: unknown) { if (mounted.current) setError(caught instanceof Error ? caught : new Error("操作失败，请重试。")); }
  async function accept(record: SchemaRecord) {
    await client.cancelQueries({ queryKey: ["schema", record.meta.id] });
    if (!mounted.current) return false;
    setBaseline(record); setForm(fields(record)); setResult(null); client.setQueryData(["schema", record.meta.id], record);
    return true;
  }
  async function save() {
    if (busy || (id && !baseline)) return;
    let schema: SchemaDefinition;
    try { schema = JSON.parse(form.text); } catch { setError(new Error("模型定义不是有效 JSON。")); return; }
    setBusy(true); setError(null); setNotice("");
    try {
      if (id) await client.cancelQueries({ queryKey: ["schema", id] });
      const record = await saveSchema({ name: form.name, description: form.description, schema }, id ?? undefined, baseline?.etag);
      if (!await accept(record)) return;
      await client.invalidateQueries({ queryKey: ["schemas"] });
      if (!mounted.current) return;
      setNotice(`模型已保存为 r${record.meta.currentRevision}，已有数据仓保持原修订。`);
      if (!id) { onDirtyChange(false); onSaved(record.meta.id); }
    } catch (caught) { report(caught); } finally { if (mounted.current) setBusy(false); }
  }
  async function reload() {
    if (!id || busy || (dirty && !await confirm({
      title: "重新加载数据模型？",
      message: "重新加载会丢弃未保存的模型修改。",
      confirmLabel: "重新加载",
      cancelLabel: "继续编辑",
      danger: true,
    }))) return;
    setBusy(true); setError(null); setNotice("");
    try { await client.cancelQueries({ queryKey: ["schema", id] }); await accept(await getSchema(id)); }
    catch (caught) { report(caught); } finally { if (mounted.current) setBusy(false); }
  }
  async function remove() {
    if (!id || !baseline || busy || !await confirm({
      title: "删除数据模型？",
      message: `删除“${baseline.meta.name}”后，已有数据仓继续按绑定修订校验，但不能再新绑定此模型。${dirty ? "未保存的修改将被丢弃。" : ""}`,
      confirmLabel: "删除模型",
      danger: true,
    })) return;
    setBusy(true); setError(null);
    try {
      await removeSchema(id, baseline.etag); await client.invalidateQueries({ queryKey: ["schemas"] });
      client.removeQueries({ queryKey: ["schema", id] });
      if (mounted.current) { onDirtyChange(false); onDeleted(); }
    } catch (caught) { report(caught); } finally { if (mounted.current) setBusy(false); }
  }
  async function validate() {
    if (!id || busy || dirty) return;
    let value: unknown;
    try { value = JSON.parse(sample); } catch { setError(new Error("校验样本不是有效 JSON。")); setResult(null); return; }
    setBusy(true); setError(null); setResult(null);
    try { const data = await validateSample(id, value); if (mounted.current) setResult(data); }
    catch (caught) { report(caught); } finally { if (mounted.current) setBusy(false); }
  }
  if (id && !baseline) return <section className="panel collection-panel"><button className="secondary-button" onClick={onBack}>返回数据模型</button>
    {query.isError ? <><p role="alert">{query.error.message}</p><button className="secondary-button" onClick={() => query.refetch()}>重试模型详情</button></> : <p role="status">正在加载模型…</p>}</section>;
  return <section className="schema-detail"><div className="detail-actions"><button className="secondary-button" disabled={busy} onClick={onBack}>返回数据模型</button>
    {id && <button className="secondary-button" disabled={busy} onClick={reload}>重新加载模型</button>}</div>
    <header className="detail-heading"><div><span className="eyebrow">JSON Schema · Draft 7</span><h1>{baseline?.meta.name ?? "新建数据模型"}</h1>
      {baseline && <p>当前修订 r{baseline.meta.currentRevision}</p>}</div>{dirty && <span className="dirty-badge">未保存</span>}</header>
    {notice && <p className="detail-notice" role="status">{notice}</p>}
    {error && <div className="detail-error" role="alert">{error.message}{error instanceof SchemaApiError && <SchemaIssues issues={error.issues} />}
      {error instanceof SchemaApiError && error.status === 401 && <button className="secondary-button" onClick={async () => {
        if (!dirty || await confirm({
          title: "重新登录？",
          message: "重新登录会离开当前页面，未保存的内容将丢失。",
          confirmLabel: "重新登录",
          cancelLabel: "继续编辑",
          danger: true,
        })) client.invalidateQueries({ queryKey: ["auth-me"] });
      }}>重新登录</button>}</div>}
    <form className="panel detail-form" onSubmit={event => { event.preventDefault(); save(); }}>
      <label>模型名称<input required maxLength={160} disabled={busy} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
      <label>模型描述<textarea aria-label="模型描述" maxLength={1000} disabled={busy} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
      <label>模型定义<textarea aria-label="模型定义" className="schema-textarea" spellCheck={false} disabled={busy} value={form.text} onChange={event => setForm({ ...form, text: event.target.value })} /></label>
      <p>支持对象、布尔模型和本地 JSON Pointer 引用；扩展注释使用 x- 前缀。外部引用与其他草案暂不支持。模型不会自动修改 JSON 内容。</p>
      <button className="primary-button" disabled={busy || !dirty || !form.name.trim()} type="submit">{busy ? "正在处理…" : id ? "保存模型" : "创建模型"}</button>
    </form>
    {id && <section className="panel detail-form" aria-label="模型样本校验"><h2>校验 JSON 样本</h2><p>使用服务器中已保存的最新修订。{dirty && "请先保存或重新加载模型。"}</p>
      <label>校验样本<textarea aria-label="校验样本" spellCheck={false} className="schema-textarea" disabled={busy} value={sample} onChange={event => { setSample(event.target.value); setResult(null); }} /></label>
      <button className="secondary-button" disabled={busy || dirty} onClick={validate}>校验样本</button>
      {result && <div role={result.valid ? "status" : "alert"} className={result.valid ? "detail-notice" : "detail-error"}>
        {result.valid ? "校验通过" : "校验失败"} · r{result.revision}<SchemaIssues issues={result.issues} /></div>}
    </section>}
    {id && <footer className="detail-footer"><p>删除模型后，已有绑定和修订仍保留。</p><button className="danger-button" disabled={busy} onClick={remove}>删除模型</button></footer>}
  </section>;
}
