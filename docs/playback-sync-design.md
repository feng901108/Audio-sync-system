# 聚光广播 · 播放同步技术总结

> 一份给"未来要继续动这块代码的人或 AI"的笔记。聚焦**为什么这么选**和**踩过的坑**,不重复 `android-port-guide.md` 里的"复刻步骤"。
>
> 范围:服务端调度 → 客户端播放 → 多端同步 → 漂移修正。**不含** Web UI、设备管理、上传、Zone CRUD 等业务功能。

---

## 0. 一句话定位

**服务端是事实唯一来源**,客户端只听命令、不传时钟。所有同步都靠"服务端把同一时刻发给所有客户端,客户端各自换算到本地时刻动作"。

---

## 1. 技术路线(选型 + 为什么)

### 1.1 服务端:Node.js ≥ 22.5 + 内置 `node:sqlite` + 零依赖

| 选择 | 替代方案 | 选它的理由 |
|---|---|---|
| Node.js + `node:sqlite` | Python + SQLite / Go + SQLite / Postgres | 零系统依赖,fnOS Docker 直接跑;`node:sqlite` 是同步 API 性能足够(单 zone 单调度器);WebSocket 库自己实现即可 |
| 自实现 WS(RFC6455) | `ws` 库 | 项目整体零依赖原则;协议层就 4 个客户端消息 + 5 个服务端消息,实现量 < 200 行 |
| 自实现 multipart 解析 | `multer` / `busboy` | 单文件上传场景简单,自实现避免依赖;支持 1GB 上限(用流式写盘 + `Content-Length` 校验) |
| 自管 session(scrypt) | JWT / Express-session | 不需要跨域 SSO;scrypt 是 Node 内置,cookie 带过期即可 |
| 自实现音频探测 | ffprobe | MP3 / WAV 覆盖 99% 场景;ffprobe 引入大依赖不划算 |

### 1.2 前端:原生 HTML + ES Module + Web Audio API

| 选择 | 替代方案 | 选它的理由 |
|---|---|---|
| 零构建(直接 `<script type="module">`) | Vite / Webpack | 服务端已经托管静态文件,零构建省一道工序;改动直接 `cp` 即可生效(但 docker 镜像要 rebuild) |
| `<audio>` + `createMediaElementSource` | `AudioBufferSourceNode` 整文件解码 | 300MB 白噪音整段解码会 OOM;`<audio>` 走 HTTP Range 边下边播,内存峰值 < 10MB |
| 自实现 NTP 时钟同步 | `timesync` 库 | 算法就 10 行:median(最小 RTT 的 offset),没必要引依赖 |
| `playbackRate` 微调 | 音频时间拉伸(Web Audio `playbackRate`) | **踩坑:这是断音的根因,见 §5.2** |

### 1.3 协议边界

```
浏览器 /admin     ─┐
                  ├─ HTTP(管理) + WebSocket(实时调度)
浏览器 /          ─┤
                  ├─ HTTP(音频 Range 流式)
Android App(规划) ─┘
```

- **HTTP**: 管理类操作(CRUD、上传、登录)走 REST
- **WebSocket `/ws`**: 设备注册 + 实时调度广播(play/pause/seek/stop/setVolume)
- **HTTP Range**: 音频流式下载,服务端 `serveStatic` 支持 206 Partial Content

---

## 2. 核心逻辑

### 2.1 时钟同步(NTP 风格)

**问题**: 客户端本地时间和服务端时间不同步,服务端说"现在播 30 秒"客户端不知道对应本地几点。

**算法**:

```
t0 = 客户端发 ping 时刻
t1 = 服务端收 ping 时刻(放在 pong 里)
t2 = 客户端收 pong 时刻

rtt    = t2 - t0
offset = (t1 - t0 + (t1 - t2)) / 2 = t1 - (t0+t2)/2
                ↑ 服务端时刻 - 客户端 RTT 中点

→ 采样入队,保留最近 10 个
→ 取 RTT 最小 3 个的 offset 中位数(剔除排队抖动 + 极端值)
```

