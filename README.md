# TG 投稿机器人 · Cloudflare Worker

基于 Cloudflare Worker 的 Telegram 投稿机器人（Webhook 模式），内嵌密码保护的前端统计面板。**零第三方 npm 依赖**，纯 ES Module 原生 JavaScript 实现。

## 功能

| 模块 | 说明 |
|------|------|
| **Telegram Bot** | 接收图片/视频/文字投稿，支持匿名/实名、补充文案、15 分钟超时自动匿名转发、取消投稿 |
| **前端统计面板** | 密码保护，展示近 7 天投稿记录（时间、类型、投稿人、文案、素材缩略图），支持一键删除 |
| **管理员回复** | 频道内回复投稿消息 → 自动私聊通知投稿人，投稿人可直接回复到频道 |
| **图片代理** | Worker 端代理 TG 图片，避免 Bot Token 泄露到前端 |
| **Cron 定时任务** | 每 5 分钟扫描过期会话，自动匿名转发，避免素材丢失 |

## 文件结构

```
├── src/
│   ├── index.js                # Worker 入口 + 路由分发 + Cron 处理
│   ├── bot/
│   │   ├── handler.js          # Webhook 入口：Secret Token 验证 + Update 分发
│   │   ├── state.js            # 状态机：用户交互流程
│   │   └── forwarder.js        # 转发器：三种场景转发到频道
│   ├── storage/
│   │   └── kv.js               # KV 封装：会话 / 投稿 / 消息映射 / 回复上下文 CRUD
│   ├── api/
│   │   └── posts.js            # 数据 API：JSON 格式投稿列表
│   ├── frontend/
│   │   └── render.js           # SSR HTML 渲染：密码页 + 投稿列表页
│   ├── auth/
│   │   └── auth.js             # Cookie 认证：HMAC-SHA256 Token 签发与校验
│   └── utils/
│       ├── telegram.js         # TG Bot API 封装（纯 fetch）
│       └── constants.js        # 常量：状态、KV 前缀、TTL 等
├── wrangler.toml.example       # 部署配置模板
└── README.md
```

## 架构

### 路由分发

单 Worker 通过 URL path + method 区分路由，`scheduled` handler 独立处理 Cron 触发器：

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| `GET` | `/` | Cookie | 已登录 → 投稿列表；未登录 → 密码表单 |
| `POST` | `/` | 密码 | 密码验证，成功后签发 Cookie 并重定向 |
| `GET` | `/api/posts` | Cookie | 投稿列表 JSON API |
| `GET` | `/api/image` | Cookie | 图片代理（通过 Worker 获取 TG 图片） |
| `POST` | `/api/delete` | Cookie | 删除投稿（同步删除频道消息） |
| `POST` | `/webhook` | Secret Token | TG Bot Webhook 回调入口 |
| — | `scheduled` | — | 每 5 分钟扫描超时会话 |

### Bot 状态机

```
IDLE → (发送 /start) → READY → (发送素材) → AWAITING_TYPE
                              ↑                      │
                         追加素材（≤9）   ┌─ 选择匿名/实名 ─┐
                                          ↓                  ↓
                                    AWAITING_CAPTION ← 是否需要文案
                                          │                  │
                                          └── 转发到频道 ←───┘
                                                │
                                         15min 无操作 → 自动匿名转发
```

### 认证流

- **Webhook 认证**：验证请求头 `X-Telegram-Bot-Api-Secret-Token`，与 `WEBHOOK_SECRET` 比对
- **前端认证**：Cookie Token 格式 `HMAC-SHA256(timestamp, WEBHOOK_SECRET).timestamp`，24 小时过期
- 使用 Web Crypto API (`crypto.subtle`)，**常数时间比对**防时序攻击

### KV 数据模型

| 前缀 | Key | TTL | 说明 |
|------|-----|-----|------|
| `temp:` | `temp:{chatId}` | 无（Cron 主动扫描） | 用户会话（状态、素材、文案、匿名选择等） |
| `post:` | `post:{timestamp}_{userId}` | 永久 | 投稿记录 |
| `msgmap:` | `msgmap:{channelMsgId}` | 90 天 | 频道消息 → 投稿人映射（管理员回复用） |
| `reply:` | `reply:{chatId}` | 无 | 评论回复上下文 |

> **注意**：`temp:` 不使用 KV 原生 TTL。超时会话由 Cron 定时任务主动扫描 `lastActivity` 并调用转发，确保超时素材**不会直接丢弃**。

