# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

基于 Cloudflare Worker 的 Telegram 投稿机器人（Webhook 模式），内嵌密码保护的前端统计页。**零第三方 npm 依赖**，纯 ES Module 原生 JS。

## 常用命令

```bash
wrangler dev              # 本地开发（http://localhost:8787）
wrangler deploy           # 部署到 Cloudflare
wrangler kv:namespace create "KV"  # 创建 KV（首次部署需要）
wrangler tail             # 查看生产日志
```

设置/更新 Webhook（替换 `<TOKEN>`、`<URL>`、`<SECRET>`）：
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<URL>/webhook&secret_token=<SECRET>&allowed_updates=[\"message\",\"callback_query\",\"channel_post\"]"
```

**注意**：本地 `wrangler dev` 时 TG Webhook 无法回调 localhost，测试 Bot 交互需要部署到 CF 或使用 tg 代理。前端页面（`/`）和 API（`/api/posts`）可在本地直接测试。

## 架构

### 路由分发（`src/index.js`）

单 Worker 通过 URL path + method 区分 4 条路由。`scheduled` handler 独立处理 Cron 触发器（每 5 分钟扫描超时会话）。

所有模块函数统一签名为 `(…, env)` —— `env` 对象贯穿整个调用链，携带 `BOT_TOKEN`、`CHANNEL_ID`、`ADMIN_IDS`、`WEBHOOK_SECRET`、`ACCESS_PASSWORD`、`KV` binding。

### Bot 状态机（`src/bot/`）

```
IDLE → (收到素材) → AWAITING_TYPE → AWAITING_CAPTION → (转发) → IDLE
                         ↑                  │
                    追加素材（≤9）   15min超时→自动匿名转发
```

- `handler.js`：Webhook 入口，验证 `X-Telegram-Bot-Api-Secret-Token` header，分发 `message` / `callback_query` / `channel_post`
- `state.js`：用户交互状态机。`processMessage()` 处理用户消息（含 `/start`），`processCallback()` 处理 Inline Keyboard 按钮回调。回调数据常量 `CB.*` 在 `constants.js` 中定义
- `forwarder.js`：三种场景转发 —— 纯文字 (`sendMessage`)、单媒体 (`copyMessage` 或 `sendMediaGroup`)、多媒体 (`sendMediaGroup`)。`isTimedOut` 参数控制超时场景（强制匿名 + 不同通知文案）

### 认证流（`src/auth/`）

- Cookie Token 格式：`HMAC-SHA256(timestamp, WEBHOOK_SECRET).timestamp`，24h 过期
- 使用 Web Crypto API (`crypto.subtle`)，常数时间比对防时序攻击
- 前端密码页 POST `/` → Worker 验证 → Set-Cookie → 302 到 `/`（此时 Cookie 有效 → 渲染列表）

### KV 数据模型（`src/storage/`）

| 前缀 | Key | 用途 |
|------|-----|------|
| `temp:` | `temp:{chatId}` | 用户会话（state, media[], text, isAnonymous, username, lastActivity, messageIds[]） |
| `post:` | `post:{timestamp}_{userId}` | 永久投稿记录（timestamp 作为毫秒级时间戳） |
| `msgmap:` | `msgmap:{channel_message_id}` | 频道消息→投稿人映射，TTL 90 天 |

**重要**：`temp:` 不再使用 KV 原生 TTL，超时由 Cron 定时任务主动扫描 `lastActivity` 并调用 `forward(chatId, env, true)` 实现。这确保了超时后素材被转发而非直接丢弃。

### 前端（`src/frontend/render.js`）

纯 HTML 字符串模板，CSS 内嵌在 `<style>` 标签，响应式断点 768px。移动端隐藏文案列节省空间。投稿列表通过 SSR 直接渲染，页面内嵌 60 秒自动刷新脚本。

### 环境变量

5 个必须配置项，均通过 `wrangler.toml` 的 `[vars]` 注入，禁止硬编码：
`BOT_TOKEN` | `CHANNEL_ID` | `ADMIN_IDS`（逗号分隔） | `WEBHOOK_SECRET`（≥32 字符） | `ACCESS_PASSWORD`

## 关键约束

- **零 npm 依赖**：所有模块导入必须是 `'./xxx.js'` 的相对路径 ES Module，不能引入任何 npm 包（包括 `@cloudflare/workers-types`）
- **env 贯穿**：所有涉及环境变量或 KV 的操作都通过函数参数 `env` 传递，不使用全局变量
- **KV 操作无 TTL**：`saveSession` 不设 TTL，超时会话由 `scheduled` handler 主动扫描和处理
- **扩展点**：`state.js` 底部有 `[EXTENSION]` 注释标记白名单/关键词过滤/人工审核预留位置
- **admin reply**：`handler.js` 的 `handleChannelPost` 只处理来自 `CHANNEL_ID`（env 中配置的）的消息，且发送者必须在 `ADMIN_IDS` 列表中
