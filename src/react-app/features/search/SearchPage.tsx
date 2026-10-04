import { useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { SearchItem, SearchType } from '../../../shared/search.ts';
import { searchApi, searchRoute } from './api';
import { binHash } from '../bins/navigation';
import { collectionHash } from '../collections/api';
import { schemaHash } from '../schemas/api';
const labels = { all: '全部', bin: '数据仓', collection: '集合', schema: '数据模型' };
export function SearchPage({ route }: { route: string }) {
  const client = useQueryClient(), active = searchRoute(route);
  const [text, setText] = useState(active.q), [type, setType] = useState<SearchType>(active.type);
  const queryKey = ['search', active.q, active.type];
  const results = useInfiniteQuery({ queryKey, enabled: Boolean(active.q), retry: false,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => searchApi.search(active.q, active.type, pageParam, signal),
    getNextPageParam: page => page.nextCursor ?? undefined });
  function submit(event: FormEvent) {
    event.preventDefault(); if (!text.trim()) return;
    const hash = '/search?' + new URLSearchParams({ q: text.trim(), type });
    if ('#' + hash === route) void client.resetQueries({ queryKey, exact: true });
    else window.location.hash = hash;
  }
  function open(item: SearchItem) { return item.type === 'bin' ? binHash(item.id) : item.type === 'collection' ? collectionHash(item.id) : schemaHash(item.id); }
  const items = results.data?.pages.flatMap(page => page.items) ?? [];
  return <section className="search-page"><header className="hero bins-hero"><div><span className="eyebrow">全局搜索</span><h1>搜索</h1><p>查找名称、描述和 ID，也可用集合名称或 ID 查找其中的数据仓。</p></div></header>
    <form className="panel global-search-form" onSubmit={submit}><label>搜索内容<input autoFocus name="q" maxLength={160} value={text} onChange={e => setText(e.target.value)} placeholder="输入名称、描述、ID 或集合" /></label>
      <label>搜索范围<select value={type} onChange={e => setType(e.target.value as SearchType)}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button className="primary-button" disabled={!text.trim()} type="submit">搜索</button></form>
    {!active.q && <p role="status">输入搜索内容后按 Enter 开始。搜索不读取 JSON 正文。</p>}
    {active.q && results.isPending && <p role="status">正在搜索…</p>}
    {results.isError && <div className="detail-error" role="alert">{results.error.message}<button className="secondary-button" onClick={() => void client.resetQueries({ queryKey, exact: true })}>重新搜索</button></div>}
    {active.q && results.isSuccess && items.length === 0 && <p role="status">没有找到匹配结果，请尝试名称、描述、ID 或集合。</p>}
    {!results.isError && items.length > 0 && <><p role="status">已显示 {items.length} 条结果{results.isFetching && '，正在刷新…'}</p><ul className="global-search-results">{items.map(item => <li key={`${item.type}:${item.id}`}><a className="panel search-result" href={open(item)}><span className="search-result-type">{labels[item.type]}</span><strong>{item.name}</strong><p>{item.description || '暂无描述'}</p><code>{item.id}</code>{item.collectionName && <span>集合：{item.collectionName}</span>}</a></li>)}</ul>
      {results.hasNextPage && <button className="secondary-button" disabled={results.isFetching} onClick={() => void results.fetchNextPage()}>{results.isFetchingNextPage ? '正在加载…' : '加载更多结果'}</button>}</>}
  </section>;
}
