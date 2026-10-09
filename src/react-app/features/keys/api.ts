export const scopes = ["bin:read", "bin:create", "bin:update", "bin:delete", "collection:read", "collection:write", "schema:read", "schema:write", "history:read"] as const;
export type ApiScope = typeof scopes[number];
export const scopeLabels: Record<ApiScope, string> = { "bin:read": "读取数据仓", "bin:create": "创建数据仓", "bin:update": "修改数据仓", "bin:delete": "删除数据仓",
  "collection:read": "读取集合", "collection:write": "管理集合", "schema:read": "读取及校验模型", "schema:write": "管理模型", "history:read": "读取版本历史" };
export type ResourceAccess = { mode: "all" } | { mode: "restricted"; binIds: string[]; collectionIds: string[] };
export type ApiKey = { id: string; name: string; prefix: string; scopes: ApiScope[]; resourceAccess?: ResourceAccess; usageTotal?: number; usageDaily?: Record<string, number>; usageApproximate?: true; usageStatus?: "ok" | "delayed" | "unavailable"; usageAsOf?: string | null; createdAt: string;
  expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null; revealable: boolean; rateLimitPerMinute?: number | null };
export type KeyInput = { name: string; scopes: ApiScope[]; expiresAt: string | null; resourceAccess?: ResourceAccess; rateLimitPerMinute?: number | null };
const messages: Record<number, string> = { 0: "无法连接 Worker API，请重试。", 401: "登录已过期，请重新登录。", 403: "请求来源无权限，请从当前站点重新操作。", 404: "密钥不存在，请刷新列表。",
  409: "该密钥的完整明文不可用；旧版本创建的密钥需要新建替代密钥。", 422: "请检查名称、权限、资源范围 UUID 格式和未来的过期时间。", 503: "密钥服务配置有误，请检查系统配置。" };
export class KeyApiError extends Error {
  status: number;
  constructor(status: number, message?: string) { super(message ?? messages[status] ?? "密钥操作失败，请重试。"); this.status = status; }
}
async function request(path: string, init: RequestInit = {}) {
  let response: Response;
  try { response = await fetch(`/api/v1/keys${path}`, { ...init, credentials: "include", cache: "no-store" }); }
  catch (error) { if (init.signal?.aborted) throw error; throw new KeyApiError(0); }
  if (!response.ok) throw new KeyApiError(response.status);
  return response;
}
export async function listKeys(signal?: AbortSignal): Promise<{ items: ApiKey[]; total: number }> { return (await request("", { signal })).json(); }
export async function createKey(input: KeyInput): Promise<{ key: ApiKey; token: string }> {
  return (await request("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })).json();
}
export async function revealKeyToken(id: string): Promise<{ token: string }> {
  return (await request(`/${encodeURIComponent(id)}/token`)).json();
}
export async function revokeKey(id: string): Promise<{ key: ApiKey }> { return (await request(`/${encodeURIComponent(id)}`, { method: "DELETE" })).json(); }

export type KeyUpdateInput = { name?: string; scopes?: ApiScope[]; expiresAt?: string | null; resourceAccess?: ResourceAccess; rateLimitPerMinute?: number | null };
export async function updateKey(id: string, input: KeyUpdateInput): Promise<{ key: ApiKey }> {
  let response: Response;
  try { response = await fetch(`/api/v1/keys/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), credentials: "include", cache: "no-store" }); }
  catch { throw new KeyApiError(0); }
  if (!response.ok) {
    if (response.status === 409) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new KeyApiError(409, body?.error === "key_revoked" ? "该密钥已撤销，权限不能再修改。" : "密钥正被并发修改，请刷新列表后重试。");
    }
    throw new KeyApiError(response.status);
  }
  return response.json();
}

export async function purgeKey(id: string): Promise<{ ok: true; id: string }> { return (await request(`/${encodeURIComponent(id)}/purge`, { method: "DELETE" })).json(); }
