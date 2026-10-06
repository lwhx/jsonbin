import { useState } from "react";
import { useConfirm } from "../../components/ConfirmDialog";

/** Dangerous operations require an explicit confirmation before sending. */
function isDangerousRequest(method: string, endpoint: string) {
  if (method === "DELETE") return true;
  return /purge|restore|rollback|\/batch|\/import|\/trash/i.test(endpoint);
}

function resourceHint(endpoint: string) {
  const segments = endpoint.split("?")[0].split("/").filter(Boolean);
  return segments.slice(-2).join("/") || endpoint;
}

export function ApiDebugger() {
  const confirm = useConfirm();
  const [method, setMethod] = useState<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">("GET");
  const [endpoint, setEndpoint] = useState("/system/health");
  const [bearerToken, setBearerToken] = useState("");
  const [ifMatch, setIfMatch] = useState("");
  const [requestBody, setRequestBody] = useState("");
  const [status, setStatus] = useState<number | null>(null);
  const [responseHeaders, setResponseHeaders] = useState<Record<string, string>>({});
  const [responseBody, setResponseBody] = useState("");
  const [duration, setDuration] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const presets = [
    { label: "健康检查", method: "GET" as const, url: "/system/health", body: "" },
    { label: "列出数据仓", method: "GET" as const, url: "/bins", body: "" },
    {
      label: "创建数据仓",
      method: "POST" as const,
      url: "/bins",
      body: JSON.stringify({ name: "调试测试仓", value: { test: true } }, null, 2),
    },
    { label: "列出集合", method: "GET" as const, url: "/collections", body: "" },
    { label: "列出模板", method: "GET" as const, url: "/templates", body: "" },
    {
      label: "JSON Patch",
      method: "PATCH" as const,
      url: "/bins/:id",
      body: JSON.stringify(
        [
          { op: "test", path: "/settings/theme", value: "light" },
          { op: "replace", path: "/settings/theme", value: "dark" },
          { op: "add", path: "/tags/-", value: "patched" },
        ],
        null,
        2,
      ),
    },
    { label: "全站搜索", method: "GET" as const, url: "/search?q=test", body: "" },
    { label: "OpenAPI 规范", method: "GET" as const, url: "/openapi.json", body: "" },
  ];

  async function handleSend() {
    const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    if (isDangerousRequest(method, normalizedEndpoint)) {
      const okToSend = await confirm({
        title: "危险操作确认",
        message: `你正在执行危险操作：\n${method} /api/v1${normalizedEndpoint}\n\n资源：${resourceHint(normalizedEndpoint)}\n该操作可能永久删除或覆盖数据，请确认目标资源正确。`,
        confirmLabel: "确认执行",
        danger: true,
      });
      if (!okToSend) return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    setResponseHeaders({});
    setResponseBody("");
    setDuration(null);

    const start = performance.now();
    try {
      const targetUrl = `/api/v1${normalizedEndpoint}`;
      const headers: Record<string, string> = {};
      if (requestBody && (method === "POST" || method === "PUT" || method === "PATCH")) {
        if (method === "PATCH" && requestBody.trim().startsWith("[")) {
          headers["Content-Type"] = "application/json-patch+json";
        } else if (method === "PATCH") {
          headers["Content-Type"] = "application/merge-patch+json";
        } else {
          headers["Content-Type"] = "application/json";
        }
      }
      if (bearerToken.trim()) {
        headers["Authorization"] = `Bearer ${bearerToken.trim()}`;
      }
      if (ifMatch.trim()) {
        headers["If-Match"] = ifMatch.trim();
      }

      const res = await fetch(targetUrl, {
        method,
        credentials: "include",
        headers,
        body: method !== "GET" && requestBody.trim() ? requestBody : undefined,
      });

      const end = performance.now();
      setDuration(Math.round(end - start));
      setStatus(res.status);

      const hdrs: Record<string, string> = {};
      res.headers.forEach((val, key) => {
        hdrs[key] = val;
      });
      setResponseHeaders(hdrs);

      // Auto-extract ETag to If-Match helper if present
      if (res.headers.get("ETag")) {
        setIfMatch(res.headers.get("ETag") || "");
      }

      const text = await res.text();
      try {
        const json = JSON.parse(text);
        setResponseBody(JSON.stringify(json, null, 2));
      } catch {
        setResponseBody(text);
      }
    } catch (err: any) {
      setError(err.message || "请求失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel" style={{ padding: "20px" }}>
      <h2 style={{ marginTop: 0 }}>在线 API 调试器</h2>
      <p style={{ color: "var(--muted)", fontSize: "13px" }}>
        仅支持调试当前部署的 <code>/api/v1/*</code> 接口。Bearer Token 仅保存在内存中，不会持久化存储。
      </p>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "16px" }}>
        <span style={{ fontSize: "12px", color: "var(--muted)", alignSelf: "center" }}>预设模板：</span>
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            className="secondary-button"
            style={{ padding: "4px 8px", fontSize: "12px" }}
            onClick={() => {
              setMethod(p.method);
              setEndpoint(p.url);
              setRequestBody(p.body);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: "10px", marginBottom: "14px" }}>
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value as any)}
          style={{
            padding: "8px 12px",
            borderRadius: "6px",
            border: "1px solid var(--border)",
            background: "transparent",
            color: "inherit",
            fontWeight: "bold",
          }}
        >
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="PATCH">PATCH</option>
          <option value="DELETE">DELETE</option>
        </select>

        <div style={{ display: "flex", flex: 1, alignItems: "center" }}>
          <span style={{ padding: "8px 10px", background: "var(--border)", borderTopLeftRadius: "6px", borderBottomLeftRadius: "6px", fontSize: "13px", color: "var(--muted)" }}>
            /api/v1
          </span>
          <input
            type="text"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            style={{
              flex: 1,
              padding: "8px 12px",
              borderTopRightRadius: "6px",
              borderBottomRightRadius: "6px",
              border: "1px solid var(--border)",
              borderLeft: "none",
            }}
            placeholder="/bins"
          />
        </div>

        <button
          type="button"
          className="primary-button"
          onClick={handleSend}
          disabled={loading}
          style={{ minWidth: "90px" }}
        >
          {loading ? "发送中…" : "发送请求"}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "14px" }}>
        <div>
          <label style={{ display: "block", fontSize: "12px", marginBottom: "4px" }}>
            Bearer Token（可选，留空使用当前控制台 Session）
          </label>
          <input
            type="password"
            value={bearerToken}
            onChange={(e) => setBearerToken(e.target.value)}
            placeholder="jb_live_..."
            style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid var(--border)" }}
          />
        </div>
        <div>
          <label style={{ display: "block", fontSize: "12px", marginBottom: "4px" }}>
            If-Match ETag（用于条件写入/冲突校验）
          </label>
          <input
            type="text"
            value={ifMatch}
            onChange={(e) => setIfMatch(e.target.value)}
            placeholder='"etag-value"'
            style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid var(--border)" }}
          />
        </div>
      </div>

      {(method === "POST" || method === "PUT" || method === "PATCH") && (
        <div style={{ marginBottom: "16px" }}>
          <label style={{ display: "block", fontSize: "12px", marginBottom: "4px" }}>请求体 JSON (Request Body)</label>
          <textarea
            value={requestBody}
            onChange={(e) => setRequestBody(e.target.value)}
            rows={5}
            style={{ width: "100%", fontFamily: "monospace", fontSize: "12px", padding: "8px", borderRadius: "6px", border: "1px solid var(--border)" }}
            placeholder="{}"
          />
        </div>
      )}

      {error && (
        <div className="detail-error" style={{ marginBottom: "16px" }}>
          {error}
        </div>
      )}

      {status !== null && (
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: "16px" }}>
          <div style={{ display: "flex", gap: "16px", alignItems: "center", marginBottom: "10px" }}>
            <span style={{ fontWeight: "bold" }}>响应状态：</span>
            <span
              style={{
                padding: "2px 8px",
                borderRadius: "4px",
                fontWeight: "bold",
                background: status >= 200 && status < 300 ? "#10b98122" : "#ef444422",
                color: status >= 200 && status < 300 ? "#10b981" : "#ef4444",
              }}
            >
              {status}
            </span>
            {duration !== null && (
              <span style={{ fontSize: "12px", color: "var(--muted)" }}>耗时：{duration} ms</span>
            )}
          </div>

          <div style={{ marginBottom: "10px" }}>
            <span style={{ fontSize: "12px", fontWeight: "bold", color: "var(--muted)" }}>响应头：</span>
            <pre style={{ margin: "4px 0", padding: "8px", background: "var(--border)", borderRadius: "4px", fontSize: "11px", maxHeight: "120px", overflow: "auto" }}>
              {Object.entries(responseHeaders)
                .map(([k, v]) => `${k}: ${v}`)
                .join("\n")}
            </pre>
          </div>

          <div>
            <span style={{ fontSize: "12px", fontWeight: "bold", color: "var(--muted)" }}>响应体：</span>
            <pre style={{ margin: "4px 0", padding: "10px", background: "var(--border)", borderRadius: "6px", fontSize: "12px", maxHeight: "300px", overflow: "auto" }}>
              {responseBody || "<空响应体>"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
