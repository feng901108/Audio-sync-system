# 聚光广播 (Juguang) · 项目规范

> **状态：🟢 v4.1 已上线** | 最后更新：2026-07-12 | v4 tick-driven 同步（借鉴 Shairport Sync/Snapcast/AirPlay）+ v4.1 EMA 平滑 + play grace + advance 恢复

> 园区多设备音频同步广播系统。一处选歌，多端 < 80ms 内同步播放。
> 服务端零依赖（Node.js ≥ 22.5 内置 `node:sqlite`），前端零构建。

README.md 是系统级文档；本文件是**开发规范 + 命令速查**。

---

## 1. 技术栈

- **后端**：Node.js ≥ 22.5，纯 ESM（`.mjs`），内置模块 `node:http` / `node:fs` / `node:crypto` / `node:sqlite` / `node:path`
- **存储**：SQLite（`data/app.db`），音频文件落盘到 `data/audio/`
- **前端**：原生 HTML + ES Module + Web Audio API + WebSocket，零 npm 依赖
- **协议**：HTTP + 自实现 WebSocket（RFC6455）、自实现 multipart 解析

## 2. 目录约定

```
juguang/
├─ server/        # 服务端所有逻辑（HTTP 入口、WS hub、调度器、SQLite、auth、音频探测）
│  └─ *.mjs       # 全部 ESM
├─ web/           # 静态前端（直接被服务端托管，零构建）
│  ├─ index.html  # 聆听页 /
│  ├─ admin.html  # 管理页 /admin
│  ├─ sync.js     # 同步客户端核心
│  └─ styles.css  # 设计系统
├─ scripts/       # 本机 → NAS 部署脚本
├─ docs/          # 衍生文档（客户端移植指南等，非运行时必需）
├─ data/          # 运行时（gitignore）
│  ├─ audio/      # 上传的音频（gitignore）
│  └─ app.db      # SQLite（gitignore）
├─ Dockerfile     # node:24-alpine + tini + curl（国内镜像源）
├─ docker-compose.yml        # 标准部署
├─ docker-compose.fnOS.yml   # fnOS Docker UI 简化版
├─ .env / .env.example       # 端口 / 时区 / WebDAV 路径
├─ package.json              # 仅启动脚本，零 dependencies
├─ README.md                 # 系统级文档
└─ CLAUDE.md                 # 本文件：开发规范
```

**命名**：文件 / 函数 / 变量英文；用户可见文案中文。

**gitignore**：见 `.gitignore`（audio、db、logs、.env、截图、Snipaste 等）。

## 3. Git 工作流

- **默认分支**：`main`（受保护，所有变更先到 `dev` 验证后再合并）
- **开发分支**：`dev`（日常开发、测试都在此分支）
- **功能分支**：从 `dev` 拉 `feature/xxx` 或 `fix/xxx`，完成后 PR 合回 `dev`

提交规范：
- `feat: <一句话>` 新功能
- `fix: <一句话>` 修 bug
- `refactor: <一句话>` 重构
- `docs: <一句话>` 文档
- `chore: <一句话>` 杂项（依赖、配置、脚本）

红线（与全局 CLAUDE.md 一致）：
- 不在 `main` 上直接 commit
- 改 `.env`、数据库 schema、CI/CD 前必须先告诉我
- 不 force push、不 reset --hard、不跳 hook
- 密钥不进代码、不进 commit、不进日志

## 4. 常用命令

