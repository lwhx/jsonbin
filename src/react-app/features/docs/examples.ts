import { DOC_OPERATIONS } from './catalog.ts';
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

export function buildQuickStart(language: ExampleLanguage, origin: string): string {
  const described = (id: string) => buildRequest(DOC_OPERATIONS.find(op => op.id === id)!, {origin});
  const base = described('bin-create').url;
  const create = described('bin-create').body, patch = described('bin-patch').body, replacement = described('bin-path-put').body;
  if (language === 'javascript') return `const token = "<API_TOKEN>";\nasync function request(method, url, body, etag) {\n  const response = await fetch(url, {\n    method, headers: {Authorization: \`Bearer \${token}\`, ...(body === undefined ? {} : {"Content-Type": method === "PATCH" ? "application/merge-patch+json" : "application/json"}), ...(etag ? {"If-Match": etag} : {}),},\n    ...(body === undefined ? {} : {body: JSON.stringify(body)}),\n  });\n  if (!response.ok) throw new Error(\`HTTP \${response.status}: \${await response.text()}\`);\n  return {data: await response.json(), etag: response.headers.get("ETag")};\n}\nconst created = await request("POST", ${q(base)}, ${q(create)});\nconst url = ${q(base)} + "/" + encodeURIComponent(created.data.meta.id);\nlet snapshot = await request("GET", url);\nawait request("PATCH", url, ${q(patch)}, snapshot.etag);\nsnapshot = await request("GET", url);\nawait request("PUT", url + "/value/settings/theme", ${q(replacement)}, snapshot.etag);\nconsole.log((await request("GET", url)).data);`;
  if (language === 'curl') return `# 需要 Bash、curl 和 Python 3；仅创建/修改演示 Bin。\nset -euo pipefail\ntoken='<API_TOKEN>'\nbase=${shell(base)}\nheaders_file=$(mktemp)\ntrap 'rm -f "$headers_file"' EXIT\nrequest() { curl --fail-with-body -sS -D "$headers_file" -H "Authorization: Bearer $token" "$@"; }\nread_etag() { python3 -c 'import sys; print(next(line.split(":",1)[1].strip() for line in open(sys.argv[1]) if line.lower().startswith("etag:")))' "$headers_file"; }\ncreated=$(request -X POST "$base" -H 'Content-Type: application/json' --data-raw ${shell(q(create))})\nid=$(printf '%s' "$created" | python3 -c 'import sys,json; print(json.load(sys.stdin)["meta"]["id"])')\nurl="$base/$id"\nrequest "$url" > /dev/null\netag=$(read_etag)\nrequest -X PATCH "$url" -H 'Content-Type: application/merge-patch+json' -H "If-Match: $etag" --data-raw ${shell(q(patch))} > /dev/null\nrequest "$url" > /dev/null\netag=$(read_etag)\nrequest -X PUT "$url/value/settings/theme" -H 'Content-Type: application/json' -H "If-Match: $etag" --data-raw ${shell(q(replacement))} > /dev/null\nrequest "$url"`;
  return `import requests\nfrom urllib.parse import quote\ntoken = "<API_TOKEN>"\ndef request(method, url, data=None, etag=None):\n    headers = {"Authorization": "Bearer " + token}\n    if data is not None: headers["Content-Type"] = "application/merge-patch+json" if method == "PATCH" else "application/json"\n    if etag is not None: headers["If-Match"] = etag\n    response = requests.request(method, url, headers=headers, data=data, timeout=30)\n    response.raise_for_status()\n    return response\ncreated = request("POST", ${q(base)}, ${q(q(create))}).json()\nurl = ${q(base)} + "/" + quote(created["meta"]["id"], safe="")\nsnapshot = request("GET", url)\nrequest("PATCH", url, ${q(q(patch))}, snapshot.headers["ETag"])\nsnapshot = request("GET", url)\nrequest("PUT", url + "/value/settings/theme", ${q(q(replacement))}, snapshot.headers["ETag"])\nprint(request("GET", url).json())`;
}
