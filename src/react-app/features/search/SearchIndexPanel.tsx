import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { searchApi } from './api';
export function SearchIndexPanel({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const client = useQueryClient(), controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState(false);
  const index = useQuery({ queryKey: ['search-index'], queryFn: ({ signal }) => searchApi.status(signal), retry: false });
  useEffect(() => {
    const abort = () => controller.current?.abort(); window.addEventListener('jsonbin:logout', abort);
    return () => { abort(); window.removeEventListener('jsonbin:logout', abort); };
  }, []);
  async function rebuild() {
    const current = new AbortController(); controller.current = current;
    setBusy(true); onBusyChange(true); setError(''); setDone(false);
    try {
      const result = await searchApi.rebuild(current.signal);
      if (!current.signal.aborted) { client.setQueryData(['search-index'], result); await client.invalidateQueries({ queryKey: ['search'] }); setDone(true); }
    } catch (e) { if (!current.signal.aborted) setError(e instanceof Error ? e.message : '重建失败，请重试。'); }
    finally { if (!current.signal.aborted) { setBusy(false); onBusyChange(false); } }
  }
  return <section className="panel search-index-panel"><h2>搜索索引</h2><p>索引可从 R2 重新生成。索引缺失或过期时，搜索会自动读取 R2。</p>
    {index.isPending && <p role="status">正在检查搜索索引…</p>}{index.isError && <p role="alert">{index.error.message}</p>}
    {index.data && <dl className="system-statistics"><div><dt>状态</dt><dd>{!index.data.configured ? 'KV 未配置' : index.data.current ? '可用' : '等待重建或下一次搜索'}</dd></div><div><dt>最近重建</dt><dd>{index.data.builtAt ? new Date(index.data.builtAt).toLocaleString('zh-CN') : '尚未重建'}</dd></div><div><dt>索引资源数</dt><dd>{index.data.count}</dd></div></dl>}
    <div className="settings-actions"><button className="secondary-button" disabled={busy || index.isFetching} onClick={() => void index.refetch()}>刷新索引状态</button><button className="primary-button" disabled={busy || !index.data?.configured} onClick={() => void rebuild()}>{busy ? '正在重建…' : '从 R2 重建索引'}</button></div>
    {error && <p className="detail-error" role="alert">{error}</p>}{done && <p role="status">搜索索引已重建。</p>}
  </section>;
}
