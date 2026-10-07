import { useEffect, useRef, useState } from "react";
import { Bot, Copy, Eye, EyeOff, KeyRound, ShieldCheck } from "lucide-react";

const TOKEN_PLACEHOLDER = "jb_live_把你的令牌粘贴到上方输入框";

const READ_TOOLS: Array<[string, string]> = [
  ["list_bins", "列出可访问的数据仓，支持标签 / 收藏 / 置顶过滤，只返回元数据"],
  ["get_bin", "按 ID 或别名读取元数据、当前 JSON 与 ETag"],
  ["get_published_bin", "读取生产已发布版本"],
  ["search_bins", "搜索名称、描述与元数据"],
  ["search_json", "搜索开启了内容索引的 JSON 键或标量值"],
  ["list_bin_versions", "列出不可变历史版本"],
  ["get_bin_version", "读取指定的历史版本"],
];

const WRITE_TOOLS: Array<[string, string]> = [
  ["create_bin", "新建数据仓并写入初始 JSON（需 bin:create）"],
  ["update_bin", "全量替换 JSON（需 If-Match ETag）"],
  ["merge_patch_bin", "RFC 7396 增量合并修改"],
  ["json_patch_bin", "RFC 6902 原子结构修改，AI 修改 JSON 的主要方式"],
];

const RELEASE_TOOLS: Array<[string, string]> = [
  ["publish_bin", "把指定版本发布到生产指针"],
  ["rollback_bin", "回滚生产指针到历史版本，不追加历史"],
  ["clone_bin", "克隆快照为新私有数据仓"],
];

/** Copyable snippet block with the same feedback semantics as the docs page. */
function Snippet({ label, code }: { label: string; code: string }) {
  const alive = useRef(false);
  const serial = useRef(0);
  const identity = useRef("");
  const key = label + "\0" + code;
  if (identity.current !== key) {
    identity.current = key;
    serial.current++;
  }
  const [feedback, setFeedback] = useState<{ serial: number; kind: "pending" | "success" | "error" } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      serial.current++;
    };
  }, []);
  const current = feedback?.serial === serial.current ? feedback.kind : null;

  async function copy() {
    const attempt = ++serial.current;
    setFeedback({ serial: attempt, kind: "pending" });
    try {
      await navigator.clipboard.writeText(code);
      if (alive.current && serial.current === attempt) setFeedback({ serial: attempt, kind: "success" });
    } catch {
      if (alive.current && serial.current === attempt) setFeedback({ serial: attempt, kind: "error" });
    }
  }

  return (
    <div className="code-example">
      <div className="code-toolbar">
        <span>{label}</span>
        <button type="button" className="secondary-button" onClick={copy} disabled={current === "pending"}>
          <Copy size={14} />
          {current === "pending" ? "正在复制…" : "复制代码"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
      {current === "success" && <p role="status">已复制。</p>}
      {current === "error" && <p role="alert">无法访问剪贴板，请手动选择并复制代码。</p>}
    </div>
  );
}

