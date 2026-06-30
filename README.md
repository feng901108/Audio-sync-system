# 聚光广播 Juguang

园区内的多设备音频同步广播系统。一处选歌，所有终端（小米电视、安卓手机接音响、iPhone Safari）< 80ms 内同步播放。

> **零依赖**：服务端只需要 Node.js ≥ 22.5（用到了内置 `node:sqlite`）。前端零构建，纯静态文件 + ES module。

## 功能

- **多设备同步播放**：NTP 风格时钟同步 + 预约调度 + 漂移修正
- **多分区架构**：每分区独立播放状态、队列、广播；曲目库全局共享
- **歌单管理**：创建 / 改名 / 删除歌单，批量载入分区队列
- **播放模式**：顺序 / 单曲循环 / 随机 / 歌单循环
- **曲目管理**：上传（多文件 + 进度条）、删除、编辑标题 / 艺人
- **队列拖拽排序**：HTML5 原生拖拽改顺序
- **两层音量**：服务端 master × 客户端 local，admin 调音量不覆盖用户本机
- **设备管理**：分活跃 / 历史两段展示、改名、调音量、移动分区、移除（活跃设备删除会同时断开 WS）
- **零公网依赖**：自实现 WebSocket（RFC6455）、自管 session（scrypt 哈希）

## 架构

```
┌─────────────────────┐
│  管理端浏览器 /admin │  ← 上传 / 选歌 / 控队列 / 分区管理 / 歌单 / 模式
└──────────┬──────────┘
           │  HTTP + WebSocket
┌──────────▼──────────────────────────────────────────────────────────┐
│ 服务端 Node.js (zero-dep, node:sqlite + node:http)                 │
│   - REST: /api/auth /tracks /devices /playlists /zones /playback  │
│   - WS:   /ws  Hub 多分区广播、ping/pong、register                 │
│   - 静态: /audio/*  Range 请求                                       │
└──────────┬──────────────────────────────────────────────────────────┘
           │  WebSocket（zoneId-scoped broadcast）
   ┌───────┼───────┬─────────────┐
   ▼       ▼       ▼             ▼
 小米电视  安卓手机  iPhone Safari  其它设备
 (网页)   (网页)   (网页 /)
```

## 快速开始（开发）

需要 **Node.js ≥ 22.5**（已用 v24.15 验证）。

```bash
git clone <repo>
cd Audio-sync-system

# 1) 创建管理员（首次必做）
node server/init-admin.mjs admin yourpassword

# 2) 启动
npm start                # 生产
npm run dev              # 热重启（--watch）

# 3) 浏览器
# 管理端: http://<服务器 IP>:3000/admin
# 聆听端: http://<服务器 IP>:3000/
```

环境变量：`PORT`（默认 3000）、`HOST`（默认 `0.0.0.0`）。

## 部署（Docker / NAS）

**镜像构建**：`Dockerfile` 用 `node:24-alpine`，国内源走 `docker.m.daocloud.io/library/node:24-alpine`（fnOS 默认 `docker.fnnas.com` 返 401）。

```bash
docker compose up -d --build      # 标准部署
docker compose logs -f juguang    # 看日志
docker compose restart juguang    # 重启
docker compose down               # 停止并删除容器
```

`docker-compose.yml` 含健康检查、资源限制、日志轮转；`docker-compose.fnOS.yml` 是给 fnOS Docker 应用 UI 的简化版（去掉了 UI 不识别的字段）。

### NAS（飞牛 fnOS）本机 → NAS 部署流程

> 本机代码推到 GitHub → NAS 通过 WebDAV 同步代码 → NAS 终端 docker 重构建建。

**本机一次性配置**（在项目根）：

```bash
cp .env.example .env
# 编辑 .env，确认 NAS_WEBDAV=Z:/juguang（你的 WebDAV 挂载点）
```

**本机每次开发完**（一行命令）：

```bash
npm run deploy -- "feat: 你的改动说明"
# 自动：git add + commit + push origin dev + WebDAV 复制到 Z:/juguang
```

**NAS 终端**（每次本机跑完 deploy 后）：

```bash
bash /vol1/1000/juguang/deploy.sh
# 自动：docker compose build --no-cache + up -d + 健康检查
```

`scripts/deploy.sh`（本机侧）和 `deploy.sh`（NAS 侧）各自负责一段；两者解耦是因为 fnOS 终端用户不在 docker group，用了 `sudo`。

## 文件结构

