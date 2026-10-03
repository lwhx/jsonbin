import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BackupPackage, RestoreResult } from '../../../shared/backup-types.ts';
import type { ImportResult } from '../../../shared/system.ts';
import { SystemError } from '../../../shared/system.ts';
import { assertBytes } from '../../../shared/backup.ts';
import { parseStandardFiles, readBackupFile, type ImportPreviewItem } from './files';
import { runRestore } from './transfer';
import { SystemApiError, type SystemClient } from './api';
const statusLabels = { created: '创建成功', unchanged: '已恢复，无需修改', skipped: 'ID 冲突，已跳过', dependency_skipped: '关联冲突，已跳过', failed: '失败' };
export function ImportPanel({ client, onBusyChange, onCompleted }: { client: SystemClient; onBusyChange: (busy: boolean) => void; onCompleted: () => void }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['system-settings'], queryFn: ({ signal }) => client.getSettings(signal), retry: false });
  const [mode, setMode] = useState('json'), [items, setItems] = useState<ImportPreviewItem[]>([]), [backup, setBackup] = useState<BackupPackage | null>(null);
  const [results, setResults] = useState<(RestoreResult | ImportResult)[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [attempted, setAttempted] = useState(false);
  const mounted = useRef(false), generation = useRef(0), controller = useRef<AbortController | null>(null), running = useRef(false), fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { mounted.current = true; const cancel = reset; window.addEventListener('jsonbin:logout', cancel); return () => { mounted.current = false; generation.current++; controller.current?.abort(); window.removeEventListener('jsonbin:logout', cancel); }; }, []);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  function message(e: unknown) { return e instanceof SystemApiError ? e.message : e instanceof SystemError && e.status === 413 ? '文件或批次超过大小、资源或对象数量上限。' : '文件格式、编码或关联不符合要求，请检查后重新选择。'; }
  function reset() { generation.current++; controller.current?.abort(); controller.current = null; running.current = false; setBusy(false); setItems([]); setBackup(null); setResults([]); setError(''); setAttempted(false); setNotice(busy ? '已停止等待；部分操作可能已提交，请先检查列表。' : ''); }
  function stop() {
    if (controller.current) controller.current.abort();
    else { generation.current++; running.current = false; setBusy(false); setNotice('已停止读取；迟到的文件结果将丢弃。'); }
  }
  async function select(files: readonly File[]) {
    reset(); if (!files.length) return; const token = generation.current; setBusy(true); running.current = true;
    try { if (mode === 'backup' && files.length !== 1) throw new Error(); const value = mode === 'json' ? await parseStandardFiles(files) : await readBackupFile(files[0]);
      if (!mounted.current || token !== generation.current) return; if (Array.isArray(value)) setItems(value); else setBackup(value);
    } catch (e) { if (mounted.current && token === generation.current) setError(message(e)); }
    finally { if (mounted.current && token === generation.current) { setBusy(false); running.current = false; } }
  }
  async function submit(applySettings = false) {
    if (running.current) return;
    if (!applySettings && attempted && mode === 'json') return;
    if (!backup && !items.length) return;
    if (!applySettings && items.some(item => !item.name.trim() || item.name.trim().length > 160)) { setError('每个名称应为 1–160 个字符。'); return; }
    if (!applySettings) { try { if (items.length) assertBytes({ items: items.map(({ name, value }) => ({ name: name.trim(), value })) }); } catch (e) { setError(message(e)); return; } }
    const token = generation.current, abort = new AbortController(); controller.current = abort; running.current = true; setBusy(true); setError(''); setNotice('');
    if (!applySettings) { setResults([]); setAttempted(true); }
    try {
      if (applySettings && backup) {
        if (!settings.data) throw new SystemApiError(428, 'precondition_required');
        const saved = await client.patchSettings(backup.settings, settings.data.etag, abort.signal);
        if (!mounted.current || token !== generation.current) return; queryClient.setQueryData(['system-settings'], saved); setNotice('备份默认设置已单独应用。');
      } else if (backup) {
        await runRestore(backup, client, result => { if (mounted.current && token === generation.current) setResults(previous => [...previous, result]); }, abort.signal);
        if (!mounted.current || token !== generation.current) return; setNotice(abort.signal.aborted ? '已停止等待；已提交的数据保留，未完成项可用同一备份续作。' : '恢复处理完成，请检查逐项结果。');
      } else {
        const response = await client.importJson(items.map(({ name, value }) => ({ name: name.trim(), value })), abort.signal);
        if (!mounted.current || token !== generation.current) return; setResults(response.results); setNotice('导入处理完成，请检查逐项结果。');
      }
      if (mounted.current && token === generation.current) onCompleted();
    } catch (e) { if (mounted.current && token === generation.current) { setError(abort.signal.aborted ? '已停止等待；部分操作可能已提交，请先检查列表再重试。' : message(e)); if (e instanceof SystemApiError && [400, 413, 422].includes(e.status)) setAttempted(false); onCompleted(); } }
    finally { if (mounted.current && token === generation.current) { running.current = false; setBusy(false); } }
  }
  const resourceCount = backup ? backup.collections.length + backup.schemas.length + backup.bins.length + backup.purged.length : 0;
  return <section className="panel import-panel"><h2>导入 JSON 或业务备份</h2><p>先选择模式和文件，预览后确认。普通 JSON 每个文件创建一个新 Bin，数组作为一个完整值导入。</p>
    <div className="settings-form"><label>导入模式<select aria-label="导入模式" value={mode} onChange={event => { reset(); setMode(event.target.value); if (fileInput.current) fileInput.current.value = ''; }}><option value="json">普通 JSON 文件</option><option value="backup">JSONBin 业务备份（JSON / ZIP）</option></select></label>
    <label>选择导入文件<input ref={fileInput} aria-label="选择导入文件" type="file" accept={mode === 'json' ? '.json,application/json' : '.json,.zip,application/json,application/zip'} multiple={mode === 'json'} onChange={event => void select(Array.from(event.target.files ?? []))} /></label></div>
    {items.length > 0 && <><p>{items.length} 个文件。{settings.data ? `使用创建时默认：${settings.data.settings.defaultVisibility === 'public' ? '公开' : '私有'}；TTL ${settings.data.settings.defaultTtlSeconds === null ? '永不过期' : settings.data.settings.defaultTtlSeconds + ' 秒'}（以创建时设置为准）。` : '默认值暂不可用；以服务器创建时设置为准，设置不可读时创建会失败。'}</p><div className="import-preview">{items.map((item, index) => <label key={index}><span>{item.fileName} · {item.type} · {item.bytes} B</span><input aria-label={`目标名称 ${index + 1}`} value={item.name} disabled={busy || attempted} maxLength={160} onChange={event => setItems(previous => previous.map((p, i) => i === index ? { ...p, name: event.target.value } : p))} /></label>)}</div></>}
    {backup && <div className="backup-preview"><p>{resourceCount} 个资源：集合 {backup.collections.length}，模型 {backup.schemas.length}，Bin {backup.bins.length}，永久删除标记 {backup.purged.length}。</p>
      <p>公开资源：{backup.bins.filter(b => b.meta.visibility === 'public').length}；已到期：{backup.bins.filter(b => b.meta.expiresAt && Date.parse(b.meta.expiresAt) <= Date.now()).length}。保留原 ID、历史、可见性、TTL 和锁；已有 ID 跳过，关联冲突不会换绑。</p>
      <p>设置候选：{backup.settings.defaultVisibility === 'public' ? '公开' : '私有'}，TTL {backup.settings.defaultTtlSeconds === null ? '永不过期' : `${backup.settings.defaultTtlSeconds} 秒`}。{settings.data && JSON.stringify(backup.settings) !== JSON.stringify({ defaultVisibility: settings.data.settings.defaultVisibility, defaultTtlSeconds: settings.data.settings.defaultTtlSeconds }) ? '与当前设置不同。' : settings.data ? '与当前设置一致。' : '当前设置尚未读取。'}恢复资源不会自动应用设置。</p>
      <button className="secondary-button" disabled={busy || !settings.data} onClick={() => void submit(true)}>应用备份默认设置</button></div>}
    <p>普通文件 ≤1 MiB；批次 ≤100 项 / 10 MiB。备份 ≤100 资源 / 250 对象 / 10 MiB，仅支持本应用的 STORE ZIP。中断可能已经提交部分数据；普通导入请检查列表，恢复可重新选择相同备份续作。</p>
    <div className="settings-actions"><button className="primary-button" disabled={busy || (mode === 'json' ? !items.length || attempted : !backup || !resourceCount)} onClick={() => void submit()}>{mode === 'json' ? '确认导入' : '确认恢复'}</button>{busy && <button className="secondary-button" onClick={stop}>停止等待</button>}</div>
    {busy && <p role="status">正在处理文件或传输…</p>}{notice && <p role="status">{notice}</p>}{error && <p className="detail-error" role="alert">{error}</p>}
    {results.length > 0 && <ul className="transfer-results">{results.map((r, i) => <li key={i}>{'kind' in r ? `${r.kind === 'collection' ? '集合' : r.kind === 'schema' ? '模型' : 'Bin'} ${r.id}` : `文件 ${r.index + 1}`}：{statusLabels[r.status]}{'warnings' in r && r.warnings?.map(w => <span key={w}> · {w === 'collection_detached' ? '集合已删除，已解除关联' : '已创建，但集合清理失败；可用同一备份重试'}</span>)}{'error' in r && r.error === 'network_error' && <span> · 连接中断，可能已提交，请检查列表</span>}</li>)}</ul>}
  </section>;
}
