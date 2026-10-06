import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Activity, Clock, AlertTriangle, ShieldAlert, CheckCircle2 } from "lucide-react";

export function AnalyticsPage() {
  const [range, setRange] = useState<"1h" | "24h" | "7d" | "30d">("24h");

  const query = useQuery({
    queryKey: ["analytics", range],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/v1/analytics/overview?range=${range}`, {
        credentials: "include",
        signal,
      });
      if (!res.ok) throw new Error("无法加载分析数据");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const data = query.data;
  const overview = data?.overview || {
    totalRequests: 0,
    successRate: 100,
    avgDurationMs: 0,
    p95DurationMs: 0,
    count4xx: 0,
    count5xx: 0,
    count429: 0,
  };

  return (
    <section className="analytics-page">
      <header className="resource-heading">
        <div>
          <span className="eyebrow">可观测性</span>
          <h1>API 请求分析</h1>
          <p>实时监控接口吞吐量、响应延迟、状态码分布与热点端点。严格遵循隐私底线，不采集任何请求正文与凭据。</p>
        </div>
        <div style={{ display: "flex", gap: "6px" }}>
          {(["1h", "24h", "7d", "30d"] as const).map((r) => (
            <button
              key={r}
              type="button"
              className={`secondary-button ${range === r ? "active" : ""}`}
              style={range === r ? { borderColor: "var(--accent)", color: "var(--accent-text)" } : {}}
              onClick={() => setRange(r)}
            >
              {r === "1h" ? "最近 1 小时" : r === "24h" ? "最近 24 小时" : r === "7d" ? "最近 7 天" : "最近 30 天"}
            </button>
          ))}
        </div>
      </header>

      {query.isPending ? (
        <div className="bin-grid">
          {[0, 1, 2, 3].map((i) => (
            <div className="bin-card skeleton" key={i} />
          ))}
        </div>
      ) : query.isError ? (
        <div className="panel detail-error">
          <p>{query.error.message}</p>
          <button type="button" className="secondary-button" onClick={() => query.refetch()}>
            重试
          </button>
        </div>
      ) : (
        <>
          {/* Overview Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px", marginBottom: "20px" }}>
            <div className="panel" style={{ padding: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", color: "var(--muted)", fontSize: "13px" }}>
                <span>总请求量</span>
                <Activity size={16} />
              </div>
              <h2 style={{ fontSize: "24px", margin: "8px 0 0 0" }}>{overview.totalRequests.toLocaleString()}</h2>
            </div>

            <div className="panel" style={{ padding: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", color: "var(--muted)", fontSize: "13px" }}>
                <span>成功率 (2xx/3xx)</span>
                <CheckCircle2 size={16} color="#10b981" />
              </div>
              <h2 style={{ fontSize: "24px", margin: "8px 0 0 0", color: overview.successRate >= 95 ? "#10b981" : "#eab308" }}>
                {overview.successRate}%
              </h2>
            </div>

            <div className="panel" style={{ padding: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", color: "var(--muted)", fontSize: "13px" }}>
                <span>平均响应耗时</span>
                <Clock size={16} />
              </div>
              <h2 style={{ fontSize: "24px", margin: "8px 0 0 0" }}>{overview.avgDurationMs} ms</h2>
              <span style={{ fontSize: "12px", color: "var(--muted)" }}>P95: {overview.p95DurationMs} ms</span>
            </div>

            <div className="panel" style={{ padding: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", color: "var(--muted)", fontSize: "13px" }}>
                <span>429 限流次数</span>
                <ShieldAlert size={16} color={overview.count429 > 0 ? "#ef4444" : "var(--muted)"} />
              </div>
              <h2 style={{ fontSize: "24px", margin: "8px 0 0 0", color: overview.count429 > 0 ? "#ef4444" : "inherit" }}>
                {overview.count429}
              </h2>
            </div>
          </div>

          {/* Endpoints Table */}
          <div className="panel" style={{ padding: "16px", marginBottom: "20px" }}>
            <h3 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: "8px" }}>
              <BarChart3 size={18} />
              接口调用排行 (Endpoints)
            </h3>
            {data?.endpoints?.length ? (
              <div className="history-table-wrap">
                <table className="history-table">
                  <thead>
                    <tr>
                      <th scope="col">方法</th>
                      <th scope="col">规范化路径</th>
                      <th scope="col">请求次数</th>
                      <th scope="col">平均耗时</th>
                      <th scope="col">P95 耗时</th>
                      <th scope="col">错误率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.endpoints.map((ep: any, idx: number) => (
                      <tr key={idx}>
                        <td>
                          <span
                            style={{
                              padding: "2px 6px",
                              borderRadius: "4px",
                              fontSize: "11px",
                              fontWeight: "bold",
                              background:
                                ep.method === "GET"
                                  ? "#3b82f622"
                                  : ep.method === "POST"
                                  ? "#10b98122"
                                  : ep.method === "DELETE"
                                  ? "#ef444422"
                                  : "#eab30822",
                              color:
                                ep.method === "GET"
                                  ? "#3b82f6"
                                  : ep.method === "POST"
                                  ? "#10b981"
                                  : ep.method === "DELETE"
                                  ? "#ef4444"
                                  : "#eab308",
                            }}
                          >
                            {ep.method}
                          </span>
                        </td>
                        <td>
                          <code>{ep.route}</code>
                        </td>
                        <td>{ep.requests}</td>
                        <td>{ep.avgDurationMs} ms</td>
                        <td>{ep.p95DurationMs} ms</td>
                        <td>{ep.errorRate}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={{ color: "var(--muted)", margin: "10px 0 0 0" }}>暂无接口调用记录。</p>
            )}
          </div>

          {/* Status Codes and API Keys */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div className="panel" style={{ padding: "16px" }}>
              <h3 style={{ marginTop: 0 }}>状态码分布 (Status Codes)</h3>
              {data?.statuses?.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {data.statuses.map((st: any) => (
                    <div key={st.status} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span
                        style={{
                          fontWeight: "bold",
                          color: st.status < 400 ? "#10b981" : st.status < 500 ? "#eab308" : "#ef4444",
                        }}
                      >
                        HTTP {st.status}
                      </span>
                      <span>{st.count} 次</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ color: "var(--muted)" }}>暂无状态码统计。</p>
              )}
            </div>

            <div className="panel" style={{ padding: "16px" }}>
              <h3 style={{ marginTop: 0 }}>高频 API 密钥 (Top Keys)</h3>
              {data?.keys?.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {data.keys.slice(0, 5).map((k: any) => (
                    <div key={k.keyId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <code>{k.keyId.slice(0, 8)}…</code>
                      <span>
                        {k.requests} 次
                        {k.count429 > 0 && <span style={{ color: "#ef4444", marginLeft: "6px" }}>({k.count429} 次限流)</span>}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ color: "var(--muted)" }}>暂无 API 密钥调用。</p>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