**收敛策略**: 开头连发 5 个 burst(100ms 间隔)快速收敛,然后 2s 一次正常轮询。

**关键**: 取最小 RTT 不是中位 RTT——最小 RTT 最接近真实单程延迟,中位 RTT 会被排队拖慢污染。

### 2.2 预约起播

**问题**: 多设备同时收到 `play` 消息,但消息到达各设备的时刻不一样,直接 `play()` 会造成几十到几百 ms 的相位差。

**解决**: `play` 消息带一个**未来时刻**,各设备在该时刻(各自换算到本地)同时 `play()`。

```
服务端 play() {
  startServerTime = Date.now() + 1500ms  // PRELOAD_MS,给客户端预留加载 + buffer 填充时间
  broadcast({type: "play", startServerTime, ...})
}

客户端 _startTrack() {
  localTargetMs = startServerTime - clockOffset
  delay = max(0, localTargetMs - Date.now())
  setTimeout(play, delay)
}
```

**为什么不是用"收到消息立刻播"**: 网络传播延迟不可控(同 WiFi 下不同设备的延迟差异可达 100ms+),用未来时刻吸收这个差异。

**为什么 PRELOAD_MS = 1500**: 经验值。需要覆盖 `audio.src = url` 后的 metadata 加载 + 浏览器起播启动延迟(< 500ms 通常足够,1500 留余量)。

### 2.3 中途加入

**问题**: 设备 B 在播放开始 30 秒后才加入,服务端如何让 B 立即对齐到当前进度?

**解决**: 服务端在 `register` 后,如果有正在播的曲目,**投影**出一条 fresh `play` 消息下发:

```
newStart           = Date.now() + PRELOAD_MS
projectedOffsetMs  = snap.trackOffsetMs + max(0, newStart - snap.startServerTime)
```

设备 B 收到这条 play 后走正常 `_startTrack()`,自动落在当前进度上。**客户端无需任何追赶代码**。

### 2.4 漂移修正

**问题**: 时钟同步只能保证"开始播的时刻一致",但播放过程中各设备时钟漂移率不同(温度、晶振精度),几分钟后相位差会越来越大。

**方案演进**(踩坑史):

| 版本 | 方案 | 问题 |
|---|---|---|
| v1 | 直接 seek 到期望位置 | 大跳跃(几百 ms 到几秒)有"扑通"声 |
| v2 | ±0.5% playbackRate 微调(200ms 阶跃) | 蓝牙/外置 DAC 上有可闻咔嗒声 |
| v3 | ±0.3% playbackRate + 1500ms 长持续 | **仍有 DAC 重锁咯噔声(本次根因,见 §5.2)** |
| **v4(当前)** | **完全去掉 playbackRate,单阈值 seek** | DAC 不再周期性重锁 |

**当前方案**(`web/sync.js`):

```js
每 1.5s 检查一次:
  actualSec   = audio.currentTime
  expectedSec = (serverNow() - startServerTime)/1000 + trackOffsetMs/1000
  driftMs     = (actualSec - expectedSec) * 1000

  if |driftMs| ≥ 100:
    audio.currentTime = expectedSec - 0.1  // 回退 100ms 让音频自然追上对齐点
    冷却 1000ms(避免 seek 未完成时再次触发)
  else:
    不动(接受小漂移,人耳对 < 80ms 不敏感)
```

**为什么回退 100ms 再 seek**: 直接跳到 `expectedSec` 时,跳跃是几百 ms 到几秒,听感是"扑通";回退 100ms 让音频自己推进到对齐点,听感是连续播放(只是稍微快了 100ms),几乎无感。

**为什么接受 < 100ms 漂移**: 人耳对 < 80ms 相位差基本不敏感(< 50ms 完全无感,50-80ms 极少数人能察觉);且 100ms 是单方向漂移累积几分钟的结果,触发频率低。

### 2.5 流式播放

**问题**: 300MB 白噪音整段解码会 OOM;但又不希望用户等下载完才播放。

**方案**: `<audio>` + `createMediaElementSource`:

