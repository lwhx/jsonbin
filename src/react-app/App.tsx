import { SettingsPage } from './features/settings/SettingsPage';
import { SearchPage } from './features/search/SearchPage';
import { systemApi } from './features/settings/api';
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  LockKeyhole,
  LogOut,
  Moon,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  TerminalSquare,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { BinDetailPage } from "./features/bins/BinDetailPage";
import { binHash, binIdFromHash } from "./features/bins/navigation";
import { CollectionsPage } from "./features/collections/CollectionsPage";
import { CollectionDetailPage } from "./features/collections/CollectionDetailPage";
import { collectionHash, collectionIdFromHash, listCollections } from "./features/collections/api";

import { SchemasPage } from "./features/schemas/SchemasPage";
import { SchemaDetailPage } from "./features/schemas/SchemaDetailPage";
import { listSchemas, schemaHash, schemaIdFromHash } from "./features/schemas/api";
import { SchemaIssues } from "./features/schemas/SchemaIssues";
import type { SchemaIssue } from "./features/schemas/api";

import { KeysPage } from "./features/keys/KeysPage";
import { DocsPage } from "./features/docs/DocsPage";
import { ActivityPage } from "./features/activity/ActivityPage";
import { TrashPage } from "./features/trash/TrashPage";
import { Dialog } from "./components/Dialog";
import { useConfirm } from "./components/ConfirmDialog";
import { ExpiryLabel, expiryFromInput } from "./features/bins/expiry";

type Health = {
  ok: boolean;
  service: string;
  version: string;
  storage: {
    r2: boolean;
    kv: boolean;
  };
};

type AuthUser = {
  id: string;
  username: string;
  provider: "password" | "github";
};

type AuthConfig = {
  passwordEnabled: boolean;
  githubEnabled: boolean;
};

type BinMeta = {
  id: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  collectionId: string | null;
  schemaId: string | null;
  currentVersion: number;
  size: number;
  locked: boolean;
  schemaLocked: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
};

type BinList = {
  items: BinMeta[];
  total: number;
};

type Section = "Overview" | "Bins" | "Collections" | "Schemas" | "Keys" | "Trash" | "Activity" | "Docs" | "Settings" | "Search";

type NavLink = {
  label: string;
  icon: LucideIcon;
  section?: Section;
  disabled?: boolean;
  divider?: never;
};

type NavDivider = {
  label: string;
  divider: true;
  icon?: never;
  section?: never;
  disabled?: never;
};

type NavItem = NavLink | NavDivider;

const nav: NavItem[] = [
  { label: "概览", icon: LayoutDashboard, section: "Overview" },
  { label: "数据仓", icon: FileJson2, section: "Bins" },
  { label: "集合", icon: Boxes, section: "Collections" },
  { label: "数据模型", icon: Braces, section: "Schemas" },
  { divider: true, label: "开发者" },
  { label: "API 密钥", icon: KeyRound, section: "Keys" },
  { label: "活动记录", icon: Activity, section: "Activity" },
  { label: "API 文档", icon: TerminalSquare, section: "Docs" },
  { divider: true, label: "系统" },
  { label: "回收站", icon: Archive, section: "Trash" },
  { label: "设置", icon: Settings, section: "Settings" },
];

