# P12 稳定性、安全与发布验收设计

日期：2026-10-04（Asia/Shanghai）。基线：main `9cbfeee`，P11 功能交付 `8b12d9e`。

## 范围与发布边界

复用已有 API、R2、ETag、Scope、Schema、回收站和备份回归，补齐实际发现的安全边界。P12 不新增业务功能或自动删除规则。生产功能验收、真实 Cron 和 OAuth 仍是 stable 发布的前置条件；无生产 URL/凭据时保持 `3.0.0-alpha.4`，不能用本地测试或 Workers Builds success 代替这些证据。

## 认证与来源

- Session 签名和 14 天 TTL 保留。解析限制 4096 字符，只接受两个规范 base64url 段、43 字符 HMAC-SHA256 签名、有效 UTF-8 JSON、非空有限长度身份、已知 provider 和未到期整数 exp。畸形/篡改/额外段/过期 Cookie 返回未认证；不触发 500。
- SESSION_SECRET 少于 32 字符时禁用登录配置；读 Session 未认证，签发入口返回 503。更换 Secret 使旧 Cookie 失效。
- 登录比较固定长度摘要；实际读取正文最多 4 KiB，不信任 Content-Length。OAuth 在请求上游前验证 state，在签发前验证 numeric id 和 login；上游失败不暴露异常内容。
- CORS 与 Session 写入共用来源规则：未配置 APP_ORIGIN 时使用请求 URL 的 Origin；显式配置必须是规范 http(s) Origin，不能有凭据、路径、query、hash、末尾斜杠或通配符。foreign/null Origin 无 Access-Control-Allow-Origin，登录/退出/Session 写入返回 403。
- 无 Origin 的脚本仍可认证；Bearer Scope/显式 Authorization 优先规则不变。CORS 不能代替认证或 Scope。

## 响应与日志

- 所有 `/api/*` 响应 no-store，含失败和预检；提供服务端 UUID X-Request-ID 关联日志。JSON API 设置禁止资源加载/嵌入的 CSP、DENY、nosniff 和 Permissions-Policy。
- Cloudflare Assets 不经过 API 中间件，使用 `public/_headers`。脚本只允许 self，禁止 eval、frame/object 和外部连接；Monaco 需要 self/blob worker 和 inline style，保留该两项最小例外。原生静态路由及真实 Chromium 生产构建验证 CSP，不能只断言开发服务器或文件文本。
- 前端入口在构造共享 Schema 之前启用 Zod `jitless`，避免其 Function 能力探测触发 CSP violation；校验使用解释执行，不开放 unsafe-eval。
- 通用错误只记录固定事件、method 和 requestId，不记录 Error.message、URL/path、body 或 credentials。测试用异常和路径 canary 验证。Cloudflare 平台访问日志的保留与权限需单独配置，应用日志策略不能保证平台本身不记录 URL。

## 验收与运维

- 新增安全回归覆盖 Cookie 格式/签名/身份/过期/轮换、Origin、CORS 预检与配置、登录正文上限、OAuth state/上游、全局响应头和日志隐私。
- 生产构建浏览器验证中文登录、Monaco 编辑并保存、刷新、390px 手机深色模式、退出及无 CSP violation/pageerror。
- 备份权威来源为 R2；KV 可丢弃并重建。业务导出有数量/字节上限，不能替代超限仓库的完整 R2 备份。迁移先恢复隔离的新实例、验证后再切换，不覆盖原实例。
- 提供公开接口的 `check:production` 探针与独立生产验收清单；生产登录/写入/OAuth/真实 Cron 需要实际授权凭据和运行证据。