```js
audio = new Audio();
audio.preload = "metadata";  // 只预载头部元数据,不预载音频数据
audio.src = "/audio/xxx.mp3";
mediaNode = ctx.createMediaElementSource(audio);  // audio engine 接进 Web Audio graph
mediaNode.connect(gain);                          // 音量走 gain
gain.connect(ctx.destination);                    // 输出

// 浏览器自动按需 Range 拉数据,边下边播,内存峰值 < 10MB
```

**服务端配合**: `serveStatic` 检测到 `Range` 头则返 206 Partial Content + `Content-Range`,否则返 200 全量。

### 2.6 两层音量

**问题**: admin 想"只在小米电视上小声放,其它设备正常音量",不能一刀切全网调小。

**方案**: master × local:

```
masterVolume  ← 服务端 setVolume 消息下发(0-1,admin 调的)
localVolume   ← 本机用户拉杆(0-1)
gain.gain.value = master × local
```

admin 调某设备音量只影响该设备(服务端 `sendTo(deviceId, setVolume)` 单播);用户拉本机音量只影响本机(localStorage 持久化)。

### 2.7 Zone 隔离

服务端调度器每 zone 一份状态,WS Hub 按 zoneId 过滤广播:

```js
// server/scheduler.mjs: zones = Map<zoneId, {advanceTimer}>
// server/ws.mjs: hub.broadcastToZone(zoneId, msg) 只发给该 zone 的连接
```

设备切 zone 走 admin `PATCH /api/devices/:id {zoneId}`,服务端 `hub.setDeviceZone` 改映射。

### 2.8 模式切换

服务端 `next()` 根据 `mode` 字段决定下一首要播的:

```
mode = "sequential"  → 队列头 + 弹出
mode = "loop-one"    → 重播当前
mode = "shuffle"     → 随机选(排除当前)
mode = "loop-all"    → 队头 + 当前曲移到队尾
```

客户端只收结果(`play` 消息),不参与模式判断。

### 2.9 竞态处理

| 场景 | 处理 |
|---|---|
| 快速切歌,旧 src 的 `loadedmetadata` 回调晚到 | **世代计数器 `_gen`**: 每次 `_startTrack` 自增,旧回调校验 `gen !== this._gen` 直接 return |
| 元数据在监听器注册前到达导致 `begin` 永不执行 | **先 addEventListener 再设 src** |
| seek 未完成时又判定漂移触发二次 seek | **`_seekCooldownUntil`** 屏蔽 1000ms |
| `play()` 被 autoplay policy 拒绝 | catch + `isPlaying = false` 状态回滚,避免 UI 显示播放中却无声 |
| setInterval 异常 | try/catch,不让 unhandled rejection 打断循环 |

---

## 3. 关键参数速查

| 参数 | 值 | 位置 | 说明 |
|---|---|---|---|
| `PRELOAD_MS` | 1500 | `server/scheduler.mjs` | 服务端预约起播延迟预算 |
| `PING_INTERVAL_MS` | 2000 | `web/sync.js` | 时钟同步周期 |
| `PING_BURST_COUNT` | 5 | 同上 | 收敛期连发数 |
| `PING_BURST_INTERVAL_MS` | 100 | 同上 | 收敛期间隔 |
| 时钟采样窗口 | 10 | 同上 | 最近 N 次采样 |
| 最小 RTT 取数 | 3 | 同上 | 用于算 offset 中位数 |
| `DRIFT_CHECK_MS` | 1500 | 同上 | 漂移检查周期 |
| `SEEK_THRESHOLD_MS` | 100 | 同上 | 漂移 ≥ 此值才 seek |
| `SEEK_BACK_MS` | 100 | 同上 | seek 前回退,让音频自然追 |
| `SEEK_COOLDOWN_MS` | 1000 | 同上 | seek 后屏蔽漂移检查 |
| `STALE_MS` | 30000 | `server/ws.mjs` | 清理僵尸连接(>30s 无帧) |
| `SWEEP_INTERVAL_MS` | 5000 | 同上 | 服务端扫描间隔 |

---

## 4. 数据流总览

