import type { BinRecord, MetadataInput } from "./types";

const endpoint = "/api/v1/bins";
const messages: Record<number, string> = {
  0: "无法连接 Worker API，请检查网络后重试。",
  401: "登录已过期，请重新登录。",
  404: "数据仓不存在或已被删除。",
  412: "数据已被其他请求修改。请重新加载后再保存；当前草稿已保留。",
  422: "内容校验失败，请检查输入。",
  423: "数据仓已锁定，无法修改。当前草稿已保留。",
};
export class BinApiError extends Error {
  status: number;
  constructor(status: number) {
    super(messages[status] ?? "操作失败，请稍后重试。当前草稿已保留。");
    this.status = status;
  }
}
async function request(url: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try { response = await fetch(url, { ...init, credentials: "include" }); }
  catch (error) {
    if (init.signal?.aborted) throw error;
    throw new BinApiError(0);
  }
  if (!response.ok) throw new BinApiError(response.status);
  return response;
}
async function recordResponse(response: Response): Promise<BinRecord> {
  const record = await response.json() as BinRecord;
  return { ...record, etag: response.headers.get("ETag") ?? record.etag };
}
export async function getBin(id: string, base = endpoint, signal?: AbortSignal) {
  return recordResponse(await request(`${base}/${encodeURIComponent(id)}`, { signal }));
}
export async function saveBin(id: string, value: unknown, etag: string, base = endpoint) {
  return recordResponse(await request(`${base}/${encodeURIComponent(id)}`, {
    method: "PUT", headers: { "Content-Type": "application/json", "If-Match": etag },
    body: JSON.stringify({ value }),
  }));
}
export async function saveBinMetadata(id: string, input: MetadataInput, etag: string, base = endpoint) {
  return recordResponse(await request(`${base}/${encodeURIComponent(id)}/meta`, {
    method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": etag },
    body: JSON.stringify(input),
  }));
}
export async function removeBin(id: string, base = endpoint) {
  await request(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
}