```bash
# 首次：创建管理员
node server/init-admin.mjs admin yourpassword

# 本机开发
npm start                # 生产方式（本机长开推荐，避开 --watch 被 OneDrive 同步触发）
npm run dev              # --watch 热重启（项目在 OneDrive 下，同步会频繁重启，仅短测用）

# 本机 → NAS 一键部署（commit + push + WebDAV 同步）
npm run deploy -- "feat: 改动说明"
# 或 Windows 原生 cmd：
npm run deploy:windows -- "feat: 改动说明"

# NAS 终端（每次本机 deploy 后跑一次 — **必须 rebuild 才能更新 web/**）
bash /vol1/1000/juguang/deploy.sh

# 校验
curl http://localhost:3000/api/health

# 语法检查（改完必跑）
node --check server/index.mjs
node --check server/scheduler.mjs
# （其它 .mjs 同理）

# Import 完整性校验（**改 export/import 后必跑**——`node --check` 只 parse 不查 export 名字）
# 例如 ws.mjs 加了 HEARTBEAT_INTERVAL_MS 但忘 export,容器会循环重启且错误信息只在容器日志里
node -e "import('./server/ws.mjs').then(m => console.log('ws.mjs exports:', Object.keys(m).join(', ')))"
node -e "import('./server/scheduler.mjs').then(m => console.log('scheduler.mjs exports:', Object.keys(m).join(', ')))"
# 任何 .mjs 同理：import('./server/xxx.mjs')
```

**⚠️ 重要**：web/ 改动必须 rebuild 容器镜像才能生效。光 `docker compose restart` 不会更新前端——`web/` 在 `Dockerfile` 里是 `COPY` 进去的，baked into image。`deploy.sh` 包含 `build --no-cache`，会自动重建。

环境变量：`PORT`（默认 3000）、`HOST`（默认 `0.0.0.0`，全网卡监听）。

## 5. 关键模块速查

| 文件 | 职责 |
|---|---|
| `server/index.mjs` | HTTP 路由 + 静态托管（按扩展名分支：`/audio/*` 强缓存 + ETag/304，HTML/JS/CSS 仍 no-store）+ Range 容错 + WebSocket upgrade |
| `server/scheduler.mjs` | 播放状态机：play/pause/resume/stop/seek/next/prev/queue、mode（sequential/loop-one/shuffle/loop-all）、zone CRUD、playlist CRUD、`snapshotForSync` v4 tick 数据源、`recoverAdvanceTimers` 重启恢复 |
| `server/ws.mjs` | 自实现 WebSocket + Hub（多设备、zone-scoped 广播、`broadcastSyncToZone` v4 tick 广播、僵尸清理、协议层心跳 `hub.pingAll()`） |
| `server/db.mjs` | SQLite 表结构（admins / tracks / devices / playback_state / sessions / zones / playlists） |
| `server/auth.mjs` | scrypt 密码哈希 + 自管 session（cookie: `juguang.sid`） |
| `server/multipart.mjs` | 自实现 multipart/form-data 解析（上限 1GB） |
| `server/audio-probe.mjs` | MP3 / WAV 时长探测（MP3 首帧 bitrate 推算 CBR 准 VBR 近似；WAV 读 RIFF data/byteRate） |
| `server/init-admin.mjs` | 初始化管理员 CLI |
| `web/sync.js` | 客户端同步核心：v4 tick-driven 同步（`_expectedPositionSec` 锚点外推）、EMA drift 平滑 + P-controller rate servo、play grace period、NTP 时钟同步、Web Audio 调度、iOS 解锁、MediaError 分码 |
| `scripts/deploy.sh` | 本机一键部署（git + WebDAV） |

**同步原理要点**（v4 tick-driven 架构，借鉴 Shairport Sync / Snapcast / AirPlay）：

1. 客户端每 2s ping 一次，取最近 10 次 RTT 最小 3 次的 offset 中位数作为时钟差
2. **服务端是位置真理源**：每 200ms ± 25ms 广播 `{type:"sync", positionMs, serverNow, isPlaying}` 给所有 `supportsSyncTicks=true` 的连接；play/pause/seek 后立即补发一个 tick（不等 200ms 节拍）
3. 客户端用**最新 sync tick + monotonic 外推**得到 expected position（`_expectedPositionSec`），等第 2 个 tick 到达后才启用（首 tick jitter 大）；5s 无 tick 回退 drift=0
4. 每 0.5s 用**插值位置时钟**（Safari currentTime 250ms 量化消噪）比对预期位置（含 `outputLatency` 补偿）：**EMA 平滑 drift**（α=0.3）→ 死区 50ms 内不动 → 50–500ms 用 **±2.5% playbackRate 微速率伺服**（`preservesPitch=false` 纯重采样，rate 变化迟滞 0.3% 防 iOS Safari 重采样器微卡顿）→ ≥500ms 硬 seek（最后手段，play 后 5s grace 期间不硬 seek）
5. 服务端每 `HEARTBEAT_INTERVAL_MS = 10s` 发 WS 协议层 ping frame；**服务器重启时** `recoverAdvanceTimers()` 自动恢复 is_playing=1 zone 的 advance 定时器（否则 loop-one/next 失效）