### 转发场景

| 场景 | 方法 | 说明 |
|------|------|------|
| 纯文字 | `sendMessage` | 直接发送文字 + 投稿人标注 |
| 单媒体 | `copyMessage` 或 `sendMediaGroup` | 有文案用 media group，无文案直接复制 |
| 多媒体（2-9） | `sendMediaGroup` | 批量发送，首项带 caption |

超时场景强制匿名 + 不同通知文案。

## 部署

### 前置条件

- [Node.js](https://nodejs.org/) 和 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)：
  ```bash
  npm install -g wrangler
  wrangler login
  ```
- 一个 [Telegram Bot Token](https://t.me/BotFather)（从 @BotFather 获取）
- 一个目标投稿频道（Bot 需为频道管理员）

### 步骤

#### 1. 克隆仓库

```bash
git clone <repo-url>
cd tg-bot
```

#### 2. 创建 KV Namespace

```bash
wrangler kv:namespace create "KV"
```

将输出的 `id` 保存备用。

#### 3. 配置环境变量

复制模板文件并填入真实值：

```bash
cp wrangler.toml.example wrangler.toml
```

编辑 `wrangler.toml`，填入以下必填项：

| 变量 | 说明 | 示例 |
|------|------|------|
| `BOT_TOKEN` | Telegram Bot Token | `123456:ABCdef...` |
| `CHANNEL_ID` | 目标频道 ID（负数） | `-1001234567890` |
| `ADMIN_IDS` | 管理员 ID（逗号分隔） | `123456,789012` |
| `WEBHOOK_SECRET` | Webhook 签名密钥（≥32 字符） | 随机字符串 |
| `ACCESS_PASSWORD` | 前端访问密码 | 强密码 |

同时在 `[[kv_namespaces]]` 中填入第 2 步获得的 KV namespace `id`。

> ⚠️ **`wrangler.toml` 包含敏感信息，已加入 `.gitignore`，请勿提交到版本控制。**

生成随机密钥：
```bash
openssl rand -hex 32
```

#### 4. 部署 Worker

```bash
wrangler deploy
```

#### 5. 设置 Webhook

部署后获得 Worker URL（如 `https://tg-bot.xxx.workers.dev`）：

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<YOUR_WORKER_URL>/webhook&secret_token=<WEBHOOK_SECRET>&allowed_updates=[\"message\",\"callback_query\",\"channel_post\"]"
```

#### 6. 验证

1. 在 TG 中向 Bot 发送 `/start`，验证投稿交互流程
2. 浏览器访问 Worker URL，验证密码页面（正确密码进入列表，错误密码被拒绝）
3. 在频道中回复某条投稿，验证投稿人是否收到私聊通知

## 本地开发

```bash
wrangler dev           # 启动本地开发服务器（http://localhost:8787）
wrangler tail          # 查看生产日志
```

> **注意**：本地开发时 TG Webhook 无法回调 `localhost`。Bot 交互需要部署到 Cloudflare 后测试。前端页面（`/`）和 API（`/api/posts`）可在本地直接测试。

## 技术细节

### 零依赖

所有模块使用 ES Module 相对路径导入（`'./xxx.js'`），不依赖任何 npm 包（包括 `@cloudflare/workers-types`）。TG API 调用全部通过原生 `fetch` 实现。

### env 贯穿

所有涉及环境变量或 KV 的操作通过函数参数 `env` 传递，不使用全局变量。模块签名统一为 `(…, env)`。

### 安全措施

- Webhook 入口验证 `X-Telegram-Bot-Api-Secret-Token` 请求头
- Cookie Token 使用 HMAC-SHA256 签名，常数时间比对防时序攻击
- 图片通过 Worker 代理获取，Bot Token 不暴露到前端
- 前端 HTML 输出进行转义防 XSS
- 密码明文比对（通过环境变量注入，不存储 hash）

### Cloudflare 免费计划限制

- Workers：每天 10 万请求，CPU 10ms/请求
- KV：每天 10 万读、1 千写
- 单次投稿最多 9 个素材（Telegram media group 限制）

## 预留扩展

代码中以 `[EXTENSION]` 注释标记了预留位置（`src/bot/state.js` 底部）：

- **白名单**：限制允许投稿的用户
- **关键词过滤**：拦截敏感内容
- **人工审核**：管理员审核后发布
