# 聚光广播 (Juguang) · 项目规范

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
npm start                # 生产方式
npm run dev              # --watch 热重启

# 本机 → NAS 一键部署（commit + push + WebDAV 同步）
npm run deploy -- "feat: 改动说明"
# 或 Windows 原生 cmd：
npm run deploy:windows -- "feat: 改动说明"

# 校验
curl http://localhost:3000/api/health

# 语法检查（改完必跑）
node --check server/index.mjs
node --check server/scheduler.mjs
# （其它 .mjs 同理）
```

环境变量：`PORT`（默认 3000）、`HOST`（默认 `0.0.0.0`，全网卡监听）。

## 5. 关键模块速查

| 文件 | 职责 |
|---|---|
| `server/index.mjs` | HTTP 路由 + 静态托管 + WebSocket upgrade |
| `server/scheduler.mjs` | 播放状态机：play/pause/resume/stop/seek/next/queue、zone CRUD、playlist CRUD |
| `server/ws.mjs` | 自实现 WebSocket + Hub（多设备、zone-scoped 广播、僵尸清理） |
| `server/db.mjs` | SQLite 表结构（admins / tracks / devices / playback_state / sessions / zones / playlists） |
| `server/auth.mjs` | scrypt 密码哈希 + 自管 session（cookie: `juguang.sid`） |
| `server/multipart.mjs` | 自实现 multipart/form-data 解析（上限 200MB） |
| `server/audio-probe.mjs` | MP3 时长探测（首帧 bitrate 推算，CBR 准，VBR 近似） |
| `server/init-admin.mjs` | 初始化管理员 CLI |
| `web/sync.js` | 客户端同步核心：NTP 时钟同步、漂移修正、Web Audio 调度 |
| `scripts/deploy.sh` | 本机一键部署（git + WebDAV） |

**同步原理要点**（详见 README §"同步原理"）：

1. 客户端每 2s ping 一次，取最近 10 次 RTT 最小 3 次的 offset 中位数作为时钟差
2. 服务端 `play` 命令带 `startServerTime = now + 800ms`（`PRELOAD_MS`），客户端换算到本地时刻精确 `start()`
3. 每 3s 比对实际位置 vs 应播位置：30–200ms 用 ±0.5% 速率追平，>200ms 直接 seek

**可调旋钮**：
- `server/scheduler.mjs` `PRELOAD_MS`（默认 800，慢端可调 1200）
- `web/sync.js` `PING_INTERVAL_MS`（默认 2000，可调到 1000 加快收敛）
- `web/sync.js` 漂移阈值 30/200 ms

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