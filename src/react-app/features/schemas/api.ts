export type SchemaIssue = { path: string; keyword: string; message: string };
export type SchemaMeta = { id: string; name: string; description: string; currentRevision: number;
  createdAt: string; updatedAt: string; status: "active" | "deleted" };
export type SchemaDefinition = Record<string, unknown> | boolean;
export type SchemaRecord = { meta: SchemaMeta; schema: SchemaDefinition; etag: string };
export type SchemaInput = { name: string; description: string; schema: SchemaDefinition };
export type ValidationResult = { valid: boolean; issues: SchemaIssue[]; revision: number };
export const schemaHash = (id: string) => `#/schemas/${encodeURIComponent(id)}`;
export function schemaIdFromHash(hash: string) {
  const match = /^#\/schemas\/([0-9a-f-]{36})$/i.exec(hash); return match?.[1] ?? null;
}
const messages: Record<number, string> = { 0: "无法连接 Worker API，请重试。", 401: "登录已过期，请重新登录。",
  404: "数据模型不存在或已删除。", 412: "模型已被其他请求修改。请重新加载；当前草稿已保留。",
  422: "模型定义或输入校验失败，请检查字段错误。", 428: "请重新加载模型后再操作。" };
export class SchemaApiError extends Error {
  status: number;
  issues: SchemaIssue[];
  constructor(status: number, issues: SchemaIssue[] = []) { super(messages[status] ?? "数据模型操作失败，请重试。"); this.status = status; this.issues = issues; }
}
async function request(path = "", init: RequestInit = {}) {
  let response: Response;
  try { response = await fetch(`/api/v1/schemas${path}`, { ...init, credentials: "include" }); }
  catch (error) { if (init.signal?.aborted) throw error; throw new SchemaApiError(0); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { issues?: SchemaIssue[] };
    throw new SchemaApiError(response.status, body.issues?.filter(issue => typeof issue.path === "string") ?? []);
  }
  return response;
}
async function record(response: Response): Promise<SchemaRecord> {
  const data = await response.json() as SchemaRecord;
  return { ...data, etag: response.headers.get("ETag") ?? data.etag };
}
export async function listSchemas(signal?: AbortSignal): Promise<{ items: SchemaMeta[]; total: number }> {
  return (await request("", { signal })).json();
}
export async function getSchema(id: string, signal?: AbortSignal) { return record(await request(`/${encodeURIComponent(id)}`, { signal })); }
export async function saveSchema(input: SchemaInput, id?: string, etag?: string) {
  return record(await request(id ? `/${encodeURIComponent(id)}` : "", { method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}) }, body: JSON.stringify(input) }));
}
export async function removeSchema(id: string, etag: string) { await request(`/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "If-Match": etag } }); }
export async function validateSample(id: string, value: unknown): Promise<ValidationResult> {
  return (await request(`/${encodeURIComponent(id)}/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) })).json();
}
