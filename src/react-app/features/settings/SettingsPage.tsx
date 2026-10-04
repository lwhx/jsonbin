import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { systemApi } from './api';
import type { SettingsRecord } from '../../../shared/system.ts';
import { DefaultsForm } from './DefaultsForm';
import { ImportPanel } from './ImportPanel';
import { ExportPanel } from './ExportPanel';
import { SearchIndexPanel } from '../search/SearchIndexPanel';
const probes = { unconfigured: '未配置', reachable: '读探测通过', unavailable: '读探测失败' };
const statsLabels = { activeBins: '正常 Bin', trashBins: '回收站 Bin', pendingImports: '未完成恢复', collections: '可用集合', schemas: '可用模型', versions: '保留 JSON 版本', currentValueBytes: '当前 JSON 逻辑字节', storedBytes: '业务对象实际字节（含历史与未完成文件）' };
export function SettingsPage({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const client = useQueryClient();
  const info = useQuery({ queryKey: ['system-info'], queryFn: ({ signal }) => systemApi.getInfo(signal), retry: false });
  const settings = useQuery({ queryKey: ['system-settings'], queryFn: ({ signal }) => systemApi.getSettings(signal), retry: false });
  const [dirty, setDirty] = useState(false), [importBusy, setImportBusy] = useState(false), [exportBusy, setExportBusy] = useState(false);
  const [indexBusy, setIndexBusy] = useState(false);
  const guarded = dirty || importBusy || exportBusy || indexBusy;
  useEffect(() => { onDirtyChange(guarded); }, [guarded, onDirtyChange]);
  useEffect(() => { if (!guarded) return; const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent); }, [guarded]);
  const saved = useCallback((r: SettingsRecord) => { client.setQueryData(['system-settings'], r); void client.invalidateQueries({ queryKey: ['activity'] }); }, [client]);
  const completed = useCallback(() => { for (const key of ['bins', 'trash-bins', 'collections', 'schemas', 'activity', 'system-info', 'search', 'search-index']) void client.invalidateQueries({ queryKey: [key] }); }, [client]);
  return <section className="settings-page"><header className="hero bins-hero"><div><span className="eyebrow">系统管理</span><h1>设置</h1><p>检查状态，设置新建默认值，导入 JSON 或迁移业务备份。</p></div></header>
    <section className="panel system-info-panel"><h2>系统信息</h2><button className="secondary-button" disabled={info.isFetching} onClick={() => void info.refetch()}>刷新系统信息</button>
      {info.isPending && <p role="status">正在加载系统信息…</p>}{info.isError && <p className="detail-error" role="alert">{info.error.message}<button className="secondary-button" onClick={() => void info.refetch()}>重试系统信息</button></p>}
      {info.data && <><dl className="system-statistics"><div><dt>版本</dt><dd>{info.data.version}</dd></div><div><dt>Worker</dt><dd>{info.data.runtime} · 接口响应正常</dd></div><div><dt>R2</dt><dd>{probes[info.data.storage.r2]}</dd></div><div><dt>KV</dt><dd>{probes[info.data.storage.kv]}</dd></div><div><dt>GitHub OAuth</dt><dd>{info.data.oauth.githubConfigured ? '已配置' : '未配置'}</dd></div><div><dt>检测时间</dt><dd>{new Date(info.data.checkedAt).toLocaleString('zh-CN')}</dd></div></dl>
        <p>此处是只读探测；写入权限、OAuth 登录和定时任务需另外验收。</p>{info.data.statistics.status === 'available' ? <dl className="system-statistics">{Object.entries(info.data.statistics.data).map(([key, value]) => <div key={key}><dt>{statsLabels[key as keyof typeof statsLabels]}</dt><dd>{value.toLocaleString('zh-CN')}</dd></div>)}</dl> : <p role="status">统计暂不可用：{info.data.statistics.error === 'statistics_limit_exceeded' ? '超出扫描上限（10000 对象 / 500 元数据）' : '存储读取失败'}。可稍后刷新。</p>}
        <p>未完成恢复保持隐藏，不自动清理；使用相同备份可继续，关联已修改时请迁移到空实例。</p></>}
    </section>
    <SearchIndexPanel onBusyChange={setIndexBusy} />
    {settings.isPending && <p role="status">正在读取默认设置…</p>}{settings.isError && <p className="detail-error" role="alert">{settings.error.message}<button className="secondary-button" onClick={() => void settings.refetch()}>重试默认设置</button></p>}
    {settings.data && <DefaultsForm record={settings.data} onSaved={saved} onDirtyChange={setDirty} />}
    <ImportPanel client={systemApi} onBusyChange={setImportBusy} onCompleted={completed} /><ExportPanel client={systemApi} onBusyChange={setExportBusy} />
  </section>;
}
