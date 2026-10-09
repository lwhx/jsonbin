import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { ExportQuery } from '../../../shared/system.ts';
import { validateBackup } from '../../../shared/backup.ts';
import { encodeBackupZip } from '../../../shared/zip.ts';
import type { SystemClient } from './api';
import { downloadBytes } from './download';
export function ExportPanel({ client, onBusyChange }: { client: SystemClient; onBusyChange: (busy: boolean) => void }) {
  const [id, setId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(false), generation = useRef(0), controller = useRef<AbortController | null>(null), running = useRef(false);
  useEffect(() => { mounted.current = true; const cancel = () => { generation.current++; controller.current?.abort(); running.current = false; setBusy(false); }; window.addEventListener('jsonbin:logout', cancel); window.addEventListener('jsonbin:logout-pending', cancel); return () => { mounted.current = false; generation.current++; controller.current?.abort(); window.removeEventListener('jsonbin:logout', cancel); window.removeEventListener('jsonbin:logout-pending', cancel); }; }, []);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  async function exportFile(scope: 'all' | 'config' | 'bin', format: 'backup' | 'value') {
    if (running.current) return;
    const binId = id.trim(); if (scope === 'bin' && !z.string().uuid().safeParse(binId).success) { setError('请输入有效的 Bin UUID。'); return; }
    const token = ++generation.current, abort = new AbortController(); controller.current = abort; running.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const query: ExportQuery = scope === 'bin' ? { scope, id: binId, format } : { scope, format: 'backup' };
      let bytes = await client.exportData(query, abort.signal);
      const zip = format === 'backup' && scope !== 'config';
      if (zip) bytes = await encodeBackupZip(validateBackup(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))));
      if (!mounted.current || token !== generation.current || abort.signal.aborted) return;
      downloadBytes(bytes, `jsonbin-${scope === 'bin' ? binId : scope}-${format}.${zip ? 'zip' : 'json'}`, zip ? 'application/zip' : 'application/json; charset=utf-8'); setNotice('已生成下载文件。');
    } catch (e) { if (mounted.current && token === generation.current) setError(abort.signal.aborted ? '已停止等待，未启动下载。' : e instanceof Error ? e.message : '导出失败，请稍后重试。'); }
    finally { if (mounted.current && token === generation.current) { running.current = false; setBusy(false); } }
  }
  return <section className="panel export-panel"><h2>导出业务数据</h2><p>全部备份包含集合、模型修订、Bin 历史、回收站、永久删除标记和默认设置；认证凭据、API Key、活动日志及 KV 不在业务包中。</p>
    <div className="settings-actions"><button className="primary-button" disabled={busy} onClick={() => void exportFile('all', 'backup')}>导出全部业务 ZIP</button><button className="secondary-button" disabled={busy} onClick={() => void exportFile('config', 'backup')}>导出配置 JSON</button></div>
    <label className="settings-field">导出 Bin ID<input aria-label="导出 Bin ID" value={id} disabled={busy} placeholder="资源 UUID" onChange={event => setId(event.target.value)} /></label>
    <div className="settings-actions"><button className="secondary-button" disabled={busy} onClick={() => void exportFile('bin', 'value')}>导出 Bin 当前 JSON</button><button className="secondary-button" disabled={busy} onClick={() => void exportFile('bin', 'backup')}>导出 Bin 含历史 ZIP</button>{busy && <button className="secondary-button" onClick={() => controller.current?.abort()}>停止导出</button>}</div>
    <p>当前 JSON 使用服务器已保存的值。备份逐资源复查一致性；并非全局事务，扫描开始后新建的资源可能不在包中。数据变化或超过 100 资源 / 250 对象 / 10 MiB 时会明确失败。</p>
    {busy && <p role="status">正在生成导出文件…</p>}{notice && <p role="status">{notice}</p>}{error && <p className="detail-error" role="alert">{error}</p>}
  </section>;
}
