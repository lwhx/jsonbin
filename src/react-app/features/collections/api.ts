import type { BinMeta } from "../bins/types";

export type CollectionMeta = { id: string; name: string; description: string; slug: string;
  createdAt: string; updatedAt: string; status: "active" | "deleting" };
export type CollectionRecord = { meta: CollectionMeta; etag: string; binCount?: number };
export type CollectionInput = { name: string; description: string };
export type CollectionList = { items: (CollectionMeta & { binCount: number })[]; total: number };

const endpoint = "/api/v1/collections";
async function request(path: string, init: RequestInit = {}) {
  let response: Response;
  try { response = await fetch(endpoint + path, { ...init, credentials: "include" }); }
  catch (error) { if (init.signal?.aborted) throw error; throw new Error("无法连接集合 API，请检查网络后重试。"); }
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (response.status === 401) throw new Error("登录已过期，请重新登录；未保存内容已保留。");
    if (response.status === 404) throw new Error("集合不存在或已被删除。");
    if (response.status === 412) throw new Error("集合已被其他请求修改，请重新加载；未保存内容已保留。");
    if (response.status === 422) throw new Error("名称不能为空且不超过 160 字符，描述不超过 1000 字符。");
    if (response.status === 428) throw new Error("请重新加载集合后再操作。");
    if (data.error === "collection_delete_conflict") throw new Error("部分关联尚未解除，请重试删除完成清理；数据仓已保留。");
    if (response.status === 409) throw new Error("集合正在删除，请完成删除后再操作。");
    throw new Error("集合操作失败，请稍后重试；未保存内容已保留。");
  }
  return response;
}
async function record(response: Response): Promise<CollectionRecord> {
  const data = await response.json() as CollectionRecord;
  return { ...data, etag: response.headers.get("ETag") ?? data.etag };
}
export async function listCollections(signal?: AbortSignal): Promise<CollectionList> { return (await request("", { signal })).json(); }
export async function getCollection(id: string, signal?: AbortSignal) { return record(await request(`/${encodeURIComponent(id)}`, { signal })); }
export async function getCollectionBins(id: string, signal?: AbortSignal): Promise<{ items: BinMeta[]; total: number }> {
  return (await request(`/${encodeURIComponent(id)}/bins`, { signal })).json();
}
export async function createCollection(input: CollectionInput) {
  return record(await request("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }));
}
export async function saveCollection(id: string, input: CollectionInput, etag: string) {
  return record(await request(`/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": etag }, body: JSON.stringify(input) }));
}
export async function removeCollection(id: string, etag: string) {
  await request(`/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "If-Match": etag } });
}
export function collectionHash(id: string) { return `#/collections/${encodeURIComponent(id)}`; }
export function collectionIdFromHash(hash: string) {
  const match = /^#\/collections\/([^/]+)$/.exec(hash);
  if (!match || match[1] === "new") return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}
