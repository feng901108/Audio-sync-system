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

## 7. 当前完成状态

> **基线时间**：2026-06-25（首次拉取 `a86d807 init: 聚光广播`）
> **多分区完成**：2026-06-25（commit `6fc9adc` + `eb3941e` + `aa19fe8`）

### ✅ 已实现

- **多分区架构**：zones 表 + 默认分区（可改名不可删）+ admin 可手动增/改/删其他分区
- **Zone 隔离调度**：每 zone 独立 playback_state、独立队列、独立 advanceTimer、独立快照
- **Zone 隔离广播**：WS Hub 按 zoneId 广播；register 带 zoneId；conn 切换 zone 时立刻收新 zone 的 snapshot
- **路径化 API**：`/api/zones[/:id]` 管理 + `/api/zones/:zoneId/...` 作用域；旧 `/api/playback/...` `/api/queue/...` 保留作 zone=1 过渡
- **曲目全局共享**：tracks 表不分区，admin 上传一次所有 zone 都能选
- **设备移动 zone**：`PATCH /api/devices/:id {zoneId}` + Hub 实时切换 + 重连保持
- 服务端 HTTP 路由 + 静态托管（含 `/audio/*` Range 请求）
- WebSocket 自实现 + Hub 消息分发（握手哈希、ping/pong、ping 后刷 `last_seen_at`）
- 调度器状态机（play/pause/resume/stop/seek/next）+ 播放队列
- SQLite 表 + 自管理 session + scrypt 密码
- 管理员登录/登出/初始化
- 音频上传（multipart，200MB 上限）、删除、时长探测（仅 MP3 准确）
- 设备管理（在线状态、改名、调音量、移除、移动 zone）
- 客户端 NTP 风格时钟同步 + 预约调度 + 漂移修正（±0.5% / 200ms seek）
- 客户端**两层音量**：master（服务端） × local（本机）= gain.value，admin 调音量不会覆盖用户本机拉杆
- 管理端 UI：顶部 zone tabs + 分区管理弹窗 + 曲库/队列/设备三面板 + 2s 轮询
- 聆听端 UI：连接状态、漂移、RTT、时钟差、进度条、本机音量、zone 选择下拉、zone 标签

### ⚠️ 部分实现 / 已知缺陷

- **时长探测**：仅 MP3 准确；M4A/AAC/OGG/WAV/FLAC 直接返回 0，前端用 `<audio>` metadata 兜底
- **session 失效**：只检查 `expires_at` 是否过期，没有主动续期；管理员长时间不操作会突然掉登录
- **WS 僵尸连接无超时**：`Hub.conns` 只增不减，TCP 断了 `online` 仍为 `true`（`/api/devices` 的 online 字段用 `hub.onlineDeviceIds()` 判断，会显示僵尸设备在线；`/api/zones/:zoneId/devices` 同理）
- **"未分区"设备**：admin 把设备 zoneId 设为 null 时，Hub 给其 `zoneId=0`，`broadcastToZone(0)` 不会命中任何订阅但 `sendTo` 单播仍能到（音量推送 OK）。设备不再收任何 play/pause 推送，需要重新分配 zone 才能听广播

### ❌ 缺口 / 后续

- 定时任务（上下班铃、夜间 BGM）—— 数据库无 cron 表，无调度器
- mDNS 自动发现服务端
- Android 原生客户端（Kotlin + ExoPlayer + Foreground Service）—— README "后续" 列出
- 无 HTTPS（生产部署需前置反代，如 Caddy/Nginx）
- 无文件级鉴权（`/audio/*` 拿到文件名即可下载，无 token 校验）
- 曲目没有 artist 字段写入（上传时 artist 写 null，admin 无法编辑元数据）
- 队列拖拽排序（`/api/queue/replace` 存在但 UI 没暴露）
- 没有测试用例（README 提到 multipart 单测过，但仓库里未见 test 目录）
- 错误处理：上传 >200MB 直接抛错给前端，前端只 `alert` HTTP body
- REST 错误码不规范：`play` 失败、`DELETE` 不存在返 200，应 4xx
- 旧路径 `/api/playback/...` `/api/queue/...` 过渡：下次大版本删

### 📋 验收清单当前状态

参见 `README.md` 第 60-70 行的 9 项验收清单。**多分区版本**对应验收项需改为按 zone 验证：
- 两个 zone 各有一个聆听标签，能听到各自的内容
- admin 切换 zone tabs 不会影响其他 zone

沙箱无法跑 `listen()`，本机需在浏览器实际验证人工项（同步相位差、长时漂移、跨 zone 隔离听觉感受）。

---

## 8. 待办（按优先级）

1. **本机浏览器端到端跑通**（高）：两个 zone tabs 切换、聆听端选 zone、跨 zone 隔离听觉
2. WS 僵尸连接超时清理（中，hub 加 `lastSeenAt`，定期扫）
3. REST 错误码规范化（中，play 失败 / DELETE 不存在 改 4xx）
4. 给曲目加元数据编辑（artist / 标题）UI（中）
5. 队列拖拽排序 UI（低）
6. 定时广播 / BGM 调度（低，独立大功能）
7. 删除旧路径 `/api/playback/...` `/api/queue/...`（低，下个大版本）
8. 写测试用例（多帧 MP3 探测、WS 编解码、路由权限、zone 隔离 broadcastToZone）（中）
9. HTTPS + 鉴权代理（生产前必须）
10. Android 原生客户端（独立项目）
11. mDNS 自动发现服务端（低）

---

## 9. 文档存放

- `README.md` — 项目说明、架构图、快速开始
- `CLAUDE.md`（本文件）— 开发规范、约定、当前状态
- `.claude/plans/iphone-radiant-lollipop.md` — 同步原理详细设计（如果仓库里有，跟着走）
