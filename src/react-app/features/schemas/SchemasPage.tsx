import { useQuery } from "@tanstack/react-query";
import { listSchemas } from "./api";
export function SchemasPage({ onCreate, onOpen }: { onCreate: () => void; onOpen: (id: string) => void }) {
  const query = useQuery({ queryKey: ["schemas"], queryFn: ({ signal }) => listSchemas(signal), retry: false });
  return <section><header className="hero bins-hero"><div><span className="eyebrow">JSON Schema</span><h1>数据模型</h1>
    <p>定义 JSON 结构，为数据仓绑定固定修订。编辑模型后，可在数据仓设置中主动升级。</p></div>
    <button className="primary-button" onClick={onCreate}>新建数据模型</button></header>
    {query.isPending ? <p role="status">正在加载模型…</p> : query.isError ? <div className="panel collection-panel"><p role="alert">{query.error.message}</p>
      <button className="secondary-button" onClick={() => query.refetch()}>重试数据模型</button></div> : query.data.items.length ?
      <div className="bin-grid">{query.data.items.map(meta => <article className="bin-card" key={meta.id}><h3>{meta.name}</h3>
        <p>{meta.description || "暂无描述"}</p><p>修订 r{meta.currentRevision}</p><button className="secondary-button" onClick={() => onOpen(meta.id)}>打开模型 {meta.name}</button></article>)}</div>
      : <div className="panel collection-panel"><p>暂无数据模型，创建一个来校验 JSON 内容。</p></div>}
  </section>;
}
