import {useState} from 'react';
import { DOC_SECTIONS,DOC_OPERATIONS,DOC_ERRORS,DOC_SCOPES } from './catalog';
import { buildQuickStart, buildRequest, renderExample } from './examples';
import type {ExampleLanguage} from './types';
import { CodeExample } from './CodeExample';
import { OperationDoc } from './OperationDoc';
export function LanguageSelect({value,onChange}:{value:ExampleLanguage;onChange:(value:ExampleLanguage)=>void}) {
  return <label className="doc-language">示例语言<select aria-label="示例语言" value={value} onChange={e=>onChange(e.target.value as ExampleLanguage)}>
    <option value="curl">curl（Bash）</option><option value="javascript">JavaScript fetch</option><option value="python">Python requests</option></select></label>;
}
export function DocsPage() {
  const [language,setLanguage]=useState<ExampleLanguage>('curl');const origin=window.location.origin;
  return <section className="docs-page">
    <header className="resource-heading"><div><span className="eyebrow">开发者</span><h1>API 文档</h1><p>当前部署的调用方式、权限与可复制示例。</p><code>{origin}/api/v1</code></div><LanguageSelect value={language} onChange={setLanguage}/></header>
    <p className="doc-note">示例使用演示数据。请替换 Token、资源 UUID、ETag 和登录占位符；每次写入前重新读取最新 ETag。页面不会执行示例请求。</p>
    <div className="docs-layout"><nav className="doc-toc panel" aria-label="文档目录">{DOC_SECTIONS.map(s=><button type="button" key={s.id} onClick={()=>document.getElementById('docs-'+s.id)?.scrollIntoView({block:'start'})}>{s.title}</button>)}</nav>
      <div className="docs-content">{DOC_SECTIONS.map(section=><section className="panel doc-section" id={'docs-'+section.id} key={section.id} aria-labelledby={'docs-title-'+section.id}>
        <h2 id={'docs-title-'+section.id}>{section.title}</h2>{section.introduction.map(text=><p key={text}>{text}</p>)}
        {section.id==='keys' && <div className="doc-scopes">{DOC_SCOPES.map(scope=><code key={scope}>{scope}</code>)}</div>}
        {section.id==='etag' && <CodeExample label="顺序入门示例" language={language} code={buildQuickStart(language,origin)}/>}
        {section.id==='paths' && <CodeExample label="特殊字段名路径示例" language={language} code={renderExample(language,buildRequest(DOC_OPERATIONS.find(op=>op.id==='bin-path-get')!,{origin,pathSegments:['a/b','x~y','中文 %']}))}/>}
        {DOC_OPERATIONS.filter(op=>op.sectionId===section.id).map(operation=><OperationDoc key={operation.id} operation={operation} context={{origin}} language={language}/>)}
        {section.id==='errors' && <div className="doc-errors">{DOC_ERRORS.map(error=><article key={error.status}><h3>HTTP {error.status}</h3><code>{error.code}</code><p>{error.meaning}</p><p>{error.recovery}</p></article>)}</div>}
      </section>)}</div></div>
  </section>;
}
