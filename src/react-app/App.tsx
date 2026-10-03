import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Archive,
  Boxes,
  Braces,
  ChevronRight,
  CircleCheck,
  Code2,
  Database,
  FileJson2,
  KeyRound,
  LayoutDashboard,
  Moon,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  TerminalSquare,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Health = {
  ok: boolean;
  service: string;
  version: string;
  storage: {
    r2: boolean;
    kv: boolean;
  };
};

type NavLink = {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  divider?: never;
};

type NavDivider = {
  label: string;
  divider: true;
  icon?: never;
  active?: never;
};

type NavItem = NavLink | NavDivider;

const nav: NavItem[] = [
  { label: "Overview", icon: LayoutDashboard, active: true },
  { label: "Bins", icon: FileJson2 },
  { label: "Collections", icon: Boxes },
  { label: "Schemas", icon: Braces },
  { divider: true, label: "Developer" },
  { label: "API Keys", icon: KeyRound },
  { label: "Activity", icon: Activity },
  { label: "API Docs", icon: TerminalSquare },
  { divider: true, label: "System" },
  { label: "Trash", icon: Archive },
  { label: "Settings", icon: Settings },
];

const recent = [
  { name: "cloudflare-config", action: "Updated", source: "Dashboard", time: "2 min ago" },
  { name: "qinglong", action: "Read", source: "API key", time: "6 min ago" },
  { name: "app-settings", action: "Updated", source: "Worker", time: "28 min ago" },
  { name: "site-flags", action: "Created", source: "Dashboard", time: "1 h ago" },
];

function App() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("theme");
    return saved
      ? saved === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  const health = useQuery({
    queryKey: ["system-health"],
    queryFn: async () => {
      const response = await fetch("/api/v1/system/health");
      if (!response.ok) throw new Error("Health check failed");
      return (await response.json()) as Health;
    },
  });

  const storageLabel = useMemo(() => {
    if (!health.data) return "Checking bindings";
    if (health.data.storage.r2 && health.data.storage.kv) return "R2 + KV connected";
    return "Bindings not configured";
  }, [health.data]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Code2 size={19} strokeWidth={2.2} />
          </div>
          <div>
            <strong>JSONBin</strong>
            <span>Private Cloud</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Main navigation">
          {nav.map((item, index) => {
            if (item.divider) {
              return (
                <div className="nav-section" key={`section-${index}`}>
                  {item.label}
                </div>
              );
            }

            const Icon = item.icon;
            return (
              <button
                className={`nav-item ${item.active ? "active" : ""}`}
                type="button"
                key={item.label}
              >
                <Icon size={17} />
                <span>{item.label}</span>
                {item.active && <span className="nav-dot" />}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-status">
          <div className="status-row">
            <span className="status-indicator" />
            <span>{health.isError ? "API unavailable" : "Worker online"}</span>
          </div>
          <div className="status-meta">{storageLabel}</div>
          <div className="status-version">
            {health.data?.version ?? "v3.0.0-alpha"}
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="search-button" type="button">
            <Search size={16} />
            <span>Search bins, collections, schemas…</span>
            <kbd>⌘ K</kbd>
          </button>

          <div className="topbar-actions">
            <button
              className="icon-button"
              type="button"
              onClick={() => setDark((value) => !value)}
              aria-label="Toggle color theme"
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <div className="avatar">A</div>
          </div>
        </header>

        <div className="content">
          <section className="hero">
            <div>
              <span className="eyebrow">Private workspace</span>
              <h1>Good afternoon</h1>
              <p>Your JSON storage, configuration and automation data in one place.</p>
            </div>
            <button className="primary-button" type="button">
              <Zap size={16} fill="currentColor" />
              Create bin
            </button>
          </section>

          <section className="metrics-grid" aria-label="Overview metrics">
            <MetricCard label="Total Bins" value="86" note="+4 this week" icon={FileJson2} />
            <MetricCard label="Collections" value="12" note="4 active schemas" icon={Boxes} />
            <MetricCard label="Requests" value="18,392" note="Today" icon={Activity} />
            <MetricCard label="Storage" value="24.8 MB" note="R2 data" icon={Database} />
          </section>

          <section className="dashboard-grid">
            <div className="panel requests-panel">
              <div className="panel-heading">
                <div>
                  <span className="panel-kicker">Traffic</span>
                  <h2>API requests</h2>
                </div>
                <button className="ghost-button" type="button">
                  Last 24 hours
                  <ChevronRight size={15} />
                </button>
              </div>

              <div className="chart-summary">
                <strong>18,392</strong>
                <span className="positive">+12.4%</span>
              </div>

              <div className="mini-chart" aria-hidden="true">
                {[32, 41, 36, 52, 47, 60, 58, 75, 69, 83, 78, 91, 86, 96, 89, 105, 99, 113, 108, 121, 116, 128, 124, 136].map(
                  (height, index) => (
                    <span
                      key={index}
                      style={{ height: `${Math.max(12, height / 1.5)}px` }}
                    />
                  ),
                )}
              </div>

              <div className="request-breakdown">
                <div>
                  <span>GET</span>
                  <strong>10,927</strong>
                </div>
                <div>
                  <span>WRITE</span>
                  <strong>1,454</strong>
                </div>
                <div>
                  <span>Cache hit</span>
                  <strong>87.2%</strong>
                </div>
              </div>
            </div>

            <div className="panel health-panel">
              <div className="panel-heading">
                <div>
                  <span className="panel-kicker">Infrastructure</span>
                  <h2>System health</h2>
                </div>
                <ShieldCheck size={19} className="success-icon" />
              </div>

              <HealthItem
                name="Worker API"
                detail="Cloudflare Workers"
                ready={Boolean(health.data?.ok)}
              />
              <HealthItem
                name="R2 storage"
                detail="Source of truth"
                ready={Boolean(health.data?.storage.r2)}
              />
              <HealthItem
                name="KV cache"
                detail="Index & edge cache"
                ready={Boolean(health.data?.storage.kv)}
              />

              <div className="health-note">
                <CircleCheck size={16} />
                <span>Legacy v2.6.4 is preserved on its own branch.</span>
              </div>
            </div>
          </section>

          <section className="panel activity-panel">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">Workspace</span>
                <h2>Recent activity</h2>
              </div>
              <button className="ghost-button" type="button">
                View all
                <ChevronRight size={15} />
              </button>
            </div>

            <div className="activity-table">
              {recent.map((item) => (
                <div className="activity-row" key={`${item.name}-${item.time}`}>
                  <div className="file-icon">
                    <FileJson2 size={17} />
                  </div>
                  <div className="activity-name">
                    <strong>{item.name}</strong>
                    <span>{item.source}</span>
                  </div>
                  <span className="activity-action">{item.action}</span>
                  <time>{item.time}</time>
                  <ChevronRight className="row-chevron" size={16} />
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function MetricCard({
  label,
  value,
  note,
  icon: Icon,
}: {
  label: string;
  value: string;
  note: string;
  icon: typeof FileJson2;
}) {
  return (
    <article className="metric-card">
      <div className="metric-icon">
        <Icon size={18} />
      </div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function HealthItem({
  name,
  detail,
  ready,
}: {
  name: string;
  detail: string;
  ready: boolean;
}) {
  return (
    <div className="health-item">
      <span className={`health-dot ${ready ? "ready" : ""}`} />
      <div>
        <strong>{name}</strong>
        <span>{detail}</span>
      </div>
      <span className="health-state">{ready ? "Ready" : "Setup"}</span>
    </div>
  );
}

export default App;
