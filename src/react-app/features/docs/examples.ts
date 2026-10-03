import type { DocOperation, ExampleContext, ExampleRequest, ExampleLanguage } from './types.ts';
export function encodeValuePath(segments: readonly string[]): string {
  return segments.map(s => '/' + encodeURIComponent(s.replaceAll('~','~0').replaceAll('/','~1'))).join('');
}
export function buildRequest(operation: DocOperation, context: ExampleContext): ExampleRequest {
  const ids: Record<string,string> = { binId: context.binId ?? '11111111-1111-4111-8111-111111111111',
    collectionId: context.collectionId ?? '22222222-2222-4222-8222-222222222222', schemaId: context.schemaId ?? '33333333-3333-4333-8333-333333333333',
    keyId: context.keyId ?? '44444444-4444-4444-8444-444444444444', version: String(context.version ?? 1) };
  const path = operation.path.replace(/\{(binId|collectionId|schemaId|keyId|version)\}/g, (_, key: string) => encodeURIComponent(ids[key]))
    .replace('{path}', encodeValuePath(context.pathSegments ?? ['settings','theme']));
  const headers: Record<string,string> = {};
  if (operation.auth === 'resource' && !(context.anonymous && operation.publicRead)) headers.Authorization = 'Bearer <API_TOKEN>';
  if (operation.etag !== 'none') headers['If-Match'] = context.etag ?? '"<ETAG>"';
  const request: ExampleRequest = { method: operation.method, url: new URL(context.origin).origin + path, headers };
  if (operation.auth === 'session' || operation.id === 'auth-login') request.credentials = 'include';
  if (Object.hasOwn(operation, 'body')) {
    request.body = structuredClone(operation.body);
    if (operation.id === 'trash-batch') request.body = {items:[{id:ids.binId,etag:context.etag ?? '"<ETAG>"'}]};
    headers['Content-Type'] = operation.id === 'bin-patch' ? 'application/merge-patch+json' : 'application/json';
  }
  return request;
}
const q = JSON.stringify;
const shell = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
export function renderExample(language: ExampleLanguage, request: ExampleRequest): string {
  const hasBody = Object.hasOwn(request,'body');
  if (language === 'curl') {
    const args = ['curl --fail-with-body -i', '-X '+request.method, ...(request.credentials ? ['-b cookies.txt -c cookies.txt'] : []),
      ...Object.entries(request.headers).map(([k,v]) => '-H '+shell(k+': '+v)), ...(hasBody ? ['--data-raw '+shell(q(request.body))] : []), shell(request.url)];
    return args.join(' \\\n  ');
  }
  if (language === 'javascript') {
    return `const response = await fetch(${q(request.url)}, {\n  method: ${q(request.method)},\n  headers: ${q(request.headers)},${request.credentials ? '\n  credentials: "include",' : ''}${hasBody ? '\n  body: JSON.stringify('+q(request.body)+'),' : ''}\n});\nif (!response.ok) throw new Error(\`HTTP \${response.status}: \${await response.text()}\`);\nconsole.log(await response.json());`;
  }
  const login = request.credentials && new URL(request.url).pathname.endsWith('/auth/login');
  return `import requests\n${login ? '\nsession = requests.Session()\n' : request.credentials ? '\n# 复用登录示例建立的 session，不要重新创建。\n' : ''}\nresponse = ${request.credentials ? 'session' : 'requests'}.request(\n    ${q(request.method)}, ${q(request.url)},\n    headers=${q(request.headers)},${hasBody ? '\n    data='+q(q(request.body))+',' : ''}\n    timeout=30,\n)\nresponse.raise_for_status()\nprint(response.json())`;
}