**可调旋钮**：
- `server/scheduler.mjs` `PRELOAD_MS`（默认 800，v4 仅服务音频加载，不再服务时钟缓冲）
- `server/ws.mjs` `SYNC_TICK_INTERVAL_MS`（默认 200，v4 tick 广播间隔）
- `server/ws.mjs` `HEARTBEAT_INTERVAL_MS`（默认 10000，协议层 ping 间隔）
- `server/ws.mjs` `STALE_MS`（默认 30000，僵尸连接阈值）
- `web/sync.js` `PING_INTERVAL_MS`（默认 2000，可调到 1000 加快收敛）
- `web/sync.js` `DRIFT_CHECK_MS`（默认 500，伺服修正周期）
- `web/sync.js` `DRIFT_DEADBAND_MS`（默认 50，死区内完全不修——iOS 蓝牙/AirPods 延迟需 ≥50）
- `web/sync.js` `DRIFT_EMA_ALPHA`（默认 0.3，drift EMA 平滑因子，~1.5-2s 收敛）
- `web/sync.js` `RATE_SERVO_ENABLED`（默认 true；**现场若疑有爆音置 false 一键回退纯 seek 模式**）
- `web/sync.js` `RATE_SERVO_MAX`（默认 0.025 = ±2.5% ≈43 音分，平衡收敛速度与 iOS 平滑度）
- `web/sync.js` `RATE_SERVO_HORIZON_S`（默认 4，伺服收敛时间常数）
- `web/sync.js` `RATE_HYSTERESIS`（默认 0.003，rate 变化 < 0.3% 不赋值，防 iOS 微卡顿）
- `web/sync.js` `PLAY_GRACE_MS`（默认 5000，play 后 5s 内不硬 seek，让 servo 消化加载延迟）
- `web/sync.js` `SEEK_THRESHOLD_MS`（默认 500，硬 seek 只做最后手段）
- `web/sync.js` `SEEK_COOLDOWN_MS`（默认 2000 兜底，seeked 事件会提前到 +300ms）
- `web/sync.js` `MAX_DRIFT_SEEKS`（默认 10，同曲 seek 上限防风暴）
- `web/sync.js` `MIN_BUFFER_FOR_SEEK_MS`（默认 1000，缓冲低于此值不 seek，starve 比不同步更差）

## 6. 验证流程

改完代码必跑：

1. `node --check server/index.mjs` 语法检查（所有改过的 `.mjs` 都跑）
2. `npm run dev` 启动，浏览器 `http://localhost:3000/api/health` 应返回 `{ok: true}`
3. 用 admin / yourpassword 登录 `/admin`
4. 上传一首 MP3，看曲库列表
5. 另开标签打开 `/`，输入设备名加入广播
6. admin 选歌点 ▶，确认有声音
7. **开两个聆听端标签**，admin 播同一首歌，目测两路输出相位差 < 80ms（必要时用录音软件测）

不能跳过的红线验证：
- 暂停 / 继续 / 切歌 / 拖拽队列 / 切模式，所有终端动作一致
- 单独调某个设备音量，不影响其它设备
- 客户端断 WiFi 5s 再连，自动重连并追到当前进度
- ≥ 5 分钟的歌，结尾各端漂移仍 < 80ms
- 多分区：在 zone=1 和 zone=2 各放不同歌，跨区互不影响
- 歌单：创建歌单、加曲、改名、载入队列

沙箱无法跑 `listen()`，本机需在浏览器实际验证人工项（同步相位差、长时漂移、跨 zone 隔离听觉感受）。