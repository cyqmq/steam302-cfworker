# steam302-cfworker

基于 [steam302-worker](https://github.com/cyqmq/steam302-worker) 精简重构的 Cloudflare Worker 加速项目。**无需任何 Fallback 节点**，Worker 独立完成 GitHub 全站加速与 Steam 部分资源加速，通过 same-host 模式直连源站。

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
- **Steam 静态资源加速**：`steamcommunity.com`、`store.steampowered.com`、`cdn.cloudflare.steamstatic.com` 等，默认 Googlebot UA 伪装
- **Host 路由**：按请求 Host 头分发到对应源站，Worker 即为反向代理入口
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
│   ├── worker.js        # 入口：路由匹配、ACL、OPTIONS 预检、scheduled
│   ├── router.js        # matchRoute（最长后缀匹配）+ 内置默认 manifest
│   ├── config.js        # 读取 KV manifest > env MANIFEST > 内置默认（30s 缓存）
│   ├── proxy.js         # 候选排序、请求发送、健康降权、302 递归跟随
│   ├── health.js        # 双写（KV + isolate 内存）健康状态、定时探测
│   └── util.js          # UA、asset host 列表、hash
├── scripts/
│   ├── gen_manifest.py / .sh   # 从 steam302-web config/rules/*.json 生成 manifest
│   └── push-manifest.sh       # 推送 manifest 到 KV（30s 内生效，无需重新部署）
├── wrangler.toml              # Cloudflare Worker 配置
├── manifest.example.json      # 完整 manifest 示例
└── README.md
```

---

## 部署

### 1. 创建 KV 命名空间

```bash
wrangler kv namespace create ROUTES
wrangler kv namespace create HEALTH_KV
```

将返回的 ID 填入 `wrangler.toml` 的 `kv_namespaces`。

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
      "upstreams": ["https://alt.origin.example.com"]  // 可选：替代直连目标
    },
    {
      "id": "steam",
      "mode": "same-host",
      "hosts": ["steamcommunity.com", "cdn.cloudflare.steamstatic.com"],
      "ua": "Googlebot/2.1 (+http://www.google.com/bot.html)",
      "upstreams": []
    }
  ]
}
```

`upstreams` 可填入多个替代直连目标（如其它地区 IP/域名镜像）。请求时的候选顺序：

1. 主源站（same-host 的 `Host` 目标）
2. `upstreams`（按配置顺序）
3. 冷却中的候选自动降权到队尾；全部失败返回 502

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

### 从 steam302-web 生成 manifest

```bash
git clone --depth=1 https://github.com/cyqmq/steam302-web.git /tmp/steam302-web
bash scripts/gen-manifest.sh /tmp/steam302-web
# 或指定输出文件：
bash scripts/gen-manifest.sh /tmp/steam302-web --output=manifest.json
```

从 `steam302-web/config/rules/*.json` 提取 hosts 与 group，Steam 规则自动加 Googlebot UA。

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

---

## 与 steam302-worker 的区别

| | steam302-worker | steam302-cfworker |
|---|---|---|
| Fallback | public / selfhosted / chain / none 四模式 | **无 Fallback**，纯直连 |
| 依赖 | 可选公共节点或自建隧道 | 零依赖 |
| 适用 | 已有 NAT 机 / 公共节点资源 | 独立 Worker 快速部署 |

## License

个人学习使用。自建节点请遵守对应云服务商与 GitHub / Steam 的使用条款。