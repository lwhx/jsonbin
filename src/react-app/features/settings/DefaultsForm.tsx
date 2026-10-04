import { useEffect, useRef, useState } from 'react';
import type { SettingsRecord } from '../../../shared/system.ts';
import { systemApi } from './api';
export function DefaultsForm({ record, onSaved, onDirtyChange }: { record: SettingsRecord; onSaved: (r: SettingsRecord) => void; onDirtyChange: (dirty: boolean) => void }) {
  const [saved, setSaved] = useState(record), [visibility, setVisibility] = useState(record.settings.defaultVisibility), [ttl, setTtl] = useState(record.settings.defaultTtlSeconds?.toString() ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(false), generation = useRef(0), controller = useRef<AbortController | null>(null), running = useRef(false);
  const dirty = visibility !== saved.settings.defaultVisibility || ttl !== (saved.settings.defaultTtlSeconds?.toString() ?? '');
  useEffect(() => { mounted.current = true; const cancel = () => { generation.current++; controller.current?.abort(); running.current = false; setBusy(false); }; window.addEventListener('jsonbin:logout', cancel); return () => { mounted.current = false; generation.current++; controller.current?.abort(); window.removeEventListener('jsonbin:logout', cancel); }; }, []);
  useEffect(() => { onDirtyChange(dirty || busy); }, [dirty, busy, onDirtyChange]);
  useEffect(() => { if (!dirty && !busy && record.etag !== saved.etag) apply(record); }, [record, dirty, busy, saved.etag]);
  function apply(r: SettingsRecord) { setSaved(r); setVisibility(r.settings.defaultVisibility); setTtl(r.settings.defaultTtlSeconds?.toString() ?? ''); }
  async function execute(reload: boolean) {
    if (running.current) return;
    if (reload && dirty && !await confirmDialog({
      title: "重新读取默认设置？",
      message: "重新读取会丢弃当前未保存的默认设置草稿。",
      cancelLabel: "继续编辑",
      confirmLabel: "放弃并重新读取",
      tone: "danger",
    })) return;
    const seconds = ttl === '' ? null : Number(ttl);
    if (!reload && (seconds !== null && (!Number.isInteger(seconds) || seconds < 1 || seconds > 31536000))) { setError('TTL 请填写 1–31536000 的整数秒，或留空表示永不过期。'); return; }
    const token = ++generation.current, abort = new AbortController(); controller.current = abort; running.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const r = reload ? await systemApi.getSettings(abort.signal) : await systemApi.patchSettings({ defaultVisibility: visibility, defaultTtlSeconds: seconds }, saved.etag, abort.signal);
      if (!mounted.current || token !== generation.current) return;
      apply(r); onSaved(r); setNotice(reload ? '已读取最新设置。' : '默认设置已保存。');
    } catch (e) { if (mounted.current && token === generation.current && !abort.signal.aborted) setError(e instanceof Error ? e.message : '设置操作失败。'); }
    finally { if (mounted.current && token === generation.current) { running.current = false; setBusy(false); } }
  }
  return <section className="panel defaults-panel"><h2>新建默认设置</h2><p>仅对省略相应字段的新 Bin 生效；TTL 以创建时设置为准。</p>
    <form className="settings-form" onSubmit={event => { event.preventDefault(); void execute(false); }}>
      <label>默认可见性<select aria-label="默认可见性" value={visibility} disabled={busy} onChange={event => setVisibility(event.target.value as typeof visibility)}><option value="private">私有</option><option value="public">公开</option></select></label>
      <label>默认 TTL（秒）<input aria-label="默认 TTL（秒）" type="number" min="1" max="31536000" step="1" value={ttl} disabled={busy} onChange={event => setTtl(event.target.value)} placeholder="留空表示永不过期" /></label>
      {visibility === 'public' && <p>默认公开时，任何持有 API 地址的人都可读取新建 Bin 的当前 JSON 和元数据。</p>}
      <div className="settings-actions"><button className="primary-button" disabled={busy || !dirty}>保存默认设置</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void execute(true)}>重新读取设置</button></div>
    </form>{busy && <p role="status">正在处理设置…</p>}{notice && <p role="status">{notice}</p>}{error && <p className="detail-error" role="alert">{error}</p>}
  </section>;
}
