import type { SearchIndexStatus, SearchPage, SearchType } from '../../../shared/search.ts';
const messages: Record<string, string> = {
  invalid_query: '搜索条件无效，请输入 1–160 个字符。', unauthorized: '登录已过期，请重新登录。',
  insufficient_scope: '当前密钥缺少搜索所需权限。', search_changed: '数据已发生变化，请重新搜索或重建索引。',
  search_limit_exceeded: '数据超出搜索上限（10000 个对象 / 200 个资源），请减少历史或归档资源后重试。',
  search_cleanup_limit_exceeded: '本次已清理 200 个废弃索引，请再次重建以继续清理。',
  search_index_unavailable: 'KV 尚未配置或暂不可用；搜索仍可从 R2 读取。',
};
async function request<T>(path: string, signal?: AbortSignal, method = 'GET'): Promise<T> {
  const response = await fetch('/api/v1/search' + path, { credentials: 'include', signal, method });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(messages[error?.error ?? ''] ?? '搜索服务暂不可用，请稍后重试。');
  }
  return response.json() as Promise<T>;
}
export const searchApi = {
  search(q: string, type: SearchType, cursor?: string, signal?: AbortSignal) {
    const params = new URLSearchParams({ q, type, limit: '20' }); if (cursor) params.set('cursor', cursor);
    return request<SearchPage>('?' + params, signal);
  },
  status(signal?: AbortSignal) { return request<SearchIndexStatus>('/index', signal); },
  rebuild(signal?: AbortSignal) { return request<SearchIndexStatus>('/rebuild', signal, 'POST'); },
};
export function searchRoute(hash: string): { q: string; type: SearchType } {
  const params = new URLSearchParams(hash.split('?')[1] ?? ''), type = params.get('type') ?? 'all';
  return { q: (params.get('q') ?? '').trim().slice(0, 160), type: ['bin', 'collection', 'schema'].includes(type) ? type as SearchType : 'all' };
}
