import { useState } from 'react';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { ACTIVITY_ACTIONS, type ActivityAction, type ActivityPage as Page, type ActivityResourceType } from '../../../shared/activity';
import { ActivityApiError, listActivity } from './api';
const resources: Record<ActivityResourceType, string> = {
  system: '系统', auth: '身份认证', bin: '数据仓', collection: '集合', schema: '数据模型', key: 'API 密钥', template: '模板',
};
const identities = { session: '管理 Session', api_key: 'API Key', anonymous: '匿名', system: '系统任务' };
const providers = { password: '密码', github: 'GitHub', api_key: 'API Key', anonymous: '匿名', system: '系统' };
export function ActivityPage() {
  const client = useQueryClient();
  const [action, setAction] = useState<ActivityAction | ''>('');
  const [resourceType, setResourceType] = useState<ActivityResourceType | ''>('');
  const [generation, setGeneration] = useState(0);
  const [fallback, setFallback] = useState<InfiniteData<Page> | null>(null);
  const key = ['activity', action, resourceType, generation];
  const query = useInfiniteQuery({ queryKey: key, initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => listActivity({ limit: 50, action: action || undefined, resourceType: resourceType || undefined, cursor: pageParam }, signal),
    getNextPageParam: page => page.nextCursor ?? undefined, retry: false });
  const data = query.data ?? fallback;
  const entries = data?.pages.flatMap(page => page.items) ?? [];
  const unique = entries.filter((entry, index) => entries.findIndex(other => other.id === entry.id) === index);
  function refresh() {
    setFallback(data ?? null);
    void client.cancelQueries({ queryKey: key, exact: true });
    setGeneration(previous => previous + 1);
  }
  return <section className="activity-page">
    <header className="hero bins-hero"><div><span className="eyebrow">最近操作</span><h1>活动记录</h1>
      <p>记录重要操作的时间、资源及身份，不保存密码、Token 或 JSON 内容。</p></div>
      <button className="secondary-button" disabled={query.isPending && !data} onClick={refresh}>刷新活动</button></header>
    <div className="activity-filters">
      <label>资源类型<select aria-label="资源类型" value={resourceType} onChange={event => { setFallback(null); setResourceType(event.target.value as typeof resourceType); }}>
        <option value="">全部资源</option>{Object.entries(resources).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>操作类型<select aria-label="操作类型" value={action} onChange={event => { setFallback(null); setAction(event.target.value as typeof action); }}>
        <option value="">全部操作</option>{Object.entries(ACTIVITY_ACTIONS).map(([value, [, label]]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
    </div>
    <p className="activity-policy">每 15 分钟清理至最近 2000 条，短时可能超过上限。业务与记录独立写入，存储故障或任务中断可能缺少记录。</p>
    {query.isFetching && <p role="status">正在加载活动记录…</p>}
    {query.isError && <div className="detail-error" role="alert">{query.error.message}
      <button className="secondary-button" onClick={refresh}>重试活动</button>
      {query.error instanceof ActivityApiError && query.error.status === 401 && <button className="secondary-button" onClick={() => client.invalidateQueries({ queryKey: ['auth-me'] })}>重新登录</button>}
    </div>}
    {data && unique.length === 0 && <div className="panel collection-panel"><h2>暂无活动记录</h2><p>{query.hasNextPage ? '当前页没有匹配记录，可继续加载。' : '重要操作发生后会显示在这里。'}</p></div>}
    <div className="activity-entries">{unique.map(entry => <article className="panel activity-entry" key={entry.id}>
      <div className="activity-entry-heading"><h2>{entry.summary}</h2><time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleString('zh-CN')}</time></div>
      <dl><div><dt>资源</dt><dd>{resources[entry.resourceType]}{entry.resourceId && <> · <code>{entry.resourceId}</code></>}</dd></div>
        <div><dt>身份</dt><dd>{identities[entry.actor.type]}{entry.actor.id && <> · <code>{entry.actor.id}</code></>} · {providers[entry.provider]}</dd></div>
        <div><dt>请求 ID</dt><dd><code>{entry.requestId}</code></dd></div></dl>
    </article>)}</div>
    {query.hasNextPage && <button className="secondary-button" disabled={query.isFetching || query.isError} onClick={() => query.fetchNextPage()}>加载更多活动</button>}
  </section>;
}
