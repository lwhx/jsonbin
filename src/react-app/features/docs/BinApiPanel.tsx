import {useState} from 'react';
import type {ExampleLanguage} from './types';
import {DOC_OPERATIONS} from './catalog';
import {OperationDoc} from './OperationDoc';
import {LanguageSelect} from './DocsPage';
const operations=['bin-get','bin-put','bin-patch','bin-path-get','bin-path-put','bin-meta','bin-delete','history-list','history-get','history-restore'];
export function BinApiPanel({bin}:{bin:{id:string;etag:string;visibility:'private'|'public';locked:boolean;expiresAt:string|null}}) {
  const[language,setLanguage]=useState<ExampleLanguage>('curl');
  const context={origin:window.location.origin,binId:bin.id,etag:bin.etag,anonymous:bin.visibility==='public'};
  return <div className="bin-api">
    <div className="code-toolbar"><h2>此数据仓的 API</h2><LanguageSelect value={language} onChange={setLanguage}/></div>
    <p>{bin.visibility==='public'?'此数据仓已公开：任何持有 API 地址的人都能匿名读取当前内容及元数据。列表、历史版本和写入仍需认证。':'此数据仓为私有：所有读取都需要 Session 或对应 Scope 的 API 密钥。'}</p>
    <p>已保存的 ETag：<code>{bin.etag}</code>。本页只使用演示 JSON，不读取已存内容或未保存草稿。每次独立写入重新 GET 并携带最新 ETag；不要连续复用此快照值。</p>
    <p>Token 使用 &lt;API_TOKEN&gt; 占位符，请替换为所需 Scope 的 API 密钥。查看与复制不会执行请求；演示写入会修改真实数据仓，请先确认演示内容符合你的需求及绑定模型。</p>
    <p>Merge Patch 使用 application/merge-patch+json，null 删除对象字段、数组整体替换。路径 /value/settings/theme 仅适用于已存在 settings 父节点的 JSON；路径先做 JSON Pointer 转义，再逐段 URL 编码。数组从 0 开始，最终 - 可追加；/value 读写根 JSON。</p>
    {bin.locked && <p className="doc-note">数据仓已锁定：修改和删除返回 423；读取仍可用。</p>}
    {bin.expiresAt && <p className="doc-note">已设置到期时间：{new Date(bin.expiresAt).toLocaleString('zh-CN')}。到期后普通读写停止，请从回收站查看或恢复。</p>}
    {operations.map(id=><OperationDoc key={id} operation={DOC_OPERATIONS.find(op=>op.id===id)!} context={context} language={language}/>)}
  </div>;
}
