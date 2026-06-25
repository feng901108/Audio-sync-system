# 聚光广播 (Juguang) · 项目规范

> 园区多设备音频同步广播系统。一处选歌，多端 <80ms 内同步播放。
> 服务端零依赖（Node.js ≥ 22.5 内置 `node:sqlite`），前端零构建。

---

## 1. 技术栈

- **后端**：Node.js ≥ 22.5，纯 ESM（`.mjs`），内置模块 `node:http` / `node:fs` / `node:crypto` / `node:sqlite` / `node:path`
- **存储**：SQLite（`data/app.db`），音频文件落盘到 `data/audio/`
- **前端**：原生 HTML + ES Module + Web Audio API + WebSocket，零 npm 依赖
- **协议**：HTTP + 自实现 WebSocket（RFC6455）、自定义 multipart 解析

---

## 2. 目录约定

```
juguang/
├─ server/        # 服务端所有逻辑（HTTP 入口、WS hub、调度器、SQLite、auth、音频探测）
│  └─ *.mjs       # 全部用 ESM
├─ web/           # 静态前端（直接被服务端托管，零构建）
│  ├─ index.html  # 聆听页 /
│  ├─ admin.html  # 管理页 /admin
│  └─ sync.js     # 同步客户端核心
├─ data/
│  ├─ audio/      # 上传的音频文件（已 gitkeep，文件本身不入库）
│  └─ app.db      # SQLite 数据库（不入库）
├─ package.json   # 仅启动脚本，无 dependencies
└─ CLAUDE.md      # 本文件
```

**命名**：文件/函数/变量用英文；用户可见文案用中文。

**git 忽略**（见 `.gitignore`）：`data/audio/*`（除 `.gitkeep`）、`data/app.db`、`data/app.db-*`、`.env`、`node_modules/`、`*.log`。

---

## 3. Git 工作流

- **默认分支**：`main`（受保护，所有变更先到 `dev` 验证后再合并）
- **开发分支**：`dev`（日常开发、测试都在此分支）
- **功能分支**：从 `dev` 拉 `feature/xxx` 或 `fix/xxx`，完成后 PR 合回 `dev`

**分支流转**：

```
main  ←  dev  ←  feature/xxx
                  fix/xxx
```

**提交规范**（建议）：

- `feat: <一句话>` 新功能
- `fix: <一句话>` 修 bug
- `refactor: <一句话>` 重构
- `docs: <一句话>` 文档
- `chore: <一句话>` 杂项（依赖、配置、脚本）

**红线（与全局 CLAUDE.md 一致）**：

- 不在 `main` 上直接 commit
- 改 `.env`、数据库 schema、CI/CD 前必须先告诉我
- 不 force push、不 reset --hard、不跳 hook
- 密钥不进代码、不进 commit、不进日志

---

## 4. 常用命令

```bash
# 首次：创建管理员
node server/init-admin.mjs admin yourpassword

# 启动
npm start                # 生产方式
npm run dev              # --watch 热重启

# 校验
curl http://localhost:3000/api/health
```

环境变量：`PORT`（默认 3000）、`HOST`（默认 `0.0.0.0`，全网卡监听）。

---

## 5. 关键模块速查

| 文件 | 职责 |
|---|---|
| `server/index.mjs` | HTTP 路由 + 静态托管 + WebSocket upgrade |
| `server/scheduler.mjs` | 播放状态机：play/pause/resume/stop/seek/next/queue |
| `server/ws.mjs` | 自实现 WebSocket + Hub（多设备消息分发） |
| `server/db.mjs` | SQLite 表结构（admins / tracks / devices / playback_state / sessions） |
| `server/auth.mjs` | scrypt 密码哈希 + 自管 session（cookie: `juguang.sid`） |
| `server/multipart.mjs` | 自实现 multipart/form-data 解析（上限 200MB） |
| `server/audio-probe.mjs` | MP3 时长探测（首帧 bitrate 推算，CBR 准，VBR 近似） |
| `server/init-admin.mjs` | 初始化管理员 CLI |
| `web/sync.js` | 客户端同步核心：NTP 风格时钟同步、漂移修正、Web Audio 调度 |

**同步原理要点**（详见 `.claude/plans/iphone-radiant-lollipop.md`，如已存在）：

1. 客户端每 2s ping 一次，取最近 10 次 RTT 最小 3 次的 offset 中位数作为时钟差
2. 服务端 `play` 命令带 `startServerTime = now + 800ms`（`PRELOAD_MS`），客户端换算到本地时刻精确 `start()`
3. 每 3s 比对实际位置 vs 应播位置：30–200ms 用 ±0.5% 速率追平，>200ms 直接 seek

