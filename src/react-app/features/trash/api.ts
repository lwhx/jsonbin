import type { BinMeta, BinRecord } from "../bins/types";
export type TrashRecord = { meta: BinMeta & { deletedAt: string; deletionReason?: "manual" | "expired" }; etag: string; status: "deleted" | "expired" | "purging" };
const messages: Record<number, string> = {
  401: "登录已过期，请重新登录。", 403: "当前凭据没有回收站操作权限。", 404: "记录已恢复或已永久删除，请刷新回收站。",
  409: "记录正在永久删除，或历史文件、绑定模型缺失，暂时无法恢复。", 412: "记录已被其他请求修改，请刷新回收站后重试。",
  422: "恢复内容不符合绑定模型或请求无效，记录仍保留在回收站。", 428: "请刷新回收站后再操作。",
};
async function request(path: string, init: RequestInit = {}) {
  let response: Response;
  try { response = await fetch(`/api/v1/trash/bins${path}`, { ...init, credentials: "include", cache: "no-store" }); }
  catch (error) { if (init.signal?.aborted) throw error; throw new Error("无法连接回收站 API，请刷新确认结果后重试。"); }
  if (!response.ok) throw new Error(messages[response.status] ?? "操作未完成，请刷新回收站后重试。");
  return response;
}
export async function listTrash(signal?: AbortSignal): Promise<{ items: TrashRecord[]; total: number }> {
  return (await request("", { signal })).json();
}
export async function restoreTrash(item: TrashRecord): Promise<BinRecord> {
  return (await request(`/${encodeURIComponent(item.meta.id)}/restore`, { method: "POST", headers: { "If-Match": item.etag } })).json();
}
export async function purgeTrash(item: TrashRecord) {
  await request(`/${encodeURIComponent(item.meta.id)}`, { method: "DELETE", headers: { "If-Match": item.etag } });
}
export async function emptyTrash(items: TrashRecord[]) {
  const results: { id: string; status: number }[] = [];
  for (let offset = 0; offset < items.length; offset += 100) {
    const response = await request("/purge", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: items.slice(offset, offset + 100).map(item => ({ id: item.meta.id, etag: item.etag })) }) });
    const batch = await response.json() as { results: typeof results }; results.push(...batch.results);
  }
  return results;
}