```
admin 点击 ▶ (HTTP POST /api/zones/1/playback/play)
   ↓
scheduler.play(zoneId, trackId)
   ├─ 写 DB(playback_state)
   ├─ broadcastToZone(zoneId, {type: "play", startServerTime: now+1500, ...})
   └─ scheduleAdvance(zoneId, duration, startServerTime, offsetMs)
            ↓ setTimeout(next, remain+50)

所有 zone=1 的客户端 WS 收到 {type: "play"}
   ↓
SyncClient._handle("play")
   ↓
_startTrack(...)
   ├─ 若 trackUrl 变了:注册 loadedmetadata 监听 + audio.src = url + audio.load()
   ├─ seek 到 trackOffsetMs
   └─ setTimeout(play(), max(0, startServerTime - clockOffset - now))
            ↓
   audio.play() → 浏览器按需 Range 拉数据 → 边下边播

持续中:
   每 2s ping 一次 → 算 offset
   每 1.5s drift 检查 → 若 |drift| ≥ 100ms 则 seek 回退 100ms

曲终:
   audio.onended = () => {}   // 不动
   ↓ (服务端 scheduleAdvance 到时)
scheduler.next(zoneId)
   ├─ 看 mode 决定下一首
   └─ play(zoneId, nextTrack) → 再次 broadcast play 消息 → 循环
```

---

## 5. 已解决的问题(经验沉淀)

### 5.1 seek 跳跃的"扑通"声

**症状**: 大漂移时直接 `audio.currentTime = expectedSec`,跳跃几百 ms 到几秒,听感是"咯噔一下"。

**解决**: seek 前回退 100ms,让音频自己推进到对齐点(`expectedSec - 0.1s` → 自然播到 `expectedSec`)。听感从"咯噔"变"微微加速"。

### 5.2 playbackRate 微调造成的周期性断音 ⭐本次根因⭐

**症状**: 用户报告"播放还是一断一断的,小文件也开始断了"。

**排查过程**(第一性):
1. 小文件也断 → 不是 buffer underrun,是音频引擎本身的问题
2. 排查 `web/sync.js` 周期触发点 → `_drift()` 每 1.5s 跑一次,触发 `playbackRate = 0.997`
3. 查 `audio.playbackRate = x` 在浏览器底层的行为:
   - Web Audio 内部重新调度 audio thread
   - 浏览器和音频硬件协商 sample rate
   - **蓝牙/外置 DAC 重新锁定 LPCM** → 锁定期间输出静音 → 听感"咯噔"
4. **关键判断**: 不是幅度问题(±0.3% vs ±0.5%),是**触发动作本身**。任何 `playbackRate` 改变都会触发 DAC 重锁。
5. 周期吻合: 1.5s 触发一次 = 1.5s 咯噔一次,与用户感受到的"持续断音"完全对应。

**解决**: 完全去掉 `playbackRate` 路径,改成单一 seek 阈值 100ms。DAC 不再周期性重锁 → 断音消失。

**教训**:
- 不要为了"平滑"引入副作用更大的机制;**最简单的方案常常最好**
- ±0.5% / ±0.3% 这种"精细调整"在硬件面前无意义,DAC 不会感知到你的"精细"
- 调试"听感问题"要先怀疑周期触发的副作用,再怀疑数据问题

### 5.3 设备列表"幽灵条目"

**症状**: 设备只加入了一次,但 devices 表里一直有记录。

**原因**: WS 断线(浏览器关、网络抖)后,服务端只标记连接死亡,没清 devices 表的行。重启后看到一堆"上次在场的设备"。

**解决**:
- 后端已有 `DELETE /api/devices/:id` 接口(删除时断开 WS + 删行)
- 前端设备面板改成**活跃 / 历史两段**:活跃 = WS 在线,历史 = 曾经连过但现在离线(可一键删除)

### 5.4 多端起播时刻差异

**症状**: 两台设备同时收到 play 消息,但 `play()` 时刻差 100ms+。

**原因**: WS 消息到达两台设备的时刻不一样(网络传播 + 浏览器事件循环调度)。

