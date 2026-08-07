# PiliPark Music · 局域网多音箱音频同步系统

一套基于 **Snapcast + Mopidy + FastAPI** 的家庭音乐同步播放方案：在 NAS 上部署一个服务端，家里所有设备（手机、电视、电脑、音箱）登录播放端即可**毫秒级同步播放同一首歌**，且每个设备可独立控制自己的播放/暂停与音量。

```
                        ┌─────────────────────────────────────┐
                        │           NAS (Docker)              │
                        │  ┌───────────────────────────────┐  │
                        │  │  music-sync  (FastAPI:8765)   │  │  ← 控制面板 + 前端
                        │  │   · /api/*  MPD 控制           │  │
                        │  │   · /ws     状态广播           │  │
                        │  │   · /stream  音频流代理        │  │
                        │  │   · /snapweb 反向代理          │  │
                        │  └──────────┬────────────────────┘  │
                        │            │ MPD:6600                │
                        │  ┌─────────▼─────────────────────┐ │
                        │  │  mopidy  (解码 + 写 FIFO)      │ │
                        │  └─────────┬─────────────────────┘ │
                        │            │ /audio/snapcast_fifo   │
                        │  ┌─────────▼─────────────────────┐ │
                        │  │  snapserver  (时间戳分发)      │ │
                        │  │  TCP:1704  HTTP:1780           │ │
                        │  └─────────┬─────────────────────┘ │
                        └────────────┼───────────────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
       ┌───────▼──────┐      ┌────────▼──────┐      ┌────────▼──────┐
       │ snapclient   │      │ snapclient    │      │ 浏览器(tv.html)│
       │ (手机/电视)  │      │ (电脑/树莓派) │      │ Web Audio 播放 │
       └──────────────┘      └───────────────┘      └───────────────┘
```

## 核心特性

- **毫秒级同步**：Snapcast 自研时间锚定 + 动态重采样，多设备延迟差 < 100ms
- **一服务多终端**：NAS 部署一次，任意设备打开浏览器即可播放
- **三种播放端**：
  - `index.html` —— 左右分栏控制面板（左：播放控制 + 曲目列表；右：SnapWeb 音箱管理）
  - `tv.html` —— 极简全屏封面播放界面（电视 / 手机友好，内置 Web Audio 客户端，OLED 屏幕保护）
  - 原生 `snapclient` —— 最高同步精度的硬件播放终端
- **浏览器即播放**：`tv.html` 内置 Web Audio API 解码 PCM 流，无需安装任何客户端即可发声
- **状态实时同步**：后端每秒广播播放状态，刷新页面后进度自动从 localStorage 恢复，不会重置
- **跨设备独立控制**：TV 端只控制自己设备的音频，不影响其他设备
- **OLED 屏幕保护**：极光流动背景、封面呼吸动画、60 秒无操作自动暗屏
- **SnapWeb 深色主题**：通过 HTML 注入 CSS，让 SnapWeb 与控制面板视觉统一

## 目录结构

```
.
├── server/                    # FastAPI 后端（控制面板 + WebSocket 同步 + SnapWeb 代理）
│   └── main.py
├── player/                    # 前端界面（无构建步骤，纯静态）
│   ├── index.html             # 左右分栏控制面板（Vue 3 CDN）
│   └── tv.html                # 极简全屏播放界面（vanilla JS，电视/手机友好）
├── config/                    # 服务配置
│   ├── snapserver/snapserver.conf
│   └── mopidy/mopidy.conf
├── kodi-plugin/snapcast/      # Kodi 插件（启动 snapclient）
├── scripts/                   # 部署 / 安装脚本
│   ├── nas-deploy.sh          # NAS 一键部署（旧版三服务架构）
│   ├── scan-library.sh        # 扫描音乐库
│   ├── termux-install.sh      # Android 手机/Termux 安装 snapclient
│   ├── tv-adb-install.sh      # 通过 ADB 给小米电视安装 Termux + snapclient
│   └── tv-termux-setup.sh     # 电视端 Termux 配置（被 tv-adb-install.sh 调用）
├── docs/                      # 额外文档
├── Dockerfile                 # music-sync 镜像构建
├── docker-compose-sync.yml   # ★ 推荐部署：snapserver + mopidy + music-sync 三件套
├── docker-compose.yml         # 简化版（仅 snapserver + mopidy，用于调试）
└── .env.example               # 环境变量示例
```

## 快速开始

### 前置条件

- 一台支持 Docker 的 NAS（或任何 Linux 服务器），已安装 `docker` 和 `docker compose`
- 音乐文件放在 NAS 的某个目录（示例：`/vol1/1000/音乐`）
- 播放终端与 NAS 在同一局域网

### 一、部署服务端（NAS）

#### 1. 克隆仓库

```bash
git clone https://github.com/feng901108/Audio-sync-system.git
cd Audio-sync-system
```

#### 2. 配置环境变量

```bash
cp .env.example .env
# 按实际路径修改
cat > .env <<'EOF'
TZ=Asia/Shanghai
MUSIC_DIR=/vol1/1000/音乐
EOF
```

