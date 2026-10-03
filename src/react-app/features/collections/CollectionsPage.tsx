import { useQuery } from "@tanstack/react-query";
import { listCollections } from "./api";

export function CollectionsPage({ onCreate, onOpen }: { onCreate: () => void; onOpen: (id: string) => void }) {
  const query = useQuery({ queryKey: ["collections"], queryFn: ({ signal }) => listCollections(signal), retry: false });
  return <>
    <section className="hero bins-hero"><div><span className="eyebrow">数据组织</span><h1>集合</h1><p>按用途组织数据仓，JSON 和版本仍独立保存。</p></div>
      <button className="primary-button" onClick={onCreate}>新建集合</button></section>
    {query.isPending ? <p role="status">正在加载集合…</p> : query.isError ? <div className="panel collection-panel">
      <p role="alert">{query.error.message}</p><button className="secondary-button" onClick={() => query.refetch()}>重试集合列表</button></div>
      : query.data.items.length ? <div className="bin-grid">{query.data.items.map(item => <button className="bin-card" key={item.id} aria-label={`打开集合 ${item.name}`} onClick={() => onOpen(item.id)}>
        <h3>{item.name}</h3><p>{item.description || "暂无描述"}</p><span>{item.binCount} 个数据仓</span>
        {item.status === "deleting" && <p>删除待完成，可重试清理</p>}
      </button>)}</div> : <div className="panel collection-panel"><h2>还没有集合</h2><p>新建集合后，可以在数据仓设置中添加成员。</p></div>}
  </>;
}
