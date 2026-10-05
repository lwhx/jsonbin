import {useState, useEffect} from 'react';
import { DOC_SECTIONS,DOC_OPERATIONS,DOC_ERRORS,DOC_SCOPES } from './catalog';
import { buildQuickStart, buildRequest, renderExample } from './examples';
import type {ExampleLanguage} from './types';
import { CodeExample } from './CodeExample';
import { OperationDoc } from './OperationDoc';
import { ApiDebugger } from './ApiDebugger';
export function LanguageSelect({value,onChange}:{value:ExampleLanguage;onChange:(value:ExampleLanguage)=>void}) {
  return <label className="doc-language">示例语言<select aria-label="示例语言" value={value} onChange={e=>onChange(e.target.value as ExampleLanguage)}>
    <option value="curl">curl（Bash）</option><option value="javascript">JavaScript fetch</option><option value="python">Python requests</option></select></label>;
}
export function DocsPage() {
  const [activeTab, setActiveTab] = useState<"docs" | "debugger" | "openapi">("docs");
  const [language, setLanguage] = useState<ExampleLanguage>("curl");
  const [openApiSpec, setOpenApiSpec] = useState<string>("");
  const origin = window.location.origin;

  useEffect(() => {
    if (activeTab === "openapi" && !openApiSpec) {
      fetch("/api/v1/openapi.json")
        .then((r) => r.json())
        .then((data) => setOpenApiSpec(JSON.stringify(data, null, 2)))
        .catch(() => setOpenApiSpec("无法加载 OpenAPI 规范。"));
    }
  }, [activeTab, openApiSpec]);

  return (
    <section className="docs-page">
      <header className="resource-heading">
        <div>
          <span className="eyebrow">开发者</span>
          <h1>API 文档与工具</h1>
          <p>当前部署的调用方式、权限、在线调试与 OpenAPI 3.1 规范。</p>
          <code>{origin}/api/v1</code>
        </div>
        {activeTab === "docs" && <LanguageSelect value={language} onChange={setLanguage} />}
      </header>

      <div style={{ display: "flex", gap: "10px", margin: "16px 0" }}>
        <button
          type="button"
          className={`secondary-button ${activeTab === "docs" ? "active" : ""}`}
          style={activeTab === "docs" ? { borderColor: "var(--accent)", color: "var(--accent-text)" } : {}}
          onClick={() => setActiveTab("docs")}
        >
          接口文档
        </button>
        <button
          type="button"
          className={`secondary-button ${activeTab === "debugger" ? "active" : ""}`}
          style={activeTab === "debugger" ? { borderColor: "var(--accent)", color: "var(--accent-text)" } : {}}
          onClick={() => setActiveTab("debugger")}
        >
          在线调试
        </button>
        <button
          type="button"
          className={`secondary-button ${activeTab === "openapi" ? "active" : ""}`}
          style={activeTab === "openapi" ? { borderColor: "var(--accent)", color: "var(--accent-text)" } : {}}
          onClick={() => setActiveTab("openapi")}
        >
          OpenAPI 3.1
        </button>
      </div>

      {activeTab === "debugger" ? (
        <ApiDebugger />
      ) : activeTab === "openapi" ? (
        <div className="panel" style={{ padding: "20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
            <h2 style={{ margin: 0 }}>OpenAPI 3.1.0 规范定义</h2>
            <a
              href="/api/v1/openapi.json"
              target="_blank"
              rel="noreferrer"
              className="secondary-button"
              style={{ padding: "6px 12px", textDecoration: "none" }}
            >
              在新标签页打开原始 JSON
            </a>
          </div>
          <pre style={{ padding: "16px", background: "var(--border)", borderRadius: "6px", fontSize: "12px", overflow: "auto", maxHeight: "650px" }}>
            {openApiSpec || "正在加载 OpenAPI 规范…"}
          </pre>
        </div>
      ) : (
        <>
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
        </>
      )}
    </section>
  );
}
