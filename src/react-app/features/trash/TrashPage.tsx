import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { emptyTrash, listTrash, purgeTrash, restoreTrash, type TrashRecord } from "./api";

export function TrashPage({ onOpen, onDirtyChange }: { onOpen: (id: string) => void; onDirtyChange: (dirty: boolean) => void }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["trash-bins"], queryFn: ({ signal }) => listTrash(signal), retry: false });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [restoredId, setRestoredId] = useState<string | null>(null);
  useEffect(() => { onDirtyChange(busy); return () => onDirtyChange(false); }, [busy, onDirtyChange]);
  async function invalidate() {
    await Promise.all(["trash-bins", "bins", "bin", "bin-versions", "collections", "collection-bins"].map(key => client.invalidateQueries({ queryKey: [key] })));
  }
  async function act(action: "restore" | "purge" | "empty", item?: TrashRecord) {
    if (busy) return;
    const items = query.data?.items ?? [];
    if (action === "purge" && !window.confirm(`永久删除「${item!.meta.name}」及全部历史版本？此操作无法撤销。`)) return;
    if (action === "empty" && (!items.length || !window.confirm(`永久删除当前回收站中的 ${items.length} 个数据仓及全部历史版本？此操作无法撤销，新进入回收站的记录不会包含在本次操作中。`))) return;
    setBusy(true); setError(""); setNotice(""); setRestoredId(null);
    try {
      if (action === "restore") {
        const record = await restoreTrash(item!); setRestoredId(record.meta.id);
        setNotice("已恢复为私有数据仓，过期时间已清除；历史版本和数据锁、模型锁保留。失效集合已解除关联。");
      } else if (action === "purge") { await purgeTrash(item!); setNotice("数据仓及全部历史版本已永久删除。"); }
      else {
        const results = await emptyTrash(items), failed = results.filter(result => result.status !== 200).length;
        setNotice(`已永久删除 ${results.length - failed} 个数据仓。`);
        if (failed) setError(`${failed} 项未删除，可能已被修改或恢复；请检查刷新后的列表再重试。`);
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "操作失败，请重试。"); }
    finally { await invalidate(); setBusy(false); }
  }
  return <>
    <section className="hero bins-hero"><div><span className="eyebrow">数据生命周期</span><h1>回收站</h1><p>已删除和已到期的数据仓保留历史版本，可恢复为私有且永不过期的数据仓。</p></div>
      <button className="danger-button" disabled={busy || !query.data?.items.length || query.isError} onClick={() => act("empty")}>清空回收站</button></section>
    <div className="detail-actions"><button className="secondary-button" disabled={busy || query.isFetching} onClick={() => query.refetch()}>刷新回收站</button></div>
    {busy && <p role="status">正在处理回收站操作…</p>}
    {error && <p className="detail-error" role="alert">{error}</p>}
    {notice && <p className="detail-notice" role="status">{notice}</p>}
    {restoredId && <button className="secondary-button" disabled={busy} onClick={() => onOpen(restoredId)}>打开恢复的数据仓</button>}
    {query.isPending ? <p role="status">正在加载回收站…</p> : query.isError ? <div className="panel collection-panel"><p role="alert">{query.error.message}</p>
      <button className="secondary-button" disabled={busy} onClick={() => query.refetch()}>重试回收站列表</button></div>
      : !query.data.items.length ? <div className="panel collection-panel"><h2>回收站为空</h2><p>删除或到期的数据仓会出现在这里。</p></div>
      : <div className="trash-list">{query.data.items.map(item => <article key={item.meta.id} className="panel collection-panel" aria-label={item.meta.name}>
        <h2>{item.meta.name}</h2><p>{item.meta.description || "暂无描述"}</p><code>{item.meta.id}</code>
        <p>{item.meta.deletionReason === "expired" ? "到期时间" : "删除时间"}：{new Date(item.meta.deletedAt).toLocaleString("zh-CN")} · v{item.meta.currentVersion}</p>
        {item.status === "purging" && <p>永久删除尚未完成，可重试清理；无法恢复。</p>}
        <div className="detail-actions"><button className="secondary-button" disabled={busy || item.status === "purging"} onClick={() => act("restore", item)}>恢复数据仓</button>
          <button className="danger-button" disabled={busy} onClick={() => act("purge", item)}>{item.status === "purging" ? "重试永久删除" : "永久删除"}</button></div>
      </article>)}</div>}
  </>;
}
