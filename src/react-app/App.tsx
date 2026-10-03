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
import { FormEvent, useEffect, useMemo, useState } from "react";

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

type Section = "Overview" | "Bins";

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
  { label: "Overview", icon: LayoutDashboard, section: "Overview" },
  { label: "Bins", icon: FileJson2, section: "Bins" },
  { label: "Collections", icon: Boxes, disabled: true },
  { label: "Schemas", icon: Braces, disabled: true },
  { divider: true, label: "Developer" },
  { label: "API Keys", icon: KeyRound, disabled: true },
  { label: "Activity", icon: Activity, disabled: true },
  { label: "API Docs", icon: TerminalSquare, disabled: true },
  { divider: true, label: "System" },
  { label: "Trash", icon: Archive, disabled: true },
  { label: "Settings", icon: Settings, disabled: true },
];

function apiErrorMessage(status: number) {
  if (status === 401) return "Username or password is incorrect.";
  if (status === 503) return "This login method is not configured yet.";
  return "Something went wrong. Please try again.";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function timeAgo(value: string) {
  const ms = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
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
      if (!response.ok) throw new Error("Unable to check session");
      const data = (await response.json()) as {
        authenticated: boolean;
        user: AuthUser;
      };
      return data.authenticated ? data.user : null;
    },
    retry: false,
  });

  if (auth.isLoading) {
    return <BootScreen />;
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
      <span>Loading JSONBin…</span>
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
      if (!response.ok) throw new Error("Unable to load auth configuration");
      return response.json();
    },
  });

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
      setError("Unable to reach the Worker API.");
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
        aria-label="Toggle color theme"
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
            <span>Private Cloud</span>
          </div>
        </div>

        <div className="login-heading">
          <span className="eyebrow">Private workspace</span>
          <h1>Welcome back</h1>
          <p>Sign in to manage your JSON, configs and automation data.</p>
        </div>

        {config.data?.passwordEnabled !== false && (
          <form className="login-form" onSubmit={submit}>
            <label>
              Username
              <input
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="admin"
                required
              />
            </label>

            <label>
              Password
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
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}

        {config.data?.githubEnabled && (
          <>
            <div className="login-separator">
              <span>or</span>
            </div>
            <a className="github-login" href="/api/v1/auth/github">
              <Code2 size={17} />
              Continue with GitHub
            </a>
          </>
        )}

        <div className="login-footnote">
          Single-user mode · Cloudflare Workers · R2
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
  const [section, setSection] = useState<Section>("Overview");
  const [createOpen, setCreateOpen] = useState(false);

  const health = useQuery({
    queryKey: ["system-health"],
    queryFn: async (): Promise<Health> => {
      const response = await fetch("/api/v1/system/health");
      if (!response.ok) throw new Error("Health check failed");
      return response.json();
    },
  });

  const bins = useQuery({
    queryKey: ["bins"],
    queryFn: async (): Promise<BinList> => {
      const response = await fetch("/api/v1/bins", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Unable to load bins");
      return response.json();
    },
    retry: false,
  });

  const storageLabel = useMemo(() => {
    if (!health.data) return "Checking bindings";
    if (health.data.storage.r2 && health.data.storage.kv) {
      return "R2 + KV connected";
    }
    if (health.data.storage.r2) return "R2 connected · KV pending";
    return "Storage setup required";
  }, [health.data]);

  async function logout() {
    await fetch("/api/v1/auth/logout", {
      method: "POST",
      credentials: "include",
    });
    queryClient.setQueryData(["auth-me"], null);
    queryClient.removeQueries({ queryKey: ["bins"] });
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
                {item.disabled && <span className="soon-badge">Soon</span>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-status">
          <div className="status-row">
            <span
              className={`status-indicator ${health.data?.storage.r2 ? "" : "warning"}`}
            />
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
              onClick={onToggleTheme}
              aria-label="Toggle color theme"
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button
              className="user-chip"
              type="button"
              title={`Signed in with ${user.provider}`}
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
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>

        <div className="content">
          {section === "Overview" ? (
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
            />
          )}
        </div>
      </main>

      {createOpen && (
        <CreateBinDialog
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false);
            await queryClient.invalidateQueries({ queryKey: ["bins"] });
            setSection("Bins");
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

  return (
    <>
      <section className="hero">
        <div>
          <span className="eyebrow">Private workspace</span>
          <h1>JSON control center</h1>
          <p>Your JSON storage, configuration and automation data in one place.</p>
        </div>
        <button className="primary-button" type="button" onClick={onCreate}>
          <Zap size={16} fill="currentColor" />
          Create bin
        </button>
      </section>

      <section className="metrics-grid" aria-label="Overview metrics">
        <MetricCard
          label="Total Bins"
          value={binsLoading ? "—" : String(bins.length)}
          note={binsError ? "Storage unavailable" : "R2 objects"}
          icon={FileJson2}
        />
        <MetricCard label="Collections" value="0" note="Coming next" icon={Boxes} />
        <MetricCard label="Versions" value={String(bins.reduce((n, b) => n + b.currentVersion, 0))} note="Immutable history" icon={Activity} />
        <MetricCard
          label="Storage"
          value={formatBytes(totalStorage)}
          note="Current JSON"
          icon={Database}
        />
      </section>

      <section className="dashboard-grid">
        <div className="panel requests-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">Workspace</span>
              <h2>Recently updated</h2>
            </div>
            <button className="ghost-button" type="button" onClick={onOpenBins}>
              View bins
              <ChevronRight size={15} />
            </button>
          </div>

          {binsError ? (
            <EmptyState
              title="R2 is not ready"
              description="Configure the DATA binding to start storing bins."
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
                    <span>Version {item.currentVersion}</span>
                  </div>
                  <span className="activity-action">{formatBytes(item.size)}</span>
                  <time>{timeAgo(item.updatedAt)}</time>
                  <ChevronRight className="row-chevron" size={16} />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No bins yet"
              description="Create your first JSON bin to start using the workspace."
              action="Create bin"
              onAction={onCreate}
            />
          )}
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
            ready={Boolean(health?.ok)}
          />
          <HealthItem
            name="R2 storage"
            detail="Source of truth"
            ready={Boolean(health?.storage.r2)}
          />
          <HealthItem
            name="KV cache"
            detail="Index & edge cache"
            ready={Boolean(health?.storage.kv)}
          />

          <div className="health-note">
            <CircleCheck size={16} />
            <span>v3 CI is passing with TypeScript and production build checks.</span>
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
}: {
  bins: BinMeta[];
  loading: boolean;
  error: boolean;
  onCreate: () => void;
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
          <span className="eyebrow">Data</span>
          <h1>Bins</h1>
          <p>Independent versioned JSON documents stored in R2.</p>
        </div>
        <button className="primary-button" type="button" onClick={onCreate}>
          <Plus size={16} />
          New bin
        </button>
      </section>

      <div className="bins-toolbar">
        <div className="bins-search">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search bins…"
          />
        </div>
        <span>{bins.length} total</span>
      </div>

      {error ? (
        <div className="panel">
          <EmptyState
            title="Unable to load bins"
            description="Check that the R2 DATA binding is configured."
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
            <article className="bin-card" key={bin.id}>
              <div className="bin-card-top">
                <div className="file-icon large">
                  <FileJson2 size={19} />
                </div>
                <span className={`visibility-pill ${bin.visibility}`}>
                  {bin.visibility === "private" && <LockKeyhole size={11} />}
                  {bin.visibility}
                </span>
              </div>

              <h3>{bin.name}</h3>
              <p>{bin.description || "No description"}</p>

              <div className="bin-meta-row">
                <span>v{bin.currentVersion}</span>
                <span>{formatBytes(bin.size)}</span>
                <span>{timeAgo(bin.updatedAt)}</span>
              </div>

              <div className="bin-id">{bin.id}</div>
            </article>
          ))}
        </div>
      ) : (
        <div className="panel">
          <EmptyState
            title={search ? "No matching bins" : "No bins yet"}
            description={
              search
                ? "Try another search term."
                : "Create your first versioned JSON document."
            }
            action={search ? undefined : "Create bin"}
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
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [jsonText, setJsonText] = useState(`{
  "hello": "world"
}`);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    let value: unknown;
    try {
      value = JSON.parse(jsonText);
    } catch {
      setError("The JSON content is not valid.");
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
          visibility,
          value,
        }),
      });

      if (!response.ok) {
        setError(
          response.status === 500
            ? "R2 storage is not configured yet."
            : "Unable to create the bin.",
        );
        return;
      }

      onCreated();
    } catch {
      setError("Unable to reach the Worker API.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-bin-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">New document</span>
            <h2 id="create-bin-title">Create bin</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>
            <X size={17} />
          </button>
        </div>

        <form className="create-form" onSubmit={submit}>
          <div className="form-grid">
            <label>
              Name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="cloudflare-config"
                required
              />
            </label>

            <label>
              Visibility
              <select
                value={visibility}
                onChange={(event) =>
                  setVisibility(event.target.value as "private" | "public")
                }
              >
                <option value="private">Private</option>
                <option value="public">Public</option>
              </select>
            </label>
          </div>

          <label>
            Description
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional note about this JSON document"
            />
          </label>

          <label>
            JSON
            <textarea
              className="json-textarea"
              value={jsonText}
              onChange={(event) => setJsonText(event.target.value)}
              spellCheck={false}
            />
          </label>

          {error && <div className="login-error">{error}</div>}

          <div className="dialog-actions">
            <button className="secondary-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-button" type="submit" disabled={saving}>
              <Plus size={16} />
              {saving ? "Creating…" : "Create bin"}
            </button>
          </div>
        </form>
      </div>
    </div>
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
      <span className="health-state">{ready ? "Ready" : "Setup"}</span>
    </div>
  );
}

export default App;
