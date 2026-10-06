import { mapHttpError, JsonBinError } from "./errors.js";
import type {
  JsonBinOptions,
  BinRecord,
  BinMeta,
  CreateBinInput,
  JsonPatchOperation,
} from "./types.js";

export * from "./errors.js";
export * from "./types.js";

export class JsonBinClient {
  private baseUrl: string;
  private token?: string;
  private timeoutMs: number;

  constructor(options: JsonBinOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  private async request<T = any>(
    path: string,
    init: RequestInit & { ifMatch?: string; ifNoneMatch?: string } = {},
  ): Promise<{ data: T; etag: string; status: number; headers: Headers }> {
    const url = `${this.baseUrl}/api/v1${path.startsWith("/") ? path : `/${path}`}`;
    const headers = new Headers(init.headers);

    if (this.token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }
    if (init.ifMatch) {
      headers.set("If-Match", init.ifMatch);
    }
    if (init.ifNoneMatch) {
      headers.set("If-None-Match", init.ifNoneMatch);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (init.signal) {
      init.signal.addEventListener("abort", () => controller.abort());
    }

    try {
      const res = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });

      const etag = res.headers.get("ETag") || "";

      if (res.status === 304) {
        return { data: null as any, etag, status: 304, headers: res.headers };
      }

      const text = await res.text();
      let body: any = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }

      if (!res.ok) {
        throw mapHttpError(res.status, body, res.headers);
      }

      return { data: body as T, etag, status: res.status, headers: res.headers };
    } finally {
      clearTimeout(timer);
    }
  }

  readonly bins = {
    list: async (params?: { tag?: string; favorite?: boolean; pinned?: boolean }): Promise<{ items: BinMeta[]; total: number }> => {
      const q = new URLSearchParams();
      if (params?.tag) q.set("tag", params.tag);
      if (params?.favorite !== undefined) q.set("favorite", String(params.favorite));
      if (params?.pinned !== undefined) q.set("pinned", String(params.pinned));
      const qs = q.toString();
      const res = await this.request<{ items: BinMeta[]; total: number }>(`/bins${qs ? `?${qs}` : ""}`);
      return res.data;
    },

    getById: async <T = unknown>(id: string, options?: { ifNoneMatch?: string }): Promise<BinRecord<T> | { modified: false; etag: string }> => {
      const res = await this.request<BinRecord<T>>(`/bins/${encodeURIComponent(id)}`, { ifNoneMatch: options?.ifNoneMatch });
      if (res.status === 304) return { modified: false, etag: res.etag };
      return res.data;
    },

    getBySlug: async <T = unknown>(slug: string, options?: { ifNoneMatch?: string }): Promise<BinRecord<T> | { modified: false; etag: string }> => {
      const res = await this.request<BinRecord<T>>(`/b/${encodeURIComponent(slug)}`, { ifNoneMatch: options?.ifNoneMatch });
      if (res.status === 304) return { modified: false, etag: res.etag };
      return res.data;
    },

    getPublishedById: async <T = unknown>(id: string, options?: { ifNoneMatch?: string }): Promise<BinRecord<T> | { modified: false; etag: string }> => {
      const res = await this.request<BinRecord<T>>(`/bins/${encodeURIComponent(id)}/published`, { ifNoneMatch: options?.ifNoneMatch });
      if (res.status === 304) return { modified: false, etag: res.etag };
      return res.data;
    },

    getPublishedBySlug: async <T = unknown>(slug: string, options?: { ifNoneMatch?: string }): Promise<BinRecord<T> | { modified: false; etag: string }> => {
      const res = await this.request<BinRecord<T>>(`/b/${encodeURIComponent(slug)}/published`, { ifNoneMatch: options?.ifNoneMatch });
      if (res.status === 304) return { modified: false, etag: res.etag };
      return res.data;
    },

    get: async <T = unknown>(idOrSlug: string, options?: { ifNoneMatch?: string }): Promise<BinRecord<T> | { modified: false; etag: string }> => {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
      const path = isUuid ? `/bins/${idOrSlug}` : `/b/${idOrSlug}`;
      const res = await this.request<BinRecord<T>>(path, { ifNoneMatch: options?.ifNoneMatch });
      if (res.status === 304) {
        return { modified: false, etag: res.etag };
      }
      return res.data;
    },

    getPublished: async <T = unknown>(idOrSlug: string, options?: { ifNoneMatch?: string }): Promise<BinRecord<T> | { modified: false; etag: string }> => {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
      const path = isUuid ? `/bins/${idOrSlug}/published` : `/b/${idOrSlug}/published`;
      const res = await this.request<BinRecord<T>>(path, { ifNoneMatch: options?.ifNoneMatch });
      if (res.status === 304) {
        return { modified: false, etag: res.etag };
      }
      return res.data;
    },

    create: async <T = unknown>(input: CreateBinInput<T>): Promise<BinRecord<T>> => {
      const res = await this.request<BinRecord<T>>("/bins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return res.data;
    },

    update: async <T = unknown>(id: string, value: T, options: { etag: string; message?: string }): Promise<BinRecord<T>> => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (options.message) {
        headers["X-JSONBin-Message"] = encodeURIComponent(options.message);
      }
      const res = await this.request<BinRecord<T>>(`/bins/${id}`, {
        method: "PUT",
        headers,
        ifMatch: options.etag,
        body: JSON.stringify({ value }),
      });
      return res.data;
    },

    mergePatch: async <T = unknown>(id: string, patch: Record<string, unknown>, options: { etag: string }): Promise<BinRecord<T>> => {
      const res = await this.request<BinRecord<T>>(`/bins/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/merge-patch+json" },
        ifMatch: options.etag,
        body: JSON.stringify(patch),
      });
      return res.data;
    },

    jsonPatch: async <T = unknown>(id: string, patch: JsonPatchOperation[], options: { etag: string }): Promise<BinRecord<T>> => {
      const res = await this.request<BinRecord<T>>(`/bins/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json-patch+json" },
        ifMatch: options.etag,
        body: JSON.stringify(patch),
      });
      return res.data;
    },

    publish: async (id: string, options: { version?: number; etag: string }): Promise<BinRecord> => {
      const res = await this.request<BinRecord>(`/bins/${id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ifMatch: options.etag,
        body: JSON.stringify({ version: options.version }),
      });
      return res.data;
    },

    rollback: async (id: string, options: { version: number; etag: string }): Promise<BinRecord> => {
      const res = await this.request<BinRecord>(`/bins/${id}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ifMatch: options.etag,
        body: JSON.stringify({ version: options.version }),
      });
      return res.data;
    },

    clone: async (id: string, options: { etag: string }): Promise<BinRecord> => {
      const res = await this.request<BinRecord>(`/bins/${id}/clone`, {
        method: "POST",
        ifMatch: options.etag,
      });
      return res.data;
    },

    delete: async (id: string, options?: { etag?: string }): Promise<{ ok: boolean }> => {
      const res = await this.request<{ ok: boolean }>(`/bins/${id}`, {
        method: "DELETE",
        ifMatch: options?.etag,
      });
      return res.data;
    },
  };

  readonly search = {
    metadata: async (query: string) => {
      const res = await this.request<{ items: any[]; total: number }>(`/search?q=${encodeURIComponent(query)}`);
      return res.data;
    },
    content: async (query: string, mode?: "keys" | "all") => {
      const qs = mode ? `&mode=${mode}` : "";
      const res = await this.request<{ items: any[]; total: number }>(`/search/content?q=${encodeURIComponent(query)}${qs}`);
      return res.data;
    },
  };
}

export const JsonBin = JsonBinClient;