```
juguang/
├─ package.json              # 零 dependencies，纯启动脚本
├─ server/
│  ├─ index.mjs              # HTTP 入口 + 路由注册（~590 行）
│  ├─ db.mjs                 # node:sqlite 表结构（admins / tracks / devices /
│  │                          #   playback_state / sessions / zones / playlists）
│  ├─ auth.mjs               # scrypt 密码 + 自管 session
│  ├─ scheduler.mjs          # 同步调度核心：play/pause/resume/stop/seek/next/prev、
│  │                          #   mode（顺序/单曲/随机/循环）、zone CRUD、playlist CRUD
│  ├─ ws.mjs                 # 自实现 WebSocket + Hub（zone-scoped broadcast）
│  ├─ multipart.mjs          # 自实现 multipart/form-data 解析（1GB 上限）
│  ├─ audio-probe.mjs        # MP3 / WAV 时长探测（MP3 首帧 bitrate 推算 CBR 准 VBR 近似；WAV 读 RIFF data/byteRate）
│  └─ init-admin.mjs         # 初始化管理员 CLI
├─ web/                      # 零构建，直接静态托管
│  ├─ index.html             # 聆听页 /
│  ├─ admin.html             # 管理页 /admin（四象限布局：左上管理tab / 右上播放器 / 左下上传+曲库 / 右下队列）
│  ├─ sync.js                # 同步客户端核心（NTP + Web Audio API）
│  └─ styles.css             # 设计系统（Apple Music 风格：纯白 + #ff2d55）
├─ scripts/
│  ├─ deploy.sh              # 本机一键部署：git + WebDAV（bash / git bash）
│  └─ deploy.cmd             # Windows cmd 原生 shim
├─ data/                     # 运行时数据（gitignore）
│  ├─ audio/                 # 上传的音频文件
│  └─ app.db                 # SQLite（首次启动自动建表）
├─ Dockerfile                # node:24-alpine + tini + curl
├─ docker-compose.yml        # 标准部署
├─ docker-compose.fnOS.yml   # fnOS Docker UI 简化版
├─ .env / .env.example       # 端口、时区、WebDAV 路径（.env 不入库）
├─ .dockerignore / .gitignore
├─ README.md                 # 本文件
└─ CLAUDE.md                 # 开发规范、命令速查、模块速查
```

## REST API

所有受保护接口（管理操作）需先 `POST /api/auth/login` 拿 `juguang.sid` cookie。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 + 服务端 IP |
| GET | `/api/auth/me` | 当前登录状态 |
| POST | `/api/auth/login` / `logout` | 登录 / 登出 |
| GET | `/api/tracks` | 列出全部曲目 |
| POST | `/api/tracks` | 上传（multipart，多文件，单文件 ≤1GB） |
| PATCH | `/api/tracks/:id` | 改标题 / 艺人 |
| DELETE | `/api/tracks/:id` | 删除（连带文件） |
| GET | `/api/devices` | 全部设备 |
| GET | `/api/zones/:zoneId/devices` | 该分区设备 |
| PATCH | `/api/devices/:id` | 改名 / 调音量 / 移分区 |
| DELETE | `/api/devices/:id` | 移除（关 WS） |
| GET | `/api/zones` | 全部分区 + snapshot |
| POST | `/api/zones` | 新建分区 |
| PATCH | `/api/zones/:id` | 改名 |
| DELETE | `/api/zones/:id` | 删除（非内置） |
| GET | `/api/zones/:zoneId/snapshot` | 该分区播放快照 |
| POST | `/api/zones/:zoneId/playback/play` | 播放（`{trackId, offsetMs?}`） |
| POST | `/api/zones/:zoneId/playback/pause` / `resume` / `stop` / `prev` / `next` / `seek` | |
| PATCH | `/api/zones/:zoneId/playback/mode` | 模式：`sequential` / `loop-one` / `shuffle` / `loop-all` |
| POST | `/api/zones/:zoneId/queue/enqueue` / `replace` / `clear` | 队列操作 |
| POST | `/api/zones/:zoneId/queue/load-playlist` | 用歌单替换队列 |
| GET | `/api/playlists` | 全部歌单 |
| POST | `/api/playlists` | 新建歌单 |
| GET | `/api/playlists/:id/tracks` | 歌单曲目 |
| POST | `/api/playlists/:id/tracks` | 加曲（`{trackIds}`） |
| PATCH | `/api/playlists/:id` | 改名 |
| DELETE | `/api/playlists/:id` / `/tracks/:trackId` | 删歌单 / 从歌单移曲 |
| GET | `/audio/:filename` | 静态音频（支持 Range） |
| WS | `/ws` | 设备注册 + zone-scoped 调度广播 |

