import type { DocOperation,ExampleContext,ExampleLanguage } from './types';
import { buildRequest,renderExample } from './examples';
import { CodeExample } from './CodeExample';
const etagText={none:'无需 If-Match',optional:'建议携带 If-Match（允许省略）',required:'必须携带 If-Match',conditional:'locked/expiresAt 必须携带 If-Match；其他元数据建议携带'};
export function OperationDoc({operation,context,language}:{operation:DocOperation;context:ExampleContext;language:ExampleLanguage}) {
  const request=buildRequest(operation,context);
  return <article className="doc-operation" id={'operation-'+operation.id}>
    <h3>{operation.title}</h3><p className="doc-method"><strong>{operation.method}</strong> <code>{operation.path}</code></p>
    <p>认证：{operation.auth==='session'?'管理 Session；不要发送 Authorization':operation.auth==='none'?'无需认证':operation.publicRead?'公开当前读取可匿名；私有读取需 Session 或 API Key':'Session 或 API Key'}
      {operation.scopes.length>0 && <>。Scope：<code>{operation.scopes.join(' + ')}</code></>}</p>
    <p>{etagText[operation.etag]}。</p><p>{operation.requestFields}</p>
    {operation.description && <p>{operation.description}</p>}
    <p>成功：HTTP {operation.successStatus} · <code>{operation.responseShape}</code></p>
    {operation.id==='auth-github'?<a href={request.url} target="_blank" rel="noopener noreferrer">在浏览器打开 GitHub 登录入口</a>:
      <CodeExample label={operation.title} language={language} code={renderExample(language,request)}/>}
  </article>;
}
