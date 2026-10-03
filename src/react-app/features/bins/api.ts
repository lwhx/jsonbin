import type { BinRecord, MetadataInput, BinVersionRecord, BinVersionList } from "./types";

import type { SchemaIssue } from "../schemas/api";

const endpoint = "/api/v1/bins";
const messages: Record<number, string> = {
  0: "无法连接 Worker API，请检查网络后重试。",
  401: "登录已过期，请重新登录。",
  404: "数据仓不存在或已被删除。",
  409: "集合已删除或正在删除，请重新选择集合。当前草稿已保留。",
  412: "数据已被其他请求修改。请重新加载后再保存；当前草稿已保留。",
  422: "内容校验失败，请检查输入。",
  423: "数据仓已锁定，无法修改。当前草稿已保留。",
  428: "请重新加载当前版本后再操作。",
};
export class BinApiError extends Error {
  status: number;
  issues: SchemaIssue[];
  constructor(status: number, issues: SchemaIssue[] = [], code?: string) {
    const schemaMessages: Record<string, string> = {
      schema_validation_failed: "JSON 不符合绑定的模型，当前草稿已保留。",
      schema_locked: "模型绑定已锁定，请先单独解除模型锁定并保存。",
      schema_unavailable: "模型已删除或不可用，请重新选择。",
      schema_required: "请先绑定数据模型，再锁定或升级修订。",
    };
    super((code && schemaMessages[code]) || messages[status] || "操作失败，请稍后重试。当前草稿已保留。");
    this.status = status; this.issues = issues;
  }
}
async function request(url: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try { response = await fetch(url, { ...init, credentials: "include" }); }
  catch (error) {
    if (init.signal?.aborted) throw error;
    throw new BinApiError(0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; issues?: SchemaIssue[] };
    throw new BinApiError(response.status, body.issues?.filter(issue => typeof issue.path === "string") ?? [], body.error);
  }
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
export async function saveBinMetadata(id: string, input: Partial<MetadataInput> & { locked?: boolean }, etag: string, base = endpoint) {
  return recordResponse(await request(`${base}/${encodeURIComponent(id)}/meta`, {
    method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": etag },
    body: JSON.stringify(input),
  }));
}
export async function removeBin(id: string, base = endpoint, etag?: string) {
  await request(`${base}/${encodeURIComponent(id)}`, { method: "DELETE", headers: etag ? { "If-Match": etag } : undefined });
}

export async function listBinVersions(id: string, base = endpoint, signal?: AbortSignal): Promise<BinVersionList> {
  return (await request(`${base}/${encodeURIComponent(id)}/versions`, { signal })).json();
}
export async function getBinVersion(id: string, version: number, base = endpoint, signal?: AbortSignal): Promise<BinVersionRecord> {
  const response = await request(`${base}/${encodeURIComponent(id)}/versions/${version}`, { signal });
  const record = await response.json() as BinVersionRecord;
  return { ...record, etag: response.headers.get("ETag") ?? record.etag };
}
export async function restoreBinVersion(id: string, version: number, etag: string, base = endpoint) {
  return recordResponse(await request(`${base}/${encodeURIComponent(id)}/versions/${version}/restore`, {
    method: "POST", headers: { "If-Match": etag },
  }));
}