`MUSIC_DIR` 指向 NAS 上的音乐库根目录，会以只读方式挂载到 mopidy 与 music-sync 容器内。

#### 3. 启动三个服务

```bash
docker compose -f docker-compose-sync.yml up -d --build
```

首次启动会自动构建 `music-sync:latest` 镜像并拉取 `snapcast` / `mopidy` 镜像。

#### 4. 扫描音乐库

```bash
docker compose -f docker-compose-sync.yml exec -T mopidy mopidy local scan
```

扫描完成后，音乐库会出现在控制面板左侧曲目列表中。

#### 5. 访问服务

| 地址 | 说明 |
|------|------|
| `http://<NAS_IP>:8765/` | 控制面板（左右分栏） |
| `http://<NAS_IP>:8765/tv.html` | 极简全屏播放界面（电视/手机） |
| `http://<NAS_IP>:8765/snapweb/` | SnapWeb 音箱管理（已注入深色主题） |
| `http://<NAS_IP>:1780/` | SnapWeb 原生界面（未注入主题） |
| `http://<NAS_IP>:6600/` | MPD 协议端口（供外部 MPD 客户端连接） |

### 二、播放端使用

#### 方案 A：浏览器即播放（最简单，推荐电视/手机）

直接在电视或手机浏览器打开：

```
http://<NAS_IP>:8765/tv.html
```

- 首次点击屏幕：启动 mopidy 播放 + 本地 Web Audio 解码音频流
- 再次点击：暂停 / 继续本地播放（不影响其他设备）
- 60 秒无操作自动进入暗屏模式（OLED 屏幕保护）
- 刷新页面后进度从 localStorage 恢复，不会重置

> 浏览器自动播放策略要求**用户首次交互后**才能发声，因此必须手动点击屏幕一次。

#### 方案 B：原生 snapclient（最高同步精度）

**Android 手机 / Termux：**

```bash
bash scripts/termux-install.sh <NAS_IP>
# 安装完成后：
snapstart   # 启动 snapclient
snapstop    # 停止
```

**小米电视（通过 ADB 一键安装）：**

在电脑上执行：

```bash
bash scripts/tv-adb-install.sh <电视IP> <NAS_IP>
# 例：bash scripts/tv-adb-install.sh 192.168.1.200 192.168.1.100
```

脚本会自动：安装 Termux + Termux:Boot → 推送配置脚本 → 安装 snapclient → 配置开机自启。

**Kodi 设备：**

将 `kodi-plugin/snapcast/` 目录打包为 zip，在 Kodi 中"从 zip 安装插件"，然后在插件设置中填入 `server_ip`（NAS IP）即可。详见 [docs/Kodi插件安装指南.md](docs/Kodi插件安装指南.md)。

**Linux / macOS：**

```bash
# Debian/Ubuntu
sudo apt install snapclient
snapclient -h <NAS_IP>

# macOS
brew install snapcast
snapclient -h <NAS_IP>
```

### 三、日常使用

#### 上传 / 添加新歌

1. 把音乐文件（mp3/flac/m4a 等）放到 `MUSIC_DIR` 目录下
2. 在控制面板点击「重新扫描音乐库」按钮，或执行：
   ```bash
   docker compose -f docker-compose-sync.yml exec -T mopidy mopidy local scan
   ```
3. 刷新控制面板即可看到新曲目

#### 多设备同步播放

1. 在控制面板左侧选歌、点击播放
2. 在 SnapWeb（右侧 iframe）中给每个 snapclient 分配到同一分组
3. 所有同组设备会自动同步播放，延迟差 < 100ms

## 架构详解

### 音频链路

```
mopidy 解码音频 → 写入 FIFO (/audio/snapcast_fifo)
                 ↓
snapserver 读取 FIFO → 打时间戳 → 通过 TCP:1704 分发
                 ↓
snapclient 接收 → 动态重采样 → 本地音频设备播放
```

关键配置（`config/snapserver/snapserver.conf`）：

```ini
[stream]
# 使用 PCM 编码（非 flac），兼容浏览器 Web Audio 解码
stream = pipe:///audio/snapcast_fifo?name=Mopidy&sampleformat=44100:16:2&codec=pcm
```

### 控制链路

```
浏览器 ──HTTP/WS──> music-sync:8765 ──MPD──> mopidy:6600
```

`music-sync` 是纯**控制面板**，不处理音频流。它通过 MPD 协议控制 mopidy 的播放/暂停/切歌/音量，音频数据始终走 snapcast 链路。

### WebSocket 状态同步

- 后端 `state_broadcaster` 每秒查询 MPD 状态并广播给所有前端
- 播放中：每秒广播（前端更新进度条）
- 暂停/停止：只在 track/volume/state 变化时广播
- 前端 `tv.html` 用 localStorage 持久化进度，刷新后立即恢复

### SnapWeb 反向代理

`music-sync` 对 SnapWeb 做全量反向代理（`/snapweb/*`），实现：

- 同源访问，避免跨域
- 在 HTML 响应中注入深色主题 CSS
- 代理 `/jsonrpc` 和 `/stream` WebSocket，让浏览器内 SnapWeb 客户端正常工作