function ToolGroup({ title, tools }: { title: string; tools: Array<[string, string]> }) {
  return (
    <div>
      <h3 style={{ margin: "0 0 8px" }}>{title}</h3>
      <ul className="mcp-tool-list">
        {tools.map(([name, description]) => (
          <li key={name}>
            <code>{name}</code>
            <span>{description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function McpPage() {
  const origin = window.location.origin;
  const [token, setToken] = useState("");
  const [revealed, setRevealed] = useState(false);
  const shownToken = token.trim() || TOKEN_PLACEHOLDER;

  const cursorConfig = JSON.stringify(
    {
      mcpServers: {
        jsonbin: {
          url: `${origin}/api/v1/mcp`,
          headers: { Authorization: `Bearer ${shownToken}` },
        },
      },
    },
    null,
    2,
  );

  const claudeConfig = JSON.stringify(
    {
      mcpServers: {
        jsonbin: {
          command: "npx",
          args: ["-y", "mcp-remote", `${origin}/api/v1/mcp`, "--header", `Authorization: Bearer ${shownToken}`],
        },
      },
    },
    null,
    2,
  );

  const stdioConfig = JSON.stringify(
    {
      mcpServers: {
        jsonbin: {
          command: "node",
          args: ["/path/to/jsonbin/mcp/server.js"],
          env: {
            JSONBIN_URL: origin,
            JSONBIN_TOKEN: shownToken,
          },
        },
      },
    },
    null,
    2,
  );

  const genericEndpoint = `端点（Streamable HTTP，单端点直连）
POST ${origin}/api/v1/mcp

请求头
Authorization: Bearer ${shownToken}
Content-Type: application/json

仅支持 Streamable HTTP 传输（旧版 SSE 端点已移除，返回 410）`;

  return (
    <section className="docs-page mcp-page">
      <header className="resource-heading">
        <div>
          <span className="eyebrow">开发者</span>
          <h1>MCP 接入</h1>
          <p>让 AI 客户端（Cursor、Claude Desktop、Windsurf、Codex 等）通过 Model Context Protocol 安全读写你的数据仓。</p>
          <code>{origin}/api/v1/mcp</code>
        </div>
        <Bot size={30} aria-hidden />
      </header>

      <p className="doc-note">
        服务端无需任何设置：MCP 的权限上限就是所用 API 密钥的权限。所有配置发生在 AI 客户端一侧，本页只生成可复制的配置片段，不会发起任何请求。
      </p>

      <section className="panel doc-section">
        <h2>第 1 步 · 创建专用 API 密钥</h2>
        <p>
          在「API 密钥」页新建一把独立密钥给 AI 客户端使用，不要复用其他集成的令牌。推荐最小权限组合：
        </p>
        <div className="doc-scopes">
          <code>bin:read</code>
          <code>bin:create</code>
          <code>bin:update</code>
          <code>history:read</code>
        </div>
        <p>
          需要发布或回滚时再追加对应权限；还可在资源范围中把密钥限定到指定数据仓。令牌只在创建时显示一次，请立即复制。
        </p>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            window.location.hash = "/keys";
          }}
        >
          <KeyRound size={15} />
          前往 API 密钥
        </button>
      </section>

      <section className="panel doc-section">
        <h2>粘贴令牌（可选）</h2>
        <p>粘贴后下方配置片段会自动填入令牌。令牌仅保留在当前页面内存中，刷新或离开即清除，本页不会保存或发送它。</p>
        <div style={{ display: "flex", gap: "8px", maxWidth: "480px" }}>
          <input
            type={revealed ? "text" : "password"}
            aria-label="API 令牌"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="jb_live_…"
            autoComplete="off"
            spellCheck={false}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="secondary-button"
            aria-label="显示或隐藏令牌"
            onClick={() => setRevealed((value) => !value)}
          >
            {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
      </section>

      <section className="panel doc-section">
        <h2>第 2 步 · 配置你的 AI 客户端</h2>
        <p>
          Cursor 全局配置在 <code>C:\Users\&lt;你&gt;\.cursor\mcp.json</code>（项目级为 <code>.cursor/mcp.json</code>）；
          Windsurf 在 <code>~\.codeium\windsurf\mcp_config.json</code>。
        </p>
        <Snippet label="Cursor / Windsurf · mcp.json" code={cursorConfig} />
        <p>
          Claude Desktop 仅支持本地 stdio 进程，编辑 <code>%APPDATA%\Claude\claude_desktop_config.json</code>，
          推荐用 mcp-remote 桥接云端端点：
        </p>
        <Snippet label="Claude Desktop · claude_desktop_config.json（mcp-remote）" code={claudeConfig} />
        <p>也可以使用仓库自带的本地 stdio 服务（先在本仓库执行 npm run build:sdk 与 npm run build:mcp）：</p>
        <Snippet label="本地 stdio · claude_desktop_config.json" code={stdioConfig} />
        <p>其他支持标准 Streamable HTTP 的客户端，直接使用：</p>
        <Snippet label="通用端点信息" code={genericEndpoint} />
      </section>

      <section className="panel doc-section">
        <h2>第 3 步 · 验证与使用</h2>
        <p>重启客户端后应出现 14 个 jsonbin 工具。之后直接用自然语言指挥，例如：</p>
        <blockquote className="doc-note" style={{ borderLeft: "3px solid var(--border)", margin: "8px 0", padding: "4px 12px" }}>
          「用 jsonbin 列出我的所有配置，然后把 cloudflare-config 里的 successRate 从 90 改成 80，改完发布。」
        </blockquote>
        <p>
          AI 会遵循「读取拿 ETag → 生成 JSON Patch → If-Match 条件写入」的安全流程；ETag 过期会收到 etag_conflict
          错误并重新读取后重试，不会盲写覆盖他人修改。
        </p>
      </section>

      <section className="panel doc-section">
        <h2>可用工具（14 个）</h2>
        <div className="docs-layout" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", display: "grid", gap: "18px" }}>
          <ToolGroup title="读取" tools={READ_TOOLS} />
          <ToolGroup title="写入（需 ETag）" tools={WRITE_TOOLS} />
          <ToolGroup title="发布" tools={RELEASE_TOOLS} />
        </div>
      </section>

      <section className="panel doc-section">
        <h2>
          <ShieldCheck size={18} aria-hidden /> 安全须知
        </h2>
        <ul style={{ lineHeight: 1.9, paddingLeft: "18px" }}>
          <li>给 MCP 建独立的最小权限密钥：没有 bin:delete，AI 就永远无法删除数据；删除、密钥管理等工具不会经 MCP 暴露。</li>
          <li>密钥泄露时在「API 密钥」页直接撤销，不影响其他集成。</li>
          <li>远程端点在连接时即校验令牌，无效、已撤销或已过期的令牌返回 401。</li>
          <li>仅支持 Streamable HTTP 传输：每个请求都独立校验令牌，无长期会话凭据。</li>
          <li>复制带令牌的片段时令牌会进入剪贴板，注意所在环境的安全。</li>
        </ul>
      </section>
    </section>
  );
}
