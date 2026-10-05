export const eventPatterns = ["bin.*", "collection.*", "schema.*", "template.*", "system.*"] as const;
export const patternLabels: Record<string, string> = {
  "bin.*": "数据仓（全部事件）", "collection.*": "集合（全部事件）", "schema.*": "数据模型（全部事件）",
  "template.*": "模板（全部事件）", "system.*": "系统（全部事件）",
};
export type Webhook = {
  id: string; name: string; url: string; secret: string; events: string[];
  active: boolean; createdAt: string; updatedAt: string;
};
export type WebhookDelivery = {
  id: string; webhookId: string; event: string; attempts: number; maxAttempts: number;
  nextRetryAt: string; status: "pending" | "delivered" | "failed"; lastError?: string;
  lastStatusCode?: number; deliveredAt?: string; createdAt: string;
};
export type WebhookInput = { name: string; url: string; secret: string; events: string[]; active?: boolean };

const messages: Record<number, string> = { 0: "无法连接 Worker API，请重试。", 401: "登录已过期，请重新登录。", 404: "Webhook 不存在，请刷新列表。",
  412: "该 Webhook 已被并发修改，请刷新后重试。", 422: "请检查名称、http(s) URL、至少 16 位密钥和事件选择。", 428: "缺少 If-Match 前置条件，请刷新后重试。" };
export class WebhookApiError extends Error {
  status: number;
  constructor(status: number) { super(messages[status] ?? "Webhook 操作失败，请重试。"); this.status = status; }
}
async function request(path: string, init: RequestInit = {}) {
  let response: Response;
  try { response = await fetch(`/api/v1/webhooks${path}`, { ...init, credentials: "include", cache: "no-store" }); }
  catch { throw new WebhookApiError(0); }
  if (!response.ok) throw new WebhookApiError(response.status);
  return response;
}
const etagCache = new Map<string, string>();
/** The authoritative ETag comes from the detail endpoint; use before conditional writes. */
export async function webhookEtag(id: string, signal?: AbortSignal): Promise<string> {
  const response = await request(`/${encodeURIComponent(id)}`, { signal });
  const etag = response.headers.get("etag");
  if (etag) etagCache.set(id, etag);
  return etag ?? etagCache.get(id) ?? "";
}
export async function listWebhooks(signal?: AbortSignal): Promise<{ items: Webhook[]; total: number }> {
  return (await request("", { signal })).json();
}
export async function createWebhook(input: WebhookInput): Promise<Webhook> {
  return (await request("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })).json();
}
export async function updateWebhook(id: string, etag: string, input: Partial<WebhookInput>): Promise<Webhook> {
  return (await request(`/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": etag }, body: JSON.stringify(input) })).json();
}
export async function deleteWebhook(id: string, etag: string): Promise<void> {
  await request(`/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "If-Match": etag } });
}
export async function listDeliveries(id: string, signal?: AbortSignal): Promise<{ items: WebhookDelivery[] }> {
  return (await request(`/${encodeURIComponent(id)}/deliveries`, { signal })).json();
}
export async function testWebhook(id: string): Promise<WebhookDelivery | null> {
  return (await (await request(`/${encodeURIComponent(id)}/test`, { method: "POST" })).json()).delivery;
}
export function randomSecret() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}