## API 速查

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/state` | 当前播放状态（position/duration/is_playing 等） |
| GET | `/api/tracks` | 完整播放队列 |
| GET | `/api/clients` | snapserver 在线客户端列表（500ms 缓存） |
| GET | `/api/cover?path=<relpath>` | 歌曲封面（找不到则返回 SVG 占位图） |
| POST | `/api/play` | 播放（body 可空；带 `track_idx` 切歌；带 `position` seek） |
| POST | `/api/pause` | 暂停 |
| POST | `/api/next` / `/api/prev` | 下一首 / 上一首 |
| POST | `/api/seek?position=<秒>` | 跳转进度 |
| POST | `/api/volume?volume=<0-100>` | 设置音量 |
| POST | `/api/rescan` | 触发 mopidy 重新扫描音乐库 |
| WS  | `/ws` | 状态广播（每秒推送） |
| WS  | `/stream` | snapserver 音频流（二进制 PCM 帧） |

## 常见问题

**Q：刷新 tv.html 后进度会重置吗？**
A：不会。tv.html 用 localStorage 持久化 `position/duration/track`，刷新后立即用缓存渲染，避免 `0:00` 闪烁；WebSocket 推送真实进度后会平滑过渡。

**Q：tv.html 第一次点击为什么没声音？**
A：浏览器自动播放策略要求用户交互后才允许播放音频。首次点击会同时：① 发送 `/api/play` 启动 mopidy 播放（让音频流通过 snapserver） ② 唤醒 AudioContext ③ 连接 `/stream` WebSocket 接收 PCM 帧。

**Q：tv.html 点击会影响其他设备吗？**
A：不会。`serverPlayRequested` 标志确保只在第一次点击时调用 `/api/play`，后续点击只控制本地 Web Audio 的播放/暂停，不发送任何影响其他设备的 API。

**Q：SnapWeb 里看不到客户端？**
A：需要先在播放设备上启动 snapclient（方案 B）。浏览器端 `tv.html` 不算 snapclient，它直接通过 `/stream` WebSocket 接收音频流。

**Q：CPU 占用很高？**
A：通常是 FIFO 管道权限问题导致 snapserver 读不到数据循环重试，或 mediasrv 服务冲突。确保：
- FIFO 权限为 `prw-rw-rw-`：`chmod 666 /vol1/1000/docker/yinyue/data/audio/snapcast_fifo`
- 停止飞牛 NAS 自带的 mediasrv 服务：`systemctl --user stop mediasrv && systemctl --user disable mediasrv`

**Q：OLED 电视长时间播放会烧屏吗？**
A：tv.html 已内置 OLED 保护：极光背景持续旋转、封面呼吸缩放、所有亮元素都在动；60 秒无操作自动进入暗屏模式（亮度降至 10%）。

## 技术栈

| 组件 | 技术 |
|------|------|
| 后端 | Python 3.12 + FastAPI + uvicorn + python-mpd2 + httpx + websockets |
| 前端（控制面板） | Vue 3 (CDN) + 原生 CSS |
| 前端（TV） | Vanilla JS + Web Audio API + WebSocket |
| 音频引擎 | Mopidy (GStreamer 解码) |
| 同步分发 | Snapcast (snapserver + snapclient) |
| 容器 | Docker + Docker Compose |
| Kodi 插件 | Python (xbmcgui) |

## 开发与调试

### 重新构建 music-sync 镜像

修改 `server/main.py` 或 `player/*` 后：

```bash
docker compose -f docker-compose-sync.yml up -d --build music-sync
```

### 查看日志

```bash
docker compose -f docker-compose-sync.yml logs -f music-sync
docker compose -f docker-compose-sync.yml logs -f mopidy
docker compose -f docker-compose-sync.yml logs -f snapserver
```

### 测试 API

```bash
# 获取状态
curl http://localhost:8765/api/state

# 播放
curl -X POST http://localhost:8765/api/play -H 'Content-Type: application/json' -d '{}'

# 切到第 3 首并跳到 30 秒
curl -X POST http://localhost:8765/api/play -H 'Content-Type: application/json' -d '{"track_idx":2,"position":30}'
```

## 许可证

本项目采用 **MIT License**，完全开源，允许任何人自由使用、复制、修改、合并、发布、分发、再授权或销售。

唯一要求：保留版权声明与许可声明。

所使用的开源组件遵循各自的开源协议：

| 组件 | 协议 |
|------|------|
| [Snapcast](https://github.com/badaix/snapcast) | GPL-3.0 |
| [Mopidy](https://github.com/mopidy/mopidy) | Apache-2.0 |
| [FastAPI](https://github.com/tiangolo/fastapi) | MIT |
| [Vue.js](https://github.com/vuejs/core) | MIT |
| [python-mpd2](https://github.com/Mic92/python-mpd2) | BSD-3-Clause |
| [uvicorn](https://github.com/encode/uvicorn) | BSD-3-Clause |
| [httpx](https://github.com/encode/httpx) | BSD-3-Clause |
| [websockets](https://github.com/python-websockets/websockets) | BSD-3-Clause |

详见 [LICENSE](LICENSE) 文件。
