import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getBinVersion, listBinVersions } from "./api";
import type { BinRecord } from "./types";

const JsonDiff = lazy(() => import("./JsonDiff"));

export default function BinHistory({ record, dark, busy, onRestore }: {
  record: BinRecord; dark: boolean; busy: boolean; onRestore: (version: number) => void;
}) {
  const { id, currentVersion, locked } = record.meta;
  const versions = useQuery({ queryKey: ["bin-versions", id, currentVersion],
    queryFn: ({ signal }) => listBinVersions(id, undefined, signal), retry: false });
  const [selected, setSelected] = useState<number | null>(null);
  const [compared, setCompared] = useState<number | "current">("current");
  const items = versions.data?.items ?? [];
  const left = selected ?? items.find(item => item.version !== currentVersion)?.version ?? currentVersion;
  const right = compared === "current" ? currentVersion : compared;
  const original = useQuery({ queryKey: ["bin-version", id, left],
    queryFn: ({ signal }) => getBinVersion(id, left, undefined, signal),
    enabled: Boolean(versions.data), staleTime: Infinity, retry: false });
  const modified = useQuery({ queryKey: ["bin-version", id, right],
    queryFn: ({ signal }) => getBinVersion(id, right, undefined, signal),
    enabled: Boolean(versions.data) && compared !== "current", staleTime: Infinity, retry: false });
  const error = versions.error ?? original.error ?? (compared !== "current" ? modified.error : null);

  if (versions.isPending) return <p role="status" className="history-message">正在加载版本历史…</p>;
  if (versions.isError) return <div className="history-message"><p role="alert">{versions.error.message}</p>
    <button className="secondary-button" onClick={() => versions.refetch()}>重试版本历史</button></div>;
  if (!items.length) return <p className="history-message">暂无历史版本。</p>;
  const leftText = original.data ? JSON.stringify(original.data.value, null, 2) : "";
  const rightText = compared === "current" ? JSON.stringify(record.value, null, 2)
    : modified.data ? JSON.stringify(modified.data.value, null, 2) : "";
  const ready = Boolean(original.data && (compared === "current" || modified.data));

  return <div className="bin-history">
    <div className="history-heading"><h2>版本历史</h2><span>共 {versions.data.total} 个版本 · 当前 v{currentVersion}</span></div>
    <p className="history-hint">恢复会将所选内容保存为新版本，已有版本保持不变。</p>
    <div className="history-table-wrap"><table className="history-table"><caption>已保存的版本</caption>
      <thead><tr><th scope="col">版本</th><th scope="col">保存时间</th><th scope="col">大小</th><th scope="col">操作</th></tr></thead>
      <tbody>{items.map(item => <tr key={item.version}>
        <th scope="row">v{item.version}{item.version === currentVersion && <span>（当前）</span>}</th>
        <td>{new Date(item.createdAt).toLocaleString("zh-CN")}</td><td>{item.size} B</td>
        <td><button className="secondary-button" aria-pressed={left === item.version} onClick={() => setSelected(item.version)}>查看 v{item.version}</button></td>
      </tr>)}</tbody>
    </table></div>
    <div className="history-controls">
      <label>原始版本<select aria-label="原始版本" value={left} onChange={event => setSelected(Number(event.target.value))}>
        {items.map(item => <option key={item.version} value={item.version}>v{item.version}</option>)}
      </select></label>
      <label>对比版本<select aria-label="对比版本" value={compared} onChange={event => setCompared(event.target.value === "current" ? "current" : Number(event.target.value))}>
        <option value="current">当前版本 v{currentVersion}</option>
        {items.map(item => <option key={item.version} value={item.version}>v{item.version}</option>)}
      </select></label>
      <button className="primary-button" disabled={busy || locked || !original.data} onClick={() => onRestore(left)}>恢复 v{left}</button>
    </div>
    {locked && <p className="history-hint">数据仓已锁定，可以查看历史，但不能恢复。</p>}
    {error && <div className="history-message"><p role="alert">{error.message}</p>
      <button className="secondary-button" onClick={() => { original.refetch(); if (compared !== "current") modified.refetch(); }}>重试版本内容</button></div>}
    {!ready && !error && <p role="status">正在加载版本内容…</p>}
    {ready && <>
      <details className="history-content"><summary>查看 v{left} 的 JSON 内容</summary><pre aria-label="历史版本内容">{leftText}</pre></details>
      <div className="history-diff-labels"><span>原始：v{left}</span><span>对比：v{right}</span></div>
      <Suspense fallback={<p role="status">正在加载版本对比…</p>}><JsonDiff original={leftText} modified={rightText} dark={dark} /></Suspense>
    </>}
  </div>;
}