**解决**: 用 `startServerTime = now + 1500ms`,各设备用各自 clock offset 换算到本地,setTimeout 到该时刻再 play。网络传播差(几十 ms)被 setTimeout 吸收。

### 5.5 流式播放内存爆

**症状**: 上传 300MB 白噪音,播放时浏览器 OOM。

**原因**: 之前考虑过 `AudioBufferSourceNode`(整文件解码),但 300MB / 4byte × 2ch = 150M samples 解码 + 内存驻留直接爆。

**解决**: 改用 `<audio>` + `createMediaElementSource` + `preload="metadata"`。浏览器按需 Range 拉数据,内存峰值 < 10MB。

---

## 6. 当前局限 / 待优化

### 6.1 iOS Safari 后台限制

- **现象**: iPhone Safari 切后台或锁屏后,`AudioContext` 暂停,音频停播
- **解决方向**: 提示用户保持页面前台;长期方案是 Android 原生客户端(Foreground Service)
- **临时绕过**: 暂不支持 PWA 后台播放(Web App 限制)

### 6.2 session 不续期

- **现象**: admin 长时间(>24h)不操作后,session 过期,突然掉登录
- **解决方向**: 加 sliding expiration(每次请求刷新 expires_at)

### 6.3 文件级鉴权缺失

- **现象**: `/audio/xxx.mp3` 拿到 URL 直接能下载,无 token 校验
- **解决方向**: 加签名 URL(临时 token + 过期时间),或 admin 鉴权中间件

### 6.4 M4A / FLAC 时长探测返回 0

- **现象**: 这些格式服务端探测不出 duration,前端依赖 `<audio>` metadata 兜底,服务端 scheduleAdvance 不触发(不自动 next)
- **解决方向**: 接 ffprobe(引入依赖),或客户端探测完发回服务端补字段

### 6.5 同步精度非采样级

- **现象**: 当前精度取决于 `audio.currentTime`(HTMLAudioElement 的位置估算,有几十 ms 抖动)
- **接受范围**: 项目目标 < 80ms 相位差,流式播放足够;若要采样级精确需改 AudioWorklet + AudioBufferSourceNode(放弃流式)

### 6.6 缺 HTTPS

- **现象**: 当前 HTTP 部署,WS 是 `ws://`,浏览器对非 HTTPS 站点的 AudioContext 自动播放有限制
- **解决方向**: 前置 Caddy / Nginx / fnOS FN Connect 终结 TLS

---

## 7. 待办 / 未来方向

| 优先级 | 项目 | 备注 |
|---|---|---|
| P1 | Android 原生客户端(Kotlin + ExoPlayer + Foreground Service) | 移植指南 `docs/android-port-guide.md` 已就绪 |
| P2 | 定时广播 / BGM 调度(cron 风格) | admin 加定时规则,服务端 cron 触发 play |
| P3 | mDNS 自动发现服务端 | 客户端无需手填 IP |
| P3 | HTTPS + 签名 URL | 解决安全 + iOS autoplay |
| P4 | 多人协作(多 admin 同时控制) | 当前 scheduler 无并发保护,简单锁即可 |
| P4 | 歌词同步(LRC 解析) | 客户端 UI 加歌词显示 |

---

## 8. 相关文件索引

| 关注点 | 看哪个文件 | 关键段 |
|---|---|---|
| 客户端全套参考实现 | `web/sync.js` | `SyncClient`(_handle / _startTrack / _drift) |
| 服务端 WS 协议 + 中途加入投影 | `server/ws.mjs` | `handleUpgrade` |
| 播放状态机 + 模式 + 调度 advance | `server/scheduler.mjs` | `play` / `pause` / `resume` / `stop` / `seek` / `next` / `prev` / `snapshot` / `scheduleAdvance` |
| 音频流 + Range | `server/index.mjs` | `serveStatic` |
| WS Hub + Zone 隔离 | `server/ws.mjs` | `Hub` 类 |
| 安卓移植步骤 | `docs/android-port-guide.md` | 全篇 |
| REST API + 命令速查 | `README.md` / `CLAUDE.md` | 路由清单 + 模块速查 |