**可调旋钮**：
- `server/scheduler.mjs` `PRELOAD_MS`（默认 800，慢端可调 1200）
- `web/sync.js` `PING_INTERVAL_MS`（默认 2000，可调到 1000 加快收敛）
- `web/sync.js` 漂移阈值 30/200 ms

---

## 6. 验证流程

**改完代码必跑**：

1. `node --check server/index.mjs` 语法检查（可对每个改过的 mjs 都跑）
2. 启动 `npm run dev`，浏览器打开 `http://localhost:3000/api/health`，应返回 `{ok: true}`
3. 用 `admin / yourpassword` 登录 `/admin`
4. 上传一首 MP3，看曲库列表
5. 另开标签打开 `/`，输入设备名加入广播
6. admin 选歌点 ▶，确认有声音
7. **开两个聆听端标签**，admin 播同一首歌，目测两路输出相位差 <80ms（必要时用录音软件测）

**不能跳过的红线验证**：
- 暂停 / 继续 / 切歌 / 拖拽队列，所有终端动作一致
- 单独调某个设备音量，不影响其它设备
- 客户端断 WiFi 5s 再连，自动重连并追到当前进度
- ≥5 分钟的歌，结尾各端漂移仍 <80ms

---

## 7. 当前完成状态（首次基线）

> **基线时间**：2026-06-25（首次拉取 `a86d807 init: 聚光广播`）

### ✅ 已实现（MVP 完整闭环）

- 服务端 HTTP 路由 + 静态托管（含 `/audio/*` Range 请求）
- WebSocket 自实现 + Hub 消息分发（握手哈希、ping/pong、ping 后刷 `last_seen_at`）
- 调度器状态机（play/pause/resume/stop/seek/next）+ 播放队列
- SQLite 表 + 自管理 session + scrypt 密码
- 管理员登录/登出/初始化
- 音频上传（multipart，200MB 上限）、删除、时长探测（仅 MP3 准确）
- 设备管理（在线状态、改名、调音量、移除）
- 客户端 NTP 风格时钟同步 + 预约调度 + 漂移修正（±0.5% / 200ms seek）
- 管理端 UI（曲库 / 队列 / 设备 三面板 + 1s 轮询）
- 聆听端 UI（连接状态、漂移、RTT、时钟差、进度条、本机音量）

### ⚠️ 部分实现

- **时长探测**：仅 MP3 准确；M4A/AAC/OGG/WAV/FLAC 直接返回 0，前端用 `<audio>` metadata 兜底
- **多设备音量**：`/api/devices/:id` PATCH 改 volume 同时 WS 推送 `setVolume`，但客户端 `_handle` 收到后无条件覆盖 `gain.gain.value`，**用户本机拉杆调整会被服务端下发覆盖**（除非本机与 admin 设置一致）
- **session 失效**：只检查 `expires_at` 是否过期，没有主动续期；管理员长时间不操作会突然掉登录

### ❌ 缺口 / 后续

- 单同步分区（`zone_id=1` 是硬编码常量，未做多分区）
- 定时任务（上下班铃、夜间 BGM）—— 数据库无 cron 表，无调度器
- mDNS 自动发现服务端
- Android 原生客户端（Kotlin + ExoPlayer + Foreground Service）—— README "后续" 列出
- 无 HTTPS（生产部署需前置反代，如 Caddy/Nginx）
- 无文件级鉴权（`/audio/*` 拿到文件名即可下载，无 token 校验）
- 曲目没有 artist 字段写入（上传时 artist 写 null，admin 无法编辑元数据）
- 队列拖拽排序（`/api/queue/replace` 存在但 UI 没暴露）
- 没有测试用例（README 提到 multipart 单测过，但仓库里未见 test 目录）
- 错误处理：上传 >200MB 直接抛错给前端，前端只 `alert` HTTP body

### 📋 验收清单当前状态

参见 `README.md` 第 60-70 行的 9 项验收清单。本机未端到端跑过（沙箱 `listen()` 被拒），需在 Mac/NUC 上 `npm run dev` 实际验证。

---

## 8. 待办（按优先级）

1. **端到端验证 9 项验收清单**（高）
2. 修复客户端"本机音量"被服务端下发覆盖的问题（中）
3. 给曲目加元数据编辑（artist / 标题）UI（中）
4. 队列拖拽排序 UI（低）
5. 多分区架构（zone_id 抽象）（低，需要先想清楚产品形态）
6. 定时广播 / BGM 调度（低，独立大功能）
7. 写测试用例（多帧 MP3 探测、WS 编解码、路由权限）（中）
8. HTTPS + 鉴权代理（生产前必须）

---

## 9. 文档存放

- `README.md` — 项目说明、架构图、快速开始
- `CLAUDE.md`（本文件）— 开发规范、约定、当前状态
- `.claude/plans/iphone-radiant-lollipop.md` — 同步原理详细设计（如果仓库里有，跟着走）
