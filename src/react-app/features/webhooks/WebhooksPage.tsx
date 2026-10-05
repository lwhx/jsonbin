import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  WebhookApiError, createWebhook, deleteWebhook, eventPatterns, listDeliveries, listWebhooks,
  patternLabels, randomSecret, testWebhook, updateWebhook, webhookEtag, type Webhook,
} from "./api";
import { useConfirm } from "../../components/ConfirmDialog";

const displayTime = (value: string | null | undefined, fallback: string) => value ? new Date(value).toLocaleString("zh-CN") : fallback;
const statusLabels = { delivered: "已送达", pending: "待重试", failed: "失败" } as const;

type EditState = { id: string; name: string; url: string; secret: string; events: string[]; precise: string };
const parsePrecise = (text: string) => text.split(/[,，\s]+/).map(value => value.trim()).filter(value => value && !value.endsWith(".*"));

export function WebhooksPage({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const client = useQueryClient(), mounted = useRef(false);
  const confirm = useConfirm();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const query = useQuery({ queryKey: ["webhooks"], queryFn: ({ signal }) => listWebhooks(signal), retry: false });

  const [name, setName] = useState(""), [url, setUrl] = useState(""), [secret, setSecret] = useState("");
  const [events, setEvents] = useState<string[]>(["bin.*"]);
  const [precise, setPrecise] = useState("");
  const [editing, setEditing] = useState<EditState | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<Error | null>(null), [notice, setNotice] = useState("");

  const dirty = Boolean(editing) || Boolean(name || url || secret || events.length || precise);
  useEffect(() => { onDirtyChange(dirty || busy); }, [dirty, busy, onDirtyChange]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, busy]);

  function report(caught: unknown) {
    if (mounted.current) setError(caught instanceof Error ? caught : new Error("操作失败，请重试。"));
  }
  function toggleEvent(list: string[], event: string) {
    return list.includes(event) ? list.filter(item => item !== event) : [...list, event];
  }

  async function create() {
    if (busy) return;
    setBusy(true); setError(null); setNotice("");
    try {
      const webhook = await createWebhook({ name, url, secret, events: [...events, ...parsePrecise(precise)] });
      if (!mounted.current) return;
      setNotice(`Webhook“${webhook.name}”已创建。可点击“发送测试”验证接收端。`);
      setName(""); setUrl(""); setSecret(""); setEvents(["bin.*"]); setPrecise("");
      await client.invalidateQueries({ queryKey: ["webhooks"] });
    } catch (caught) { report(caught); } finally { if (mounted.current) setBusy(false); }
  }

  async function toggleActive(webhook: Webhook) {
    if (busy) return;
    setBusy(true); setError(null); setNotice("");
    try {
      const etag = await webhookEtag(webhook.id);
      await updateWebhook(webhook.id, etag, { active: !webhook.active });
      if (!mounted.current) return;
      setNotice(`Webhook“${webhook.name}”已${webhook.active ? "停用" : "启用"}。`);
      await client.invalidateQueries({ queryKey: ["webhooks"] });
    } catch (caught) { report(caught); } finally { if (mounted.current) setBusy(false); }
  }

  async function saveEdit() {
    if (busy || !editing) return;
    setBusy(true); setError(null); setNotice("");
    try {
      const etag = await webhookEtag(editing.id);
      await updateWebhook(editing.id, etag, {
        name: editing.name, url: editing.url,
        ...(editing.secret.trim() ? { secret: editing.secret.trim() } : {}),
        events: [...editing.events, ...parsePrecise(editing.precise)],
      });
      if (!mounted.current) return;
      setEditing(null);
      setNotice("Webhook 已更新，修改对下一次事件立即生效。");
      await client.invalidateQueries({ queryKey: ["webhooks"] });
    } catch (caught) { report(caught); } finally { if (mounted.current) setBusy(false); }
  }

  async function sendTest(webhook: Webhook) {
    if (busy) return;
    setBusy(true); setError(null); setNotice("");
    try {
      const delivery = await testWebhook(webhook.id);
      if (!mounted.current) return;
      setExpanded(webhook.id);
      setNotice(delivery?.status === "delivered" ? "测试投递已送达接收端。" : `测试投递未成功（${delivery ? statusLabels[delivery.status] : "无记录"}），可在下方记录中查看原因。`);
      await client.invalidateQueries({ queryKey: ["webhooks"] });
      await client.invalidateQueries({ queryKey: ["webhook-deliveries", webhook.id] });
    } catch (caught) { report(caught); } finally { if (mounted.current) setBusy(false); }
  }

  async function remove(webhook: Webhook) {
    if (busy || !await confirm({
      title: "删除 Webhook",
      message: `确定要删除“${webhook.name}”吗？其投递记录将一并删除，接收端将不再收到事件。`,
      confirmLabel: "删除",
      danger: true,
    })) return;
    setBusy(true); setError(null); setNotice("");
    try {
      const etag = await webhookEtag(webhook.id);
      await deleteWebhook(webhook.id, etag);
      if (!mounted.current) return;
      setEditing(null); setExpanded(null);
      setNotice("Webhook 已删除。");
      await client.invalidateQueries({ queryKey: ["webhooks"] });
    } catch (caught) { report(caught); } finally { if (mounted.current) setBusy(false); }
  }

  const eventPicker = (selected: string[], onToggle: (event: string) => void, labelPrefix: string, disabled: boolean) =>
    <fieldset className="key-scopes" disabled={disabled}><legend>订阅事件</legend>
      {eventPatterns.map(pattern => <label className="schema-checkbox" key={pattern}>
        <input type="checkbox" aria-label={`${labelPrefix} ${pattern}`} checked={selected.includes(pattern)} onChange={() => onToggle(pattern)} />
        <span>{patternLabels[pattern]} <code>{pattern}</code></span>
      </label>)}
      <p>选择组通配（如 bin.*）订阅该资源全部事件；精确动作请在下方输入框补充（如 bin.updated）。</p>
    </fieldset>;

  return <section className="keys-page"><header className="hero bins-hero"><div><span className="eyebrow">开发者</span><h1>Webhook</h1>
    <p>订阅资源生命周期事件（创建/更新/发布相关/删除/恢复/过期等），JSONBin 在事件发生后回调你的接收端。投递带 HMAC-SHA256 签名（X-JSONBin-Signature: sha256=HMAC(secret, "timestamp.body")），失败自动按退避重试（10秒起，最多 6 次），24 小时前的已完成记录自动清理。</p></div>
    <button className="secondary-button" disabled={busy} onClick={() => query.refetch()}>刷新列表</button></header>
    {notice && <p className="detail-notice" role="status">{notice}</p>}
    {error && <div className="detail-error" role="alert">{error.message}
      {error instanceof WebhookApiError && error.status === 401 && <button className="secondary-button" onClick={() => client.invalidateQueries({ queryKey: ["auth-me"] })}>重新登录</button>}
    </div>}
    <form className="panel detail-form" onSubmit={event => { event.preventDefault(); create(); }}>
      <h2>创建 Webhook</h2>
      <label>名称<input aria-label="Webhook 名称" required maxLength={160} disabled={busy} value={name} autoComplete="off" onChange={event => setName(event.target.value)} /></label>
      <label>接收端 URL<input aria-label="接收端 URL" required type="url" placeholder="https://example.com/hooks/jsonbin" disabled={busy} value={url} onChange={event => setUrl(event.target.value)} /></label>
      <label>签名密钥（至少 16 位）
        <span style={{ display: "flex", gap: "8px" }}>
          <input aria-label="签名密钥" required minLength={16} maxLength={256} disabled={busy} value={secret} autoComplete="off" onChange={event => setSecret(event.target.value)} />
          <button type="button" className="secondary-button" disabled={busy} onClick={() => setSecret(randomSecret())}>随机生成</button>
        </span>
      </label>
      {eventPicker(events, event => setEvents(toggleEvent(events, event)), "创建事件", busy)}
      <label>精确动作（可选，逗号分隔）<input aria-label="精确动作" placeholder="bin.updated, bin.deleted" disabled={busy} value={precise} onChange={event => setPrecise(event.target.value)} /></label>
      <button className="primary-button" type="submit" disabled={busy || !name.trim() || !url.trim() || secret.length < 16 || (!events.length && !parsePrecise(precise).length)}>{busy ? "正在处理…" : "创建 Webhook"}</button>
    </form>
    <section className="panel collection-panel" aria-label="已创建的 Webhook"><h2>已创建的 Webhook · {query.data?.total ?? 0} 个</h2>
      {query.isPending ? <p role="status">正在加载…</p> : query.isError ? <><p role="alert">{query.error.message}</p>
        <button className="secondary-button" onClick={() => query.refetch()}>重试</button></> : query.data.items.length ?
        <ul className="key-list">{query.data.items.map(webhook => <li key={webhook.id}><div className="key-card-main"><h3>{webhook.name}</h3>
          <p>状态：{webhook.active ? "启用" : "停用"}</p>
          <p style={{ wordBreak: "break-all" }}><a href={webhook.url} target="_blank" rel="noreferrer">{webhook.url}</a></p>
          <p>订阅：<code>{webhook.events.join("</code> · <code>")}</code></p>
          <p>创建：{displayTime(webhook.createdAt, "—")}</p>
        </div>
          {editing?.id === webhook.id && <form className="detail-form" style={{ borderTop: "1px solid var(--border)", marginTop: "12px", paddingTop: "12px" }}
            onSubmit={event => { event.preventDefault(); saveEdit(); }}>
            <label>名称<input aria-label={`编辑名称 ${webhook.name}`} required maxLength={160} disabled={busy} value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
            <label>接收端 URL<input aria-label={`编辑 URL ${webhook.name}`} required type="url" disabled={busy} value={editing.url} onChange={event => setEditing({ ...editing, url: event.target.value })} /></label>
            <label>签名密钥（留空表示不修改）<input aria-label={`编辑密钥 ${webhook.name}`} minLength={16} maxLength={256} disabled={busy} value={editing.secret} autoComplete="off" onChange={event => setEditing({ ...editing, secret: event.target.value })} /></label>
            {eventPicker(editing.events, event => setEditing({ ...editing, events: toggleEvent(editing.events, event) }), `编辑事件 ${webhook.name}`, busy)}
            <label>精确动作（逗号分隔）<input aria-label={`编辑精确动作 ${webhook.name}`} disabled={busy} value={editing.precise} onChange={event => setEditing({ ...editing, precise: event.target.value })} /></label>
            <div className="detail-actions">
              <button className="primary-button" type="submit" disabled={busy || !editing.name.trim() || !editing.url.trim() || (!editing.events.length && !parsePrecise(editing.precise).length)}>{busy ? "正在保存…" : "保存修改"}</button>
              <button className="secondary-button" type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button>
            </div>
          </form>}
          {expanded === webhook.id && <DeliveriesPanel webhookId={webhook.id} />}
          <div className="key-card-actions">
            <button className="secondary-button" type="button" disabled={busy} onClick={() => toggleActive(webhook)}>{webhook.active ? "停用" : "启用"}</button>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => sendTest(webhook)} aria-label={`发送测试 ${webhook.name}`}>发送测试</button>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => setEditing(editing?.id === webhook.id ? null : { id: webhook.id, name: webhook.name, url: webhook.url, secret: "", events: webhook.events.filter(event => event.endsWith(".*")), precise: webhook.events.filter(event => !event.endsWith(".*")).join(", ") })} aria-label={`编辑 ${webhook.name}`}>{editing?.id === webhook.id ? "取消编辑" : "编辑"}</button>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => setExpanded(expanded === webhook.id ? null : webhook.id)} aria-label={`投递记录 ${webhook.name}`}>{expanded === webhook.id ? "收起记录" : "投递记录"}</button>
            <button className="danger-button" disabled={busy} onClick={() => remove(webhook)} aria-label={`删除 ${webhook.name}`}>删除</button>
          </div></li>)}</ul>
        : <p>暂无 Webhook。</p>}
    </section>
  </section>;
}

function DeliveriesPanel({ webhookId }: { webhookId: string }) {
  const query = useQuery({ queryKey: ["webhook-deliveries", webhookId], queryFn: ({ signal }) => listDeliveries(webhookId, signal), retry: false });
  return <div style={{ borderTop: "1px solid var(--border)", marginTop: "12px", paddingTop: "12px" }} aria-label="最近投递记录">
    <h4>最近投递</h4>
    {query.isPending ? <p role="status">正在加载…</p> : query.isError ? <p role="alert">{query.error.message}</p> : !query.data.items.length ? <p>暂无投递记录。</p> :
      <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px" }}>
        {query.data.items.map(delivery => <li key={delivery.id}>
          <code>{delivery.event}</code> · {statusLabels[delivery.status]} · 尝试 {delivery.attempts}/{delivery.maxAttempts}
          {delivery.lastError && ` · ${delivery.lastError}`}
          {delivery.lastStatusCode && ` · HTTP ${delivery.lastStatusCode}`}
          {` · ${displayTime(delivery.status === "delivered" ? delivery.deliveredAt : delivery.createdAt, "—")}`}
        </li>)}
      </ul>}
  </div>;
}
