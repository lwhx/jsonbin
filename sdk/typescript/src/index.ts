import { mapHttpError, JsonBinError } from "./errors.js";
import type {
  JsonBinOptions,
  BinRecord,
  BinMeta,
  BinVersionList,
  BinVersionRecord,
  CreateBinInput,
  JsonPatchOperation,
  SearchMetadataResult,
  TrashEntry,
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

    listVersions: async (id: string): Promise<BinVersionList> => {
      const res = await this.request<BinVersionList>(`/bins/${id}/versions`);
      return res.data;
    },

    getVersion: async <T = unknown>(id: string, version: number): Promise<BinVersionRecord<T>> => {
      const res = await this.request<BinVersionRecord<T>>(`/bins/${id}/versions/${version}`);
      return res.data;
    },
  };

  readonly search = {
    metadata: async (query: string, options?: { type?: "all" | "bin" | "collection" | "schema"; limit?: number; cursor?: string }): Promise<SearchMetadataResult> => {
      const type = options?.type ?? "all";
      const limit = options?.limit ?? 20;
      const cursor = options?.cursor ? `&cursor=${encodeURIComponent(options.cursor)}` : "";
      const res = await this.request<SearchMetadataResult>(`/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}${cursor}`);
      return res.data;
    },
    content: async (query: string, mode?: "keys" | "all") => {
      const qs = mode ? `&mode=${mode}` : "";
      const res = await this.request<{ items: any[]; total: number }>(`/search/content?q=${encodeURIComponent(query)}${qs}`);
      return res.data;
    },
  };

  readonly collections = {
    list: async (): Promise<{ items: any[]; total: number }> => {
      const res = await this.request<{ items: any[]; total: number }>("/collections");
      return res.data;
    },
    get: async (id: string): Promise<any> => {
      const res = await this.request<any>(`/collections/${id}`);
      return res.data;
    },
    create: async (input: { name: string; description?: string }): Promise<any> => {
      const res = await this.request<any>("/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return res.data;
    },
    update: async (id: string, input: { name?: string; description?: string }, options: { etag: string }): Promise<any> => {
      const res = await this.request<any>(`/collections/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        ifMatch: options.etag,
        body: JSON.stringify(input),
      });
      return res.data;
    },
    delete: async (id: string, options: { etag: string }): Promise<{ ok: boolean }> => {
      const res = await this.request<{ ok: boolean }>(`/collections/${id}`, {
        method: "DELETE",
        ifMatch: options.etag,
      });
      return res.data;
    },
  };

  readonly schemas = {
    list: async (): Promise<{ items: any[]; total: number }> => {
      const res = await this.request<{ items: any[]; total: number }>("/schemas");
      return res.data;
    },
    get: async (id: string): Promise<any> => {
      const res = await this.request<any>(`/schemas/${id}`);
      return res.data;
    },
    create: async (input: { name: string; description?: string; schema: Record<string, unknown> }): Promise<any> => {
      const res = await this.request<any>("/schemas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return res.data;
    },
    update: async (id: string, input: { name?: string; description?: string; schema?: Record<string, unknown> }, options: { etag: string }): Promise<any> => {
      const res = await this.request<any>(`/schemas/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        ifMatch: options.etag,
        body: JSON.stringify(input),
      });
      return res.data;
    },
    delete: async (id: string, options: { etag: string }): Promise<{ ok: boolean }> => {
      const res = await this.request<{ ok: boolean }>(`/schemas/${id}`, {
        method: "DELETE",
        ifMatch: options.etag,
      });
      return res.data;
    },
    validate: async (id: string, value: unknown): Promise<{ valid: boolean; issues?: any[] }> => {
      const res = await this.request<{ valid: boolean; issues?: any[] }>(`/schemas/${id}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      return res.data;
    },
  };

  // API key management is intentionally not exposed: those endpoints are
  // Session-only and this client is Bearer-only, so such methods could only
  // ever fail with 401 while implying they work.
  readonly trash = {
    list: async (): Promise<{ items: TrashEntry[]; total: number }> => {
      const res = await this.request<{ items: TrashEntry[]; total: number }>("/trash/bins");
      return res.data;
    },
    restore: async (id: string, options: { etag: string }): Promise<BinRecord> => {
      const res = await this.request<BinRecord>(`/trash/bins/${id}/restore`, {
        method: "POST",
        ifMatch: options.etag,
      });
      return res.data;
    },
    purge: async (id: string, options: { etag: string }): Promise<{ ok: boolean }> => {
      const res = await this.request<{ ok: boolean }>(`/trash/bins/${id}`, {
        method: "DELETE",
        ifMatch: options.etag,
      });
      return res.data;
    },
    /**
     * Permanently purge the explicit client-approved snapshots only. The API
     * deliberately has no "empty everything" form: each item carries the ETag
     * of the trash entry the caller confirmed.
     */
    purgeMany: async (items: Array<{ id: string; etag: string }>): Promise<{ results: Array<{ id: string; status: number }> }> => {
      const res = await this.request<{ results: Array<{ id: string; status: number }> }>("/trash/bins/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      return res.data;
    },
  };
}

export const JsonBin = JsonBinClient;