function apiErrorMessage(status: number) {
  if (status === 401) return "用户名或密码不正确。";
  if (status === 503) return "当前登录方式尚未配置。";
  return "发生错误，请稍后重试。";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function timeAgo(value: string) {
  const ms = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

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

  const auth = useQuery({
    queryKey: ["auth-me"],
    queryFn: async (): Promise<AuthUser | null> => {
      const response = await fetch("/api/v1/auth/me", {
        credentials: "include",
      });
      if (response.status === 401) return null;
      if (!response.ok) throw new Error("无法检查登录状态");
      const data = (await response.json()) as {
        authenticated: boolean;
        user: AuthUser;
      };
      return data.authenticated ? data.user : null;
    },
    retry: false,
    // A reconnect must not unmount an editor containing unsaved work.
    refetchOnReconnect: false,
  });

  if (auth.isLoading) {
    return <BootScreen />;
  }

  if (auth.isError) {
    return <AuthErrorScreen message="无法检查登录状态。" retryLabel="重试登录状态" onRetry={() => void auth.refetch()} />;
  }

  if (!auth.data) {
    return (
      <LoginScreen
        dark={dark}
        onToggleTheme={() => setDark((value) => !value)}
        onAuthenticated={() => auth.refetch()}
      />
    );
  }

  return (
    <AuthenticatedApp
      user={auth.data}
      dark={dark}
      onToggleTheme={() => setDark((value) => !value)}
    />
  );
}

function BootScreen() {
  return (
    <div className="boot-screen">
      <div className="brand-mark large">
        <Code2 size={24} />
      </div>
      <span>正在加载 JSONBin…</span>
    </div>
  );
}

function AuthErrorScreen({
  message,
  retryLabel,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <div className="boot-screen" role="alert">
      <div className="brand-mark large">
        <Code2 size={24} />
      </div>
      <span>{message}</span>
      <button className="secondary-button" type="button" onClick={onRetry}>
        {retryLabel}
      </button>
    </div>
  );
}

function LoginScreen({
  dark,
  onToggleTheme,
  onAuthenticated,
}: {
  dark: boolean;
  onToggleTheme: () => void;
  onAuthenticated: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const config = useQuery({
    queryKey: ["auth-config"],
    queryFn: async (): Promise<AuthConfig> => {
      const response = await fetch("/api/v1/auth/config");
      if (!response.ok) throw new Error("无法加载登录配置");
      return response.json();
    },
    retry: false,
  });

  if (config.isLoading) {
    return <BootScreen />;
  }

  if (config.isError) {
    return (
      <AuthErrorScreen
        message="无法加载登录配置。"
        retryLabel="重试登录配置"
        onRetry={() => void config.refetch()}
      />
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        setError(apiErrorMessage(response.status));
        return;
      }

      onAuthenticated();
    } catch {
      setError("无法连接 Worker API。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-orb login-orb-one" />
      <div className="login-orb login-orb-two" />

      <button
        className="login-theme-button"
        type="button"
        onClick={onToggleTheme}
        aria-label="切换明暗主题"
      >
        {dark ? <Sun size={18} /> : <Moon size={18} />}
      </button>

      <div className="login-card">
        <div className="login-brand">
          <div className="brand-mark large">
            <Code2 size={23} strokeWidth={2.2} />
          </div>
          <div>
            <strong>JSONBin</strong>
            <span>私有云</span>
          </div>
        </div>

        <div className="login-heading">
          <span className="eyebrow">私人工作区</span>
          <h1>欢迎回来</h1>
          <p>登录后管理你的 JSON、配置和自动化数据。</p>
        </div>

        {config.data?.passwordEnabled !== false && (
          <form className="login-form" onSubmit={submit}>
            <label>
              用户名
              <input
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="admin"
                required
              />
            </label>

            <label>
              密码
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••••••"
                required
              />
            </label>

            {error && <div className="login-error">{error}</div>}

            <button className="login-submit" type="submit" disabled={submitting}>
              <LockKeyhole size={16} />
              {submitting ? "正在登录…" : "登录"}
            </button>
          </form>
        )}

        {config.data?.githubEnabled && (
          <>
            <div className="login-separator">
              <span>或</span>
            </div>
            <a className="github-login" href="/api/v1/auth/github">
              <Code2 size={17} />
              使用 GitHub 登录
            </a>
          </>
        )}

        <div className="login-footnote">
          单用户模式 · Cloudflare Workers · R2
        </div>
      </div>
    </div>
  );
}

function AuthenticatedApp({
  user,
  dark,
  onToggleTheme,
}: {
  user: AuthUser;
  dark: boolean;
  onToggleTheme: () => void;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [route, setRoute] = useState(() => window.location.hash);
  const [detailDirty, setDetailDirty] = useState(false);
  const section: Section = route.startsWith("#/search") ? "Search" : route.startsWith("#/bins") ? "Bins" : route.startsWith("#/collections") ? "Collections" : route.startsWith("#/schemas") ? "Schemas" : route === "#/keys" ? "Keys" : route === "#/trash" ? "Trash" : route === "#/activity" ? "Activity" : route === "#/docs" ? "Docs" : route === "#/settings" ? "Settings" : "Overview";
  const binId = binIdFromHash(route);
  const collectionId = collectionIdFromHash(route);
  const schemaId = schemaIdFromHash(route);
  const setSection = (section: Section) => { window.location.hash = section === "Bins" ? "/bins" : section === "Collections" ? "/collections" : section === "Schemas" ? "/schemas" : section === "Keys" ? "/keys" : section === "Trash" ? "/trash" : section === "Activity" ? "/activity" : section === "Docs" ? "/docs" : section === "Settings" ? "/settings" : "/"; };
  const [createOpen, setCreateOpen] = useState(false);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); window.location.hash = '/search'; } };
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut);
  }, []);

  useEffect(() => {
    let active = true;
    async function changed() {
      const next = window.location.hash;
      if (next === route) return;
      if (detailDirty) {
        window.history.pushState(null, "", route || window.location.pathname);
        const leave = await confirm({
          title: "放弃未保存的修改？",
          message: "当前页面还有未保存内容，离开后这些修改将丢失。",
          confirmLabel: "放弃并离开",
          cancelLabel: "继续编辑",
          danger: true,
        });
        if (!active || !leave) return;
        setDetailDirty(false);
        setRoute(next);
        window.history.replaceState(null, "", next || window.location.pathname);
        return;
      }
      setDetailDirty(false); setRoute(next);
    }
    window.addEventListener("hashchange", changed);
    return () => { active = false; window.removeEventListener("hashchange", changed); };
  }, [route, detailDirty, confirm]);

  const health = useQuery({
    queryKey: ["system-health"],
    queryFn: async (): Promise<Health> => {
      const response = await fetch("/api/v1/system/health");
      if (!response.ok) throw new Error("健康检查失败");
      return response.json();
    },
  });

  const bins = useQuery({
    queryKey: ["bins"],
    refetchInterval: 30_000,
    queryFn: async (): Promise<BinList> => {
      const response = await fetch("/api/v1/bins", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("无法加载数据仓");
      return response.json();
    },
    retry: false,
  });

  const storageLabel = useMemo(() => {
    if (!health.data) return "正在检查绑定";
    if (health.data.storage.r2 && health.data.storage.kv) {
      return "R2 + KV 已连接";
    }
    if (health.data.storage.r2) return "R2 已连接 · KV 待配置";
    return "需要配置存储";
  }, [health.data]);

  async function logout() {
    if (detailDirty && !await confirm({
      title: "退出登录？",
      message: "当前页面还有未保存内容，退出登录后这些修改将丢失。",
      confirmLabel: "退出登录",
      cancelLabel: "继续编辑",
      danger: true,
    })) return;
    window.dispatchEvent(new Event("jsonbin:logout"));
    setDetailDirty(false);
    await fetch("/api/v1/auth/logout", {
      method: "POST",
      credentials: "include",
    });
    queryClient.setQueryData(["auth-me"], null);
    await queryClient.cancelQueries();
    queryClient.clear();
  }

  const totalStorage =
    bins.data?.items.reduce((sum, item) => sum + item.size, 0) ?? 0;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Code2 size={19} strokeWidth={2.2} />
          </div>
          <div>
            <strong>JSONBin</strong>
            <span>私有云</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="主导航">
          {nav.map((item, index) => {
            if (item.divider) {
              return (
                <div className="nav-section" key={`section-${index}`}>
                  {item.label}
                </div>
              );
            }

            const Icon = item.icon;
            const active = item.section === section;
            return (
              <button
                className={`nav-item ${active ? "active" : ""} ${item.disabled ? "disabled" : ""}`}
                type="button"
                key={item.label}
                disabled={item.disabled}
                onClick={() => item.section && setSection(item.section)}
              >
                <Icon size={17} />
                <span>{item.label}</span>
                {active && <span className="nav-dot" />}
                {item.disabled && <span className="soon-badge">即将推出</span>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-status">
          <div className="status-row">
            <span
              className={`status-indicator ${health.data?.storage.r2 ? "" : "warning"}`}
            />
            <span>{health.isError ? "API 不可用" : "Worker 在线"}</span>
          </div>
          <div className="status-meta">{storageLabel}</div>
          <div className="status-version">
            {health.data?.version ?? "3.0.0"}
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="search-button" type="button" onClick={() => { window.location.hash = '/search'; }}>
            <Search size={16} />
            <span>搜索数据仓、集合、数据模型…</span>
            <kbd>⌘ K</kbd>
          </button>

          <div className="topbar-actions">
            <button
              className="icon-button"
              type="button"
              onClick={onToggleTheme}
              aria-label="切换明暗主题"
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button
              className="user-chip"
              type="button"
              title={`登录方式：${user.provider === "password" ? "密码" : "GitHub"}`}
            >
              <span className="avatar">
                {user.username.slice(0, 1).toUpperCase()}
              </span>
              <span>{user.username}</span>
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={logout}
              aria-label="退出登录"
              title="退出登录"
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>

        <div className="content">
          {route.startsWith('#/search') ? <SearchPage key={route} route={route} /> : binId ? (
            <BinDetailPage key={binId} id={binId} dark={dark} onDirtyChange={setDetailDirty}
              onBack={() => setSection("Bins")}
              onDeleted={() => {
                setDetailDirty(false);
                window.history.pushState(null, "", "#/bins");
                setRoute("#/bins");
              }} />
          ) : section === "Collections" ? (collectionId || route === "#/collections/new" ?
            <CollectionDetailPage key={collectionId ?? "new"} id={collectionId} onDirtyChange={setDetailDirty}
              onBack={() => setSection("Collections")} onOpenBin={id => { window.location.hash = binHash(id); }}
              onSaved={id => { setDetailDirty(false); const next = collectionHash(id); window.history.pushState(null, "", next); setRoute(next); }}
              onDeleted={() => { setDetailDirty(false); window.history.pushState(null, "", "#/collections"); setRoute("#/collections"); }} />
            : <CollectionsPage onCreate={() => { window.location.hash = "/collections/new"; }}
              onOpen={id => { window.location.hash = collectionHash(id); }} />
          ) : section === "Schemas" ? (schemaId || route === "#/schemas/new" ?
            <SchemaDetailPage key={schemaId ?? "new"} id={schemaId} onDirtyChange={setDetailDirty}
              onBack={() => setSection("Schemas")}
              onSaved={id => { setDetailDirty(false); const next = schemaHash(id); window.history.pushState(null, "", next); setRoute(next); }}
              onDeleted={() => { setDetailDirty(false); window.history.pushState(null, "", "#/schemas"); setRoute("#/schemas"); }} />
            : <SchemasPage onCreate={() => { window.location.hash = "/schemas/new"; }} onOpen={id => { window.location.hash = schemaHash(id); }} />
          ) : section === "Settings" ? <SettingsPage onDirtyChange={setDetailDirty} /> : section === "Docs" ? <DocsPage /> : section === "Activity" ? <ActivityPage /> : section === "Keys" ? <KeysPage onDirtyChange={setDetailDirty} /> : section === "Trash" ?
            <TrashPage onDirtyChange={setDetailDirty} onOpen={id => { window.location.hash = binHash(id); }} /> : section === "Overview" ? (
            <Overview
              bins={bins.data?.items ?? []}
              binsLoading={bins.isLoading}
              binsError={bins.isError}
              totalStorage={totalStorage}
              health={health.data}
              onCreate={() => setCreateOpen(true)}
              onOpenBins={() => setSection("Bins")}
            />
          ) : (
            <BinsPage
              bins={bins.data?.items ?? []}
              loading={bins.isLoading}
              error={bins.isError}
              onCreate={() => setCreateOpen(true)}
              onOpen={id => { window.location.hash = binHash(id); }}
            />
          )}
        </div>
      </main>

      {createOpen && (
        <CreateBinDialog
          onClose={() => setCreateOpen(false)}
          onCreated={async (id) => {
            setCreateOpen(false);
            await queryClient.invalidateQueries({ queryKey: ["bins"] });
            await queryClient.invalidateQueries({ queryKey: ["collections"] });
            await queryClient.invalidateQueries({ queryKey: ["collection-bins"] });
            window.location.hash = binHash(id);
          }}
        />
      )}
    </div>
  );
}

function Overview({
  bins,
  binsLoading,
  binsError,
  totalStorage,
  health,
  onCreate,
  onOpenBins,
}: {
  bins: BinMeta[];
  binsLoading: boolean;
  binsError: boolean;
  totalStorage: number;
  health?: Health;
  onCreate: () => void;
  onOpenBins: () => void;
}) {
  const recent = bins.slice(0, 4);
  const collections = useQuery({
    queryKey: ["collections"],
    queryFn: ({ signal }) => listCollections(signal),
    retry: false,
  });

  return (
    <>
      <section className="hero">
        <div>
          <span className="eyebrow">私人工作区</span>
          <h1>JSON 控制中心</h1>
          <p>集中管理 JSON 存储、配置和自动化数据。</p>
        </div>
        <button className="primary-button" type="button" onClick={onCreate}>
          <Zap size={16} fill="currentColor" />
          新建数据仓
        </button>
      </section>

      <section className="metrics-grid" aria-label="概览指标">
        <MetricCard
          label="数据仓总数"
          value={binsLoading ? "—" : String(bins.length)}
          note={binsError ? "存储不可用" : "R2 对象"}
          icon={FileJson2}
        />
        <MetricCard
          label="集合"
          value={collections.isLoading ? "—" : String(collections.data?.items.filter(item => item.status === "active").length ?? 0)}
          note={collections.isError ? "加载失败" : "逻辑分组"}
          icon={Boxes}
        />
        <MetricCard label="版本数" value={String(bins.reduce((n, b) => n + b.currentVersion, 0))} note="不可变历史" icon={Activity} />
        <MetricCard
          label="存储用量"
          value={formatBytes(totalStorage)}
          note="当前 JSON"
          icon={Database}
        />
      </section>

      <section className="dashboard-grid">
        <div className="panel requests-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">工作区</span>
              <h2>最近更新</h2>
            </div>
            <button className="ghost-button" type="button" onClick={onOpenBins}>
              查看数据仓
              <ChevronRight size={15} />
            </button>
          </div>

          {binsError ? (
            <EmptyState
              title="R2 尚未就绪"
              description="请先配置 DATA 绑定，然后才能存储数据仓。"
            />
          ) : recent.length ? (
            <div className="activity-table compact">
              {recent.map((item) => (
                <div className="activity-row" key={item.id}>
                  <div className="file-icon">
                    <FileJson2 size={17} />
                  </div>
                  <div className="activity-name">
                    <strong>{item.name}</strong>
                    <span>版本 {item.currentVersion}</span>
                  </div>
                  <span className="activity-action">{formatBytes(item.size)}</span>
                  <time>{timeAgo(item.updatedAt)}</time>
                  <ChevronRight className="row-chevron" size={16} />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="还没有数据仓"
              description="创建第一个 JSON 数据仓，开始使用工作区。"
              action="新建数据仓"
              onAction={onCreate}
            />
          )}
        </div>

        <div className="panel health-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">基础设施</span>
              <h2>系统状态</h2>
            </div>
            <ShieldCheck size={19} className="success-icon" />
          </div>

          <HealthItem
            name="Worker API"
            detail="Cloudflare Workers"
            ready={Boolean(health?.ok)}
          />
          <HealthItem
            name="R2 存储"
            detail="主数据源"
            ready={Boolean(health?.storage.r2)}
          />
          <HealthItem
            name="KV 缓存"
            detail="索引与边缘缓存"
            ready={Boolean(health?.storage.kv)}
          />

          <div className="health-note">
            <CircleCheck size={16} />
            <span>v3 已通过 TypeScript 类型检查和生产构建检查。</span>
          </div>
        </div>
      </section>
    </>
  );
}

function BinsPage({
  bins,
  loading,
  error,
  onCreate,
  onOpen,
}: {
  bins: BinMeta[];
  loading: boolean;
  error: boolean;
  onCreate: () => void;
  onOpen: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = bins.filter((bin) => {
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return (
      bin.name.toLowerCase().includes(query) ||
      bin.description.toLowerCase().includes(query) ||
      bin.id.toLowerCase().includes(query)
    );
  });

  return (
    <>
      <section className="hero bins-hero">
        <div>
          <span className="eyebrow">数据</span>
          <h1>数据仓</h1>
          <p>存储在 R2 中、支持独立版本管理的 JSON 文档。</p>
        </div>
        <button className="primary-button" type="button" onClick={onCreate}>
          <Plus size={16} />
          新建数据仓
        </button>
      </section>

      <div className="bins-toolbar">
        <div className="bins-search">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索数据仓…"
          />
        </div>
        <span>共 {bins.length} 个</span>
      </div>

      {error ? (
        <div className="panel">
          <EmptyState
            title="无法加载数据仓"
            description="请检查 R2 的 DATA 绑定是否已正确配置。"
          />
        </div>
      ) : loading ? (
        <div className="bin-grid">
          {[0, 1, 2, 3].map((item) => (
            <div className="bin-card skeleton" key={item} />
          ))}
        </div>
      ) : filtered.length ? (
        <div className="bin-grid">
          {filtered.map((bin) => (
            <button type="button" className="bin-card" key={bin.id} onClick={() => onOpen(bin.id)} aria-label={`打开数据仓 ${bin.name}`}>
              <div className="bin-card-top">
                <div className="file-icon large">
                  <FileJson2 size={19} />
                </div>
                <span className={`visibility-pill ${bin.visibility}`}>
                  {bin.visibility === "private" && <LockKeyhole size={11} />}
                  {bin.visibility === "private" ? "私有" : "公开"}
                </span>
              </div>

              <h3>{bin.name}</h3>
              <p>{bin.description || "暂无描述"}</p>

              <div className="bin-meta-row">
                <span>v{bin.currentVersion}</span>
                <span>{formatBytes(bin.size)}</span>
                <span>{timeAgo(bin.updatedAt)}</span>
              </div>

              <div className="bin-id">{bin.id}</div>
              <ExpiryLabel expiresAt={bin.expiresAt} />
            </button>
          ))}
        </div>
      ) : (
        <div className="panel">
          <EmptyState
            title={search ? "没有匹配的数据仓" : "还没有数据仓"}
            description={
              search
                ? "换一个关键词试试。"
                : "创建你的第一个版本化 JSON 文档。"
            }
            action={search ? undefined : "新建数据仓"}
            onAction={search ? undefined : onCreate}
          />
        </div>
      )}
    </>
  );
}

function CreateBinDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"default" | "private" | "public">("default");
  const defaults = useQuery({ queryKey: ["system-settings"], queryFn: ({ signal }) => systemApi.getSettings(signal), retry: false });
  const [expiryMode, setExpiryMode] = useState<"default" | "never" | "custom">("default");
  const [expiryInput, setExpiryInput] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [schemaId, setSchemaId] = useState("");
  const [schemaLocked, setSchemaLocked] = useState(false);
  const [issues, setIssues] = useState<SchemaIssue[]>([]);
  const schemas = useQuery({ queryKey: ["schemas"], queryFn: ({ signal }) => listSchemas(signal), retry: false });
  const collections = useQuery({ queryKey: ["collections"], queryFn: ({ signal }) => listCollections(signal), retry: false });
  const [jsonText, setJsonText] = useState(`{
  "hello": "world"
}`);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const loggedOut = useRef(false);

  useEffect(() => {
    const cancel = () => {
      loggedOut.current = true;
    };
    window.addEventListener("jsonbin:logout", cancel);
    return () => {
      window.removeEventListener("jsonbin:logout", cancel);
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setIssues([]);
    if (expiryMode === "custom" && (!expiryInput || new Date(expiryInput).getTime() <= Date.now())) {
      setError("到期时间必须晚于当前时间，留空表示永不过期。"); return;
    }

    let value: unknown;
    try {
      value = JSON.parse(jsonText);
    } catch {
      setError("JSON 内容格式不正确。");
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/v1/bins", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          ...(visibility === "default" ? {} : { visibility }),
          collectionId: collectionId || null,
          schemaId: schemaId || null,
          schemaLocked,
          ...(expiryMode === "default" ? {} : { expiresAt: expiryMode === "never" ? null : expiryFromInput(expiryInput) }),
          value,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string; issues?: SchemaIssue[] };
        setError(body.error === "schema_validation_failed" ? "JSON 不符合所选模型，请检查字段错误。" : body.error === "schema_unavailable" ? "模型已删除，请重新选择。" : "无法创建数据仓，请检查输入后重试。");
        setIssues(body.issues?.filter(issue => typeof issue.path === "string") ?? []);
        return;
      }

      const created = await response.json() as { meta: BinMeta };
      if (loggedOut.current) return;
      onCreated(created.meta.id);
    } catch {
      if (loggedOut.current) return;
      setError("无法连接 Worker API。");
    } finally {
      if (!loggedOut.current) {
        setSaving(false);
      }
    }
  }

  return (
    <Dialog titleId="create-bin-title" onClose={onClose} dismissible={!saving}>
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">新建文档</span>
            <h2 id="create-bin-title">新建数据仓</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={saving} aria-label="关闭新建数据仓弹窗">
            <X size={17} />
          </button>
        </div>

        <form className="create-form" onSubmit={submit}>
          <div className="form-grid">
            <label>
              名称
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="cloudflare-config"
                required
              />
            </label>

            <label>
              可见性
              <select
                value={visibility}
                onChange={(event) =>
                  setVisibility(event.target.value as "default" | "private" | "public")
                }
              >
                <option value="default">使用系统默认（以创建时设置为准）</option>
                <option value="private">私有</option>
                <option value="public">公开</option>
              </select>
            </label>
            {(visibility === "public" || visibility === "default" && defaults.data?.settings.defaultVisibility === "public") && <p>公开后，任何持有 API 地址的人都能匿名读取当前 JSON 和元数据；历史版本及写入仍需认证。</p>}
          </div>
          <label>到期策略<select aria-label="到期策略" value={expiryMode} disabled={saving} onChange={event => setExpiryMode(event.target.value as typeof expiryMode)}><option value="default">使用系统默认（以创建时设置为准）</option><option value="never">永不过期</option><option value="custom">自定义时间</option></select></label>
          <label>到期时间<input type="datetime-local" step="1" aria-label="到期时间" value={expiryInput} disabled={saving || expiryMode === "never"} onChange={event => { setExpiryInput(event.target.value); setExpiryMode(event.target.value ? "custom" : "default"); }} /></label>
          <p>默认值以创建时设置为准；自定义时间使用本地时区。当前默认：{defaults.data ? `${defaults.data.settings.defaultVisibility === "public" ? "公开" : "私有"}，${defaults.data.settings.defaultTtlSeconds === null ? "永不过期" : defaults.data.settings.defaultTtlSeconds + " 秒 TTL"}` : "正在读取，创建时由服务器确定"}。到期后进入回收站。</p>

          <label>
            描述
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="可选：填写这个 JSON 文档的说明"
            />
          </label>

          <label>集合<select aria-label="集合" value={collectionId} onChange={event => setCollectionId(event.target.value)} disabled={collections.isPending || collections.isError}>
            <option value="">未分组</option>{collections.data?.items.filter(item => item.status === "active").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          {collections.isError && <p role="alert">{collections.error.message} 可先创建未分组数据仓。</p>}
          <label>数据模型<select aria-label="数据模型" value={schemaId} disabled={schemas.isPending || schemas.isError || saving}
            onChange={event => { setSchemaId(event.target.value); if (!event.target.value) setSchemaLocked(false); }}>
            <option value="">不绑定模型</option>{schemas.data?.items.map(item => <option key={item.id} value={item.id}>{item.name} · r{item.currentRevision}</option>)}
          </select></label>
          {schemas.isError && <p role="alert">{schemas.error.message}<button className="secondary-button" type="button" onClick={() => schemas.refetch()}>重试模型选项</button></p>}
          <label className="schema-checkbox"><input type="checkbox" aria-label="锁定模型绑定" checked={schemaLocked} disabled={!schemaId || saving} onChange={event => setSchemaLocked(event.target.checked)} />锁定模型绑定</label>
          <label>
            JSON
            <textarea
              aria-label="JSON"
              className="json-textarea"
              value={jsonText}
              onChange={(event) => setJsonText(event.target.value)}
              spellCheck={false}
            />
          </label>

          {error && <div className="login-error" role="alert">{error}<SchemaIssues issues={issues} /></div>}

          <div className="dialog-actions">
            <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button className="primary-button" type="submit" disabled={saving}>
              <Plus size={16} />
              {saving ? "正在创建…" : "新建数据仓"}
            </button>
          </div>
        </form>
    </Dialog>
  );
}

function EmptyState({
  title,
  description,
  action,
  onAction,
}: {
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <FileJson2 size={21} />
      </div>
      <strong>{title}</strong>
      <p>{description}</p>
      {action && onAction && (
        <button className="secondary-button" type="button" onClick={onAction}>
          <Plus size={15} />
          {action}
        </button>
      )}
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
  icon: LucideIcon;
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
      <span className="health-state">{ready ? "正常" : "待配置"}</span>
    </div>
  );
}

export default App;
