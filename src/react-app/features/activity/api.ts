import type { ActivityPage, ActivityQuery } from '../../../shared/activity';
const messages: Record<number, string> = { 0: '无法连接活动 API，请检查网络后重试。', 400: '筛选或分页参数无效，请刷新活动后重试。',
  401: '登录已过期，请重新登录。', 500: '无法加载活动记录，请稍后重试。' };
export class ActivityApiError extends Error {
  status: number;
  constructor(status: number) { super(messages[status] ?? '无法加载活动记录，请稍后重试。'); this.status = status; }
}
export async function listActivity(query: ActivityQuery, signal?: AbortSignal, base = '/api/v1/activity'): Promise<ActivityPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
  let response: Response;
  try { response = await fetch(`${base}?${params}`, { credentials: 'include', cache: 'no-store', signal }); }
  catch (error) { if (signal?.aborted) throw error; throw new ActivityApiError(0); }
  if (!response.ok) throw new ActivityApiError(response.status);
  return response.json();
}
