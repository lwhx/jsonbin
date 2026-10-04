import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createCollection, getCollection, getCollectionBins, removeCollection, saveCollection } from "./api";
import type { CollectionRecord, CollectionInput } from "./api";
import { getBin, saveBinMetadata } from "../bins/api";
import { confirmDialog } from "../../components/ConfirmDialog";

export function CollectionDetailPage({ id, onBack, onSaved, onDeleted, onOpenBin, onDirtyChange }: {
  id: string | null; onBack: () => void; onSaved: (id: string) => void; onDeleted: () => void;
  onOpenBin: (id: string) => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const client = useQueryClient();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const query = useQuery({ queryKey: ["collection", id], queryFn: ({ signal }) => getCollection(id!, signal), enabled: Boolean(id), retry: false });
  const members = useQuery({ queryKey: ["collection-bins", id], queryFn: ({ signal }) => getCollectionBins(id!, signal), enabled: Boolean(id), retry: false });
  const [baseline, setBaseline] = useState<CollectionRecord | null>(null);
  const [form, setForm] = useState<CollectionInput>({ name: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirty = form.name !== (baseline?.meta.name ?? "") || form.description !== (baseline?.meta.description ?? "");
  useEffect(() => {
    if (!query.data || dirty) return;
    setBaseline(query.data); setForm({ name: query.data.meta.name, description: query.data.meta.description });
  }, [query.data]);
  useEffect(() => { onDirtyChange(dirty || busy); }, [dirty, busy, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  async function invalidate() {
    await Promise.all([client.invalidateQueries({ queryKey: ["collections"] }), client.invalidateQueries({ queryKey: ["bins"] }),
      client.invalidateQueries({ queryKey: ["collection-bins"] })]);
  }
  async function reload() {
    if (!id || busy) return;
    if (dirty && !await confirmDialog({
      title: "重新加载集合？",
      message: "重新加载会丢弃当前未保存的集合修改。",
      cancelLabel: "继续编辑",
      confirmLabel: "放弃并重新加载",
      tone: "danger",
    })) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await client.cancelQueries({ queryKey: ["collection", id] });
      const record = await getCollection(id);
      if (!mounted.current) return;
      await client.cancelQueries({ queryKey: ["collection", id] });
      setBaseline(record); setForm({ name: record.meta.name, description: record.meta.description });
      client.setQueryData(["collection", id], record); await members.refetch();
    } catch (caught) { if (mounted.current) setError((caught as Error).message); } finally { if (mounted.current) setBusy(false); }
  }
  async function save() {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (id) await client.cancelQueries({ queryKey: ["collection", id] });
      const record = id && baseline ? await saveCollection(id, form, baseline.etag) : await createCollection(form);
      if (!mounted.current) return;
      await client.cancelQueries({ queryKey: ["collection", record.meta.id] });
      if (!mounted.current) return;
      setBaseline(record); setForm({ name: record.meta.name, description: record.meta.description });
      client.setQueryData(["collection", record.meta.id], record); await invalidate();
      if (!mounted.current) return;
      setNotice("集合保存成功。"); if (!id) { onDirtyChange(false); onSaved(record.meta.id); }
    } catch (caught) { if (mounted.current) setError((caught as Error).message); } finally { if (mounted.current) setBusy(false); }
  }
  async function remove() {
    if (!id || !baseline || busy) return;
    if (!await confirmDialog({
      title: "删除集合？",
      message: `确定要删除集合“${baseline.meta.name}”吗？`,
      details: ["只会解除数据仓关联，所有 JSON 和历史版本都会保留。", ...(dirty ? ["未保存的集合修改将被丢弃。"] : [])],
      cancelLabel: "取消",
      confirmLabel: "删除集合",
      tone: "danger",
    })) return;
    setBusy(true); setError("");
    try {
      await removeCollection(id, baseline.etag); await invalidate();
      client.removeQueries({ queryKey: ["collection", id] });
      if (!mounted.current) return;
      onDirtyChange(false); onDeleted();
    } catch (caught) { if (mounted.current) setError((caught as Error).message); } finally { if (mounted.current) setBusy(false); }
  }
  async function detach(binId: string) {
    if (!id || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const bin = await getBin(binId);
      if (bin.meta.collectionId === id) await saveBinMetadata(binId, { collectionId: null }, bin.etag);
      await invalidate(); await client.invalidateQueries({ queryKey: ["bin", binId] });
      if (mounted.current) setNotice("已移出集合，JSON 和版本保持不变。");
    } catch (caught) { if (mounted.current) setError((caught as Error).message); } finally { if (mounted.current) setBusy(false); }
  }
  if (id && !baseline) return <section className="panel collection-panel"><button className="secondary-button" onClick={onBack}>返回集合</button>
    {query.isError ? <><p role="alert">{query.error.message}</p><button className="secondary-button" onClick={() => query.refetch()}>重试集合详情</button></> : <p role="status">正在加载集合…</p>}</section>;
  const deleting = baseline?.meta.status === "deleting";
  return <section className="collection-detail">
    <div className="detail-actions"><button className="secondary-button" disabled={busy} onClick={onBack}>返回集合</button>
      {id && <button className="secondary-button" disabled={busy} onClick={reload}>重新加载集合</button>}</div>
    <header className="detail-heading"><div><span className="eyebrow">集合详情</span><h1>{baseline?.meta.name ?? "新建集合"}</h1></div>
      {dirty && <span className="dirty-badge">未保存</span>}</header>
    {notice && <p role="status" className="detail-notice">{notice}</p>}{error && <p role="alert" className="detail-error">{error}</p>}
    {deleting && <p role="alert">集合正在删除，请重试删除完成清理。数据仓和历史版本会保留。</p>}
    <form className="panel detail-form" onSubmit={event => { event.preventDefault(); save(); }}>
      <label>集合名称<input required maxLength={160} disabled={busy || deleting} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
      <label>集合描述<textarea aria-label="集合描述" maxLength={1000} disabled={busy || deleting} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
      {baseline && <p className="collection-slug">Slug：<code>{baseline.meta.slug}</code></p>}
      <button className="primary-button" type="submit" disabled={busy || deleting || !dirty || !form.name.trim()}>{busy ? "正在处理…" : id ? "保存集合" : "创建集合"}</button>
    </form>
    {id && <section className="panel collection-panel" aria-label="集合内数据仓"><h2>集合内数据仓 · {members.data?.total ?? baseline?.binCount ?? 0} 个</h2>
      <p>在数据仓的设置页选择集合即可移入；移出不改变 JSON 和版本。</p>
      {members.isPending ? <p role="status">正在加载集合成员…</p> : members.isError ? <><p role="alert">{members.error.message}</p>
        <button className="secondary-button" onClick={() => members.refetch()}>重试集合成员</button></> : members.data.items.length ?
        <ul className="collection-members">{members.data.items.map(bin => <li key={bin.id}><button className="secondary-button" onClick={() => onOpenBin(bin.id)}>打开数据仓 {bin.name}</button>
          <span>v{bin.currentVersion}</span><button className="secondary-button" disabled={busy || bin.locked || deleting} onClick={() => detach(bin.id)}>移出 {bin.name}</button></li>)}</ul>
        : <p>集合内暂无数据仓。</p>}
    </section>}
    {id && <footer className="detail-footer"><p>删除集合只解除关联，不删除数据仓。</p><button className="danger-button" disabled={busy} onClick={remove}>{deleting ? "重试删除集合" : "删除集合"}</button></footer>}
  </section>;
}
