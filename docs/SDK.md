# JSONBin SDK 指南

JSONBin 提供官方 TypeScript 与 Python SDK，统一封装认证、ETag 条件写入、JSON Patch、分页、错误映射与限流处理。

SDK **只通过 JSONBin HTTP API 与服务器通信**，不直接访问 R2/KV，因此权限、Scope、Resource Access、Rate Limit、锁与 Schema 校验全部由服务器权威裁决。

---

## 1. 目录结构

```text
sdk/
  typescript/    @jsonbin/client
  python/        jsonbin-client
```

SDK 与前端 Dashboard 的内部 API Client 完全解耦，可独立发布。

---

## 2. TypeScript SDK

### 2.1 构建

```bash
cd sdk/typescript
npm install        # 无运行时依赖
npm run build      # 产物输出到 dist/
```

### 2.2 初始化

```ts
import { JsonBin } from "@jsonbin/client";

const client = new JsonBin({
  baseUrl: "https://js.example.com",
  token: process.env.JSONBIN_TOKEN!,
  timeoutMs: 30_000,
});
```

### 2.3 读取

```ts
// 明确区分 ID 与 Slug，避免不可预测的魔法判断
const byId = await client.bins.getById(id);
const bySlug = await client.bins.getBySlug("cloudflare-config");
const published = await client.bins.getPublished("cloudflare-config");
```

`get` 会按 UUID 格式自动分派到 `/bins/:id` 或 `/b/:slug`；生产自动化推荐使用 `getPublished`。

### 2.4 写入（必须携带 ETag）

```ts
// 全量替换
await client.bins.update(id, { port: 8080 }, { etag: bin.etag });

// RFC 7396 Merge Patch
await client.bins.mergePatch(id, { successRate: 80 }, { etag: bin.etag });

// RFC 6902 JSON Patch
await client.bins.jsonPatch(
  id,
  [
    { op: "test", path: "/successRate", value: 90 },
    { op: "replace", path: "/successRate", value: 80 },
  ],
  { etag: bin.etag },
);
```

### 2.5 发布与回滚

```ts
await client.bins.publish(id, { version: 12, etag });
await client.bins.rollback(id, { version: 7, etag });
await client.bins.clone(id, { etag });
```

---

## 3. Python SDK

### 3.1 安装

```bash
pip install jsonbin-client
```

零第三方依赖，仅使用标准库。

### 3.2 使用

```python
from jsonbin_client import JsonBin, EtagConflictError, RateLimitError

client = JsonBin(base_url="https://js.example.com", token=TOKEN)

bin = client.bins.create(name="App Config", value={"debug": True})

# RFC 6902
client.bins.json_patch(
    bin["meta"]["id"],
    [{"op": "replace", "path": "/debug", "value": False}],
    etag=bin["etag"],
)

# RFC 7396
client.bins.merge_patch(bin["meta"]["id"], {"port": 8080}, etag=bin["etag"])
```

---

## 4. 错误模型

SDK 不会把 HTTP 状态码直接抛给调用方，而是映射为统一异常层级：

```text
JsonBinError
├── AuthenticationError        401
├── PermissionDeniedError      403
├── NotFoundError              404
├── ConflictError              409
├── EtagConflictError          412
├── ValidationError            422
├── LockedError                423
├── PreconditionRequiredError  428
├── RateLimitError             429（附带 retryAfter / retry_after）
└── ServerError                5xx
```

TypeScript：

```ts
try {
  await client.bins.jsonPatch(id, ops, { etag });
} catch (error) {
  if (error instanceof RateLimitError) console.log(error.retryAfter);
  if (error instanceof EtagConflictError) await refresh();
}
```

Python：

```python
except RateLimitError as exc:
    time.sleep(exc.retry_after)
```

---

## 5. 关键语义

### 5.1 ETag 原样保留

SDK 保留服务器返回的原始 ETag 格式（含引号），不做任何去除或归一化：

```ts
{ value: {...}, etag: '"abc123"' }
```

### 5.2 304 Not Modified

```ts
const result = await client.bins.get(idOrSlug, { ifNoneMatch: cachedEtag });
if ("modified" in result && result.modified === false) {
  // 使用本地缓存，SDK 不会对空 304 响应体做 JSON 解析
}
```

### 5.3 不做隐式重试

SDK **不会**自动重试写请求（`PUT` / `PATCH` / `publish` / `rollback`），避免调用方不知情的情况下重复提交。调用方需自行根据 `RateLimitError.retryAfter` 决定策略。

### 5.4 Token 安全

- Token 仅写入 `Authorization: Bearer` 请求头；
- 不打印 Token、Cookie、Secret，错误信息不包含凭据。

---

## 6. 测试

```bash
node --test tests/sdk-ts.test.mjs
```

集成测试启动真实 Miniflare Worker，覆盖 create / get / 304 / JSON Patch / Merge Patch / publish / published read 以及 404 与 412 错误映射。