旧路径 `/api/playback/...` 和 `/api/queue/...` 仍可用，内部走 zone=1。下个大版本删除。

## 同步原理

服务端调度器是事实唯一来源。客户端只听命令，不传时钟。

1. **NTP 风格时钟同步**：每 2s 客户端 ping 服务端，取最近 10 次 RTT 最小 3 次的 offset 中位数作为本地-服务端时钟差。
2. **预约调度**：`play` 命令带 `startServerTime = now + PRELOAD_MS`（默认 1500ms 预加载缓冲），客户端换算到本地时刻精确 `start()`。
3. **漂移修正**：每 1.5s 比对应播位置 vs 实播位置：30–200ms 用 ±0.3% 速率追平（持续 1.5s 后回 1），>200ms 回到期望位置前 100ms 让音频自然追（避免"扑通"声）。
4. **中途加入**：新连接拿到 snapshot 时算投影位置 + 新 `startServerTime`，避免进度跳变。

可调旋钮：
- `server/scheduler.mjs` `PRELOAD_MS`（默认 1500，慢端可再调高）
- `web/sync.js` `PING_INTERVAL_MS`（默认 2000，可调到 1000 加快收敛）
- `web/sync.js` `DRIFT_CHECK_MS`（默认 1500，更小更平滑但 CPU 多）
- `web/sync.js` 漂移阈值 30/200ms，按现场实测

## 设计

- **设计语言**：Apple Music 风格（纯白 + #ff2d55 强调色 + SF Pro 字体 + 8px 网格 + 28px 大圆角）
- **管理端布局**：四象限单屏（2×2 grid）
  - 左上：设备 / 歌单 / 分区 三 tab 管理（渐变背景，无弹窗）
  - 右上：现在播放 hero + 进度条 + 全套控件（上一首 / 快退 / 暂停 / 继续 / 快进 / 下一首 / 停止）+ 模式切换（顺序 / 单曲 / 随机 / 循环）
  - 左下：上传 + 曲库列表
  - 右下：当前队列（可拖拽排序）
- **聆听端**：单设备单 zone；展示 zone 标签、漂移、RTT、时钟差、本机音量

## 验收清单

```bash
curl http://localhost:3000/api/health   # → {ok: true}
```

浏览器端按顺序：

- [ ] `/admin` 用 admin 登录、上传一首 MP3 看到曲库列表
- [ ] 另开标签打开 `/`，输入设备名加入广播；admin 选歌 ▶ 能听到声音
- [ ] **同时打开两个浏览器标签作为两个聆听端**，admin 播同一首歌，目测相位差 < 80ms（必要时录音软件测）
- [ ] iPhone Safari 接入同 WiFi 打开 `http://<服务器 IP>:3000/`，加入广播，与电脑同步
- [ ] admin 暂停 / 继续 / 切歌 / 拖拽队列 / 切模式，所有终端动作一致
- [ ] 单独调某个设备音量，不影响其它设备
- [ ] 客户端断 WiFi 5s 再连，自动重连并追到当前进度
- [ ] ≥5 分钟的歌，结尾各端漂移仍 < 80ms
- [ ] 多分区：在 zone=1 和 zone=2 各放不同歌，跨区互不影响
- [ ] 歌单：创建歌单、加曲、改名、载入队列

## 已知限制

- **时长探测**：MP3 / WAV 准确；M4A / AAC / OGG / FLAC 直接返 0，前端 `<audio>` metadata 兜底
- **同步精度**：流式 HTMLAudioElement 播放（非 AudioBufferSource 整文件解码，避免大文件内存溢出），位置靠 currentTime + 漂移修正，非采样级精确；目标 < 80ms 相位差
- **session 不续期**：只检查 `expires_at`，长时间不操作会突然掉登录
- **iOS Safari 后台 / 锁屏**：AudioContext 暂停，需保持页面前台
- **HTTPS**：生产部署需前置反代（如 Caddy / Nginx / fnOS FN Connect）
- **文件级鉴权**：`/audio/*` 拿到文件名即可下载，无 token 校验

## 后续

- 定时广播 / BGM 调度（cron）
- Android 原生客户端（Kotlin + ExoPlayer + Foreground Service）
- mDNS 自动发现服务端

---

## License

MIT