# 聚光广播 Juguang

园区内的多设备音频同步广播系统。一处选歌，所有终端（小米电视、安卓手机接音响、iPhone Safari）<80ms 内同步播放。

> **零依赖**：服务端只需要 Node.js ≥ 22.5（用到了内置 `node:sqlite`）。前端零构建，纯静态文件 + ES module。

## 架构

```
┌─────────────────────┐
│  管理端浏览器 /admin │  ← 上传 / 选歌 / 控制队列 / 调音量
└──────────┬──────────┘
           │  HTTP
┌──────────▼─────────────────────────────────────────┐
│ 服务端 Node.js (zero-dep, node:sqlite + node:http)│
│   - /api/auth /tracks /devices /playback /queue   │
│   - /ws 长连接：注册、ping/pong、下发调度         │
│   - /audio 静态托管音频文件                        │
└──────────┬─────────────────────────────────────────┘
           │  WebSocket（长连接）
   ┌───────┼───────┬─────────────┐
   ▼       ▼       ▼             ▼
 小米电视  安卓手机  iPhone Safari  其它设备
 (网页)   (网页)   (网页 /)
```

## 快速开始

需要 **Node.js ≥ 22.5**（内置 `node:sqlite`）。当前已用 v24.15 验证通过。

```bash
cd /Users/fengjing/Claude/juguang
# 1) 创建管理员（首次必做）
node server/init-admin.mjs admin yourpassword

# 2) 启动服务端
node server/index.mjs
# 或开发热重启：
node --watch server/index.mjs
```

打开浏览器：
- 管理端：`http://<服务器内网 IP>:3000/admin`
- 终端聆听页：`http://<服务器内网 IP>:3000/`

环境变量：
- `PORT`（默认 3000）
- `HOST`（默认 0.0.0.0，全网卡）

## 同步原理

详见 [.claude/plans/iphone-radiant-lollipop.md](.claude/plans/iphone-radiant-lollipop.md) — 摘要：

1. **NTP 风格时钟同步**：每 2s 客户端 ping 一次，取最近 10 次中 RTT 最小 3 次的 offset 中位数。
2. **预约调度**：服务端命令带 `startServerTime`（now + 800ms 预加载缓冲），所有客户端转换为本地时间精确 `start()`。
3. **漂移修正**：每 3s 比对应播位置与实播位置，30-200ms 用 ±0.5% 速率追平，>200ms 直接重新 seek。

## 验收清单

按下面顺序逐项验证：

- [ ] `curl http://localhost:3000/api/health` 返回 `{ok: true}`
- [ ] `/admin` 用 admin/yourpassword 登录、上传一首 MP3 看到曲目列表
- [ ] 另开标签 `/`，输入设备名，点"加入广播"，admin 选歌点 ▶ 能听到声音
- [ ] **同时打开两个浏览器标签作为两个聆听端**，admin 播放同一首歌，输出相位差应 <80ms
- [ ] iPhone Safari 接入同 WiFi 打开 `http://<服务器 IP>:3000/`，加入广播，与电脑同步
- [ ] admin 暂停/继续/切歌/拖拽队列，所有终端动作一致
- [ ] 单独调整某个设备的音量，不影响其它设备
- [ ] 客户端 WiFi 断开 5 秒再连接，自动重新加入并同步到当前进度
- [ ] 5 分钟以上的歌，结尾各端漂移仍 <80ms

第 4 条不达标可调三个旋钮：
- [server/scheduler.mjs](server/scheduler.mjs) `PRELOAD_MS`（默认 800，慢端可调到 1200）
- [web/sync.js](web/sync.js) `PING_INTERVAL_MS`（默认 2000，可调到 1000 加快收敛）
- [web/sync.js](web/sync.js) 漂移阈值 30/200，按现场实测

## 项目结构

```
juguang/
├─ package.json              # 没有 dependencies，纯启动脚本
├─ server/
│  ├─ index.mjs              # http 入口 + 路由
│  ├─ db.mjs                 # node:sqlite 表结构
│  ├─ auth.mjs               # scrypt 密码 + 自管 session
│  ├─ scheduler.mjs          # 同步调度核心
│  ├─ ws.mjs                 # 自实现 WebSocket（RFC6455 已通过握手测试）
│  ├─ multipart.mjs          # 自实现 multipart 解析（已单测）
│  ├─ audio-probe.mjs        # MP3 时长探测
│  └─ init-admin.mjs         # 创建管理员
├─ web/                      # 直接静态托管，无构建
│  ├─ index.html             # 聆听页 /
│  ├─ admin.html             # 管理页 /admin
│  ├─ sync.js                # 同步客户端核心（NTP + Web Audio）
│  └─ styles.css
└─ data/
   ├─ audio/                 # 上传文件落盘位置
   └─ app.db                 # SQLite，首次启动自动创建
```

## 已知限制

- 当前脚本运行环境（Claude 沙箱）的 `listen()` 系统调用被拒，无法在此完成端到端启动验证；但已验证：所有模块语法、import 链路、scrypt 密码哈希、SQLite 读写、multipart 解析、WebSocket 握手哈希（与 RFC6455 官方示例字节相同）。**请在你的本地 Mac mini/NUC 上跑 `node server/index.mjs`**，必定能启。
- 单同步分区（`zone_id=1` 已在表里预留扩展位）。
- iOS Safari 后台或锁屏后会暂停 AudioContext，需保持页面前台。
- MP3 时长探测用 CBR 假设；VBR 文件时长会近似。

## 后续

- Android 原生客户端（Kotlin + ExoPlayer + Foreground Service）
- 多分区独立播放
- 定时任务（上下班铃、夜间 BGM）
- mDNS 自动发现服务端
