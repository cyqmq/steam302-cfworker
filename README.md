# steam302-cfworker

基于 [steam302-worker](https://github.com/cyqmq/steam302-worker) 精简重构的 Cloudflare Worker 加速项目。**无需任何 Fallback 节点**，Worker 独立完成 GitHub 全站加速与 Steam 部分资源加速，通过 same-host 模式直连源站。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cyqmq/steam302-cfworker)

---

## 目录

- [特性](#特性)
- [架构](#架构)
- [目录结构](#目录结构)
- [部署](#部署)
- [配置](#配置)
- [健康检查与故障转移](#健康检查与故障转移)
- [scripts 脚本](#scripts-脚本)
- [安全与 ACL](#安全与-acl)

---

## 特性

- **GitHub 全站加速**：same-host 直连代理 GitHub 网页、API、Raw 文件、Release/downloads、头像、assets（42 个域名含 `*.github.io` 通配）
- **Steam 加速 + 登录**：代理 `steamcommunity.com`、`store.steampowered.com`、`cdn.cloudflare.steamstatic.com`；默认 Googlebot UA；**内置 stealth 模式**（基于 `cloudflare:sockets` 底层 TCP，伪装掉 Workers 自动注入的 `cf-worker` 头），让 Steam OpenID 登录不再返回 403
- **mod.io 模组加速**：镜像 `m0di0.steam302.xyz` 分工，覆盖 `mod.io` / `api.mod.io` 等域名
- **Host 路由**：按请求 Host 头分发到对应源站，Worker 即为反向代理入口
- **边缘缓存**：静态资源强缓存（图片/CSS/JS/字体）+ 可选 API 微缓存，CDN 层面分担源站压力
- **健康检查与故障转移**：定时探测各源站，连续失败自动降权冷却；支持配置替代直连上游
- **302 链跟随**：自动跟踪 asset 跳转（最多 8 跳），无需浏览器二次解析
- **无任何 Fallback**：不依赖公共节点或自建隧道，Worker 单点直连

---

## 架构

```
hosts 劫持 / Caddy / 直接访问
        │
        ▼
Cloudflare Worker (acc.example.com)
        │  matchRoute(host)
        ▼
   ┌─────────┐  ┌──────────┐  ┌──────────────┐
   │ GitHub   │  │ upstreams │  │   Steam 静态  │
   │ 全站(42域)│  │ (可选)IP/DNS│  │ (3 组域名)    │
   └─────────┘  └──────────┘  └──────────────┘
        │               │
        ▼               ▼
  github.com...     steamcommunity.com...
  (same-host 直连源站)
```

一切请求均以 `Host = 源站域名` 直连源站；失败时按健康记录降权排序，可回落到配置的替代上游，最终全部失败则返回 502。

---

## 目录结构

```
steam302-cfworker/
├── src/
│   ├── worker.js        # 入口：路由匹配、ACL、OPTIONS 预检、scheduled、/__flush-cache
│   ├── router.js        # matchRoute（最长后缀匹配）+ 内置默认 manifest
│   ├── config.js        # 读取 KV manifest > env MANIFEST > 内置默认（30s 缓存）
│   ├── proxy.js         # 候选排序、请求发送、健康降权、302 递归跟随、缓存接入
│   ├── stealth.js       # stealth 请求（cloudflare:sockets TCP，无 cf-worker 头）
│   ├── h1.js            # HTTP/1.1 响应解析（chunked、Content-Length、gzip/br 解码）
│   ├── cache.js         # 缓存策略（静态强缓存 + API 微缓存）
│   ├── health.js        # 双写（KV + isolate 内存）健康状态、定时探测
│   └── util.js          # UA、asset/heavy host 列表、hash
├── scripts/
│   ├── gen_manifest.py / .sh   # 从 steam302-web config/rules/*.json 生成 manifest
│   └── push-manifest.sh       # 推送 manifest 到 KV（30s 内生效，无需重新部署）
├── wrangler.toml              # Cloudflare Worker 配置
├── manifest.example.json      # 完整 manifest 示例
└── README.md
```

---

## 部署

### 方式 A：Fork 后手动部署（说明）

Fork 本仓库到自己的 GitHub，clone 到本地后按「方式 C/方式 D」执行即可。仓库内不含任何 CI
配置，部署动作全部由你自己掌握：

1. Fork → clone
2. 准备 Cloudflare 凭据：`CLOUDFLARE_API_TOKEN`（Token 需 `Workers Scripts: Edit`、
   `Workers KV Storage: Edit` 权限）与 `CLOUDFLARE_ACCOUNT_ID`（Dashboard 右侧栏）
3. 跑「方式 C」脚本或按「方式 D」手工步骤
4. 部署完成后到 Cloudflare 面板给 Worker 加自定义域（`workers.dev` 大陆被墙）

### 方式 B：一键按钮（Pages 精简版）

上面的 Deploy 按钮会把仓库作为 Cloudflare **Pages** 部署，功能受限：

- ⚠️ Pages 不支持 `scheduled`（健康检查巡检/缓存预热 cron 不触发）
- KV 命名空间需在部署后手动到 Pages → Settings → Bindings 补 `ROUTES`、`HEALTH_KV` 两个 KV 绑定
- Analytics Engine 同理手动绑定

适合快速试水；要完整能力（cron/健康检查/stealth 全量）请用方式 A/C/D 部署到 Workers。

### 方式 C：本地一键脚本

**先手动创建并绑定 KV**（见「方式 D」步骤 1，脚本不会自动创建），然后：

```bash
export CLOUDFLARE_API_TOKEN=xxx
export CLOUDFLARE_ACCOUNT_ID=xxx
# 可选：export KV_ROUTES_ID=<ROUTES 命名空间 id>   （wrangler.toml 已填好则不用）
# 可选：export KV_HEALTH_KV_ID=<HEALTH_KV 命名空间 id>
# 可选：export MANIFEST='{"version":1,"routes":[...]}'
# 可选：export CF_DOMAIN=acc.example.com
bash scripts/deploy.sh
```

只做：注入 KV id（若给了）→ 可选 MANIFEST / 自定义域 → `wrangler deploy`。

### 方式 D：手工（老步骤）

### 1. 创建并绑定 KV 命名空间

本项目用两个 KV 命名空间：`ROUTES`（路由表 manifest）与 `HEALTH_KV`（上游健康状态）。

CLI 创建（会打印 id）：

```bash
wrangler kv namespace create ROUTES     # 记下返回的 id
wrangler kv namespace create HEALTH_KV  # 记下返回的 id
```

或 Cloudflare 面板：**Workers & Pages → KV → Create namespace**，填入标题 `ROUTES` / `HEALTH_KV`，创建后点进命名空间复制其 ID。

然后把 id 填进 `wrangler.toml` 的 `kv_namespaces`（没有 id 值时用占位符会部署失败）：

```toml
kv_namespaces = [
  { binding = "ROUTES",   id = "上一步的 ROUTES id" },
  { binding = "HEALTH_KV", id = "上一步的 HEALTH_KV id" },
]
```

部署后也可在面板检查：**Workers → 你的 Worker → Settings → Variables → KV namespace bindings**。

### 2. 绑定自定义域名

```bash
wrangler routes create acc.example.com
```

`workers.dev` 在大陆被墙，**必须使用自定义域**。

### 3. 上传 manifest（可选）

```bash
bash scripts/push-manifest.sh manifest.json
```

### 4. 部署

```bash
wrangler deploy
```

---

## 配置

内置默认 manifest 已覆盖 GitHub 全站 + Steam 常用域名，可直接部署。需要增删域名时用 KV manifest 覆盖（30s 内生效）。

```jsonc
{
  "version": 1,
  "failover": {
    "timeout_ms": 6000,    // 单上游超时
    "max_fails": 2,        // 连续失败次数，达到后进入冷却
    "cooldown_s": 45       // 冷却时间，期间该上游降权
  },
  "routes": [
    {
      "id": "github",
      "group": "github",
      "name": "GitHub 加速",
      "mode": "same-host",        // same-host = 直连源站
      "hosts": ["github.com", "*.github.io"],
      "ua": null,                  // null = Chrome 默认 UA
      "upstreams": ["https://alt.origin.example.com"],  // 可选：替代直连目标
      "cache": { "static_ms": 604800000 }              // 静态资源缓存 TTL（毫秒）
    },
    {
      "id": "steam",
      "mode": "same-host",
      "hosts": ["steamcommunity.com", "cdn.cloudflare.steamstatic.com"],
      "ua": "Googlebot/2.1 (+http://www.google.com/bot.html)",
      "upstreams": [],
      "stealth": true,             // 开启 stealth 模式（无 cf-worker 头，支持登录）
      "cache": { "static_ms": 86400000, "micro_ms": 10000 }
    }
  ]
}
```

`upstreams` 可填入多个替代直连目标（如其它地区 IP/域名镜像）。请求时的候选顺序：

1. 主源站（same-host 的 `Host` 目标）
2. `upstreams`（按配置顺序）
3. 冷却中的候选自动降权到队尾；全部失败返回 502

### stealth 模式（Steam 登录）

Cloudflare Workers 向源站发起 fetch 时会自动注入 `cf-worker: <域名>` 头；Steam 的
OpenID 端点在检测到该头时直接返回 403，导致登录失败。

`stealth: true` 的路由改用 `cloudflare:sockets` 底层 TCP + TLS 直连（HTTP/1.1，
`Connection: close`），**不经过自动注入头**，从而绕过 Steam 的封锁。实现失败时自动回退
到原生 fetch，不影响可用性。大文件/下载类域名（github-releases、steamstatic CDN 等
`heavy host`）保持在原生 fetch 链路，避免整包缓冲内存开销。

#### SNI 显式控制（`sni` 字段）

TLS 握手由 `src/stealth.js` 手动完成（`socket.startTls()`），`serverName` 可完全自定义：

- 默认 = 目标 URL 的 hostname（`steamcommunity.com` 等）
- 通过路由级 `"sni": "xxx.example.com"` 覆盖，可以对**任意 IP/域名**连接时伪装成指定 SNI

一个典型应用：`connect()` 可以连接裸 IP，而 SNI 仍填真实域名——即"连 IP、报域名"，
在原生 fetch 被 Cloudflare 禁止访问裸 IP 的情况下，这是直连 IP 池唯一可行的通道。

> ⚠️ SNI 能否稳定通过 Steam 的 Akamai 边缘校验（证书链域名必须匹配 SNI 且源站要接受），
> 需部署后实网验证。代码已把控制权完全交给你，可搭配 `upstreams` 里的 IP 试验。

#### DoH IP 池（stealth 路由可选）

`stealth` 路由额外支持 **IP 池自动切换**（`"ip_pool": true`，默认开启）：

1. 请求全部候选（主 hostname + `upstreams`）失败后，才触发兜底
2. 用 `cloudflare-dns.com/dns-query`（DoH，`type=A`）实时解析当前主机名，取
IPv4 记录中前 4 个，逐个用 `stealthFetch` 直连——SNI/Host 仍填真实域名
3. 池结果按主机名缓存 5 分钟（进程内），失败对 DNS/源站零额外延迟
4. 每个 IP 接入既有健康检查（`markFail` 冷却、`scheduled` 定时 `HEAD`，按
`https://<IP>` 为 key 聚合），坏 IP 自动降权轮换

关闭：`"ip_pool": false`。`scheduled` 巡检会对该路由**第一个非通配 host**
的池 IP 做 stealth preflight（`stealthSupported()` 不满足时自动跳过探测）。
IPv4-only；已用 `range` 到 worker 的请求天然跳过 IP 池（`V4.test(host)`）。

#### Worker 底层限制（不可绕过，仅提示）

| 限制 | 说明 |
|------|------|
| 出站 IP 前缀 | Workers 出站 TCP 来源不属于 Cloudflare 公开 IP 段，源站看到的不是边缘 IP，个别站点的风控仍可能命中 |
| `startTls()` 单次 | 同一 socket 只能调用一次；本项目每次 `stealthFetch` 都新建连接、恰好调用一次，无连接复用 |
| 免费额度 | 10 万请求/天、每次 10ms CPU、请求体 100MB（用 Cache API / IP 池时注意 CPU 与体积预算） |

### 边缘缓存

`cache` 配置项，配合 Workerd `caches.default` Cache API 使用：

| 字段 | 默认 | 说明 |
|------|------|------|
| `static_ms` | GitHub/mod.io 7 天，Steam 1 天 | 命中后缀 `.jpg .png .gif .webp .svg .ico .css .js .mjs .woff .woff2 .ttf .eot` 等静态资源的强缓存 TTL |
| `micro_ms` | 未开启 | 对 `/api/` 或 `/graphql-` 路径的微缓存（如 10s），提升页面导航体验 |
| `rules` | 见内置 github 路由 | 按路径子串/正则的 TTL 规则，**优先于**后缀默认值。示例：`{ "match": "/releases/download", "ttl_ms": 3600000 }`；`"regex": true` 时按正则匹配 |

内置 GitHub 路由已含示例规则：Release 下载、`/archive/` 按 1h TTL（大体积受 25MB 门槛
自动豁免，不占缓存）。

缓存只在 `GET`、无 `Cookie`/`Authorization`/`Range` 请求头、响应无 `set-cookie`/`vary`/
`no-store`、且体积 < 25MB 时生效。`/__flush-cache?url=<origin url>`（需过 ACL）可主动失效。

### 可观测性（Analytics Engine，可选）

`proxy.js` 对每次请求写入一条事件（route / host / status / ok / upstream / ms）。启用：

1. Cloudflare 面板创建 Analytics Engine dataset（如 `steam302_cfworker`）
2. 取消 `wrangler.toml` 中 `analytics_engine_datasets` 注释并部署

之后可在 Analytics 面板按状态码、上游耗时分布筛选，为缓存命中率与 IP 池调优提供数据。

### wrangler.toml 环境变量（可选）

| 变量 | 说明 |
|------|------|
| `ACCESS_TOKEN` | 访问控制 token，需 `Authorization: Bearer <token>` 或 `?token=` |
| `ALLOW_IPS` | 逗号分隔 IP 白名单，留空不限 |
| `MANIFEST` | 内联 manifest JSON（KV 优先，适合快速测试） |
| `FAILOVER` | 内联 failover 配置，覆盖 manifest 中的值 |

---

## 健康检查与故障转移

Worker 配置了 `*/5` cron，每次触发：

1. **探测**：对每个 route 的所有 hosts（跳过 `*.` 通配）与 `upstreams` 发送 HEAD 请求（405/501 自动降级为 GET）
2. **降权**：连续失败达 `max_fails` 次的上游进入 `cooldown_s` 冷却（双写 isolate 内存 + HEALTH_KV，全区域共享）
3. **候选排序**：请求时健康上游优先，冷却中的排到队尾
4. 结果写入 `HEALTH_KV.snapshot`，30s 内缓存复用

---

## scripts 脚本

### 一键部署

```bash
bash scripts/deploy.sh   # 需 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，详见「部署·方式 C」
```

### 从 steam302-web 生成 manifest

```bash
git clone --depth=1 https://github.com/cyqmq/steam302-web.git /tmp/steam302-web
bash scripts/gen-manifest.sh /tmp/steam302-web
# 或指定输出文件：
bash scripts/gen-manifest.sh /tmp/steam302-web --output=manifest.json
```

从 `steam302-web/config/rules/*.json` 提取 hosts 与 group，Steam 规则自动加 Googlebot UA。
生成结果不含 `stealth`/`cache` 字段，可按需对 steam 路由手动补充 `"stealth": true`。

### 推送 manifest

```bash
bash scripts/push-manifest.sh manifest.json
```

---

## 安全与 ACL

| 保护层 | 说明 |
|-------|------|
| `ACCESS_TOKEN` | 设置后所有请求需 `Authorization: Bearer <token>` 或 `?token=` |
| `ALLOW_IPS` | IP 白名单（`cf-connecting-ip`），留空不限 |
| strip `cf-*` | 入站 `cf-*`、`x-real-ip`、`forwarded`、`x-forwarded-*` 全部剥离，源站看不到真实客户端 |
| CSP / clear-site-data | 响应中自动移除 |
| CORS | `OPTIONS` 204 预检；响应注入 `Access-Control-Allow-Origin: *` + `Private-Network: true` |
| `/__flush-cache` | 缓存失效入口（需过 ACL）：`/__flush-cache?url=<源站完整URL>` |

---

## 与 steam302-worker 的区别

| | steam302-worker | steam302-cfworker |
|---|---|---|
| Fallback | public / selfhosted / chain / none 四模式 | **无 Fallback**，纯直连 |
| Steam 登录 | 依赖外部节点规避封禁 | **stealth 模式**（sockets 直连）直接支持 OpenID |
| 缓存 | 无 | 静态强缓存 + API 微缓存 |
| mod.io | 需自建节点模拟 | 内置路由，Worker 直连 |
| 适用 | 已有 NAT 机 / 公共节点资源 | 独立 Worker 快速部署 |

## License

个人学习使用。自建节点请遵守对应云服务商与 GitHub / Steam 的使用条款。