# 聚光广播 · 安卓客户端移植指南（TV + 手机）

> **愿景**：网页 `/admin` 作总控制台（选歌 / 队列 / 分区 / 模式 / 设备音量），安卓设备装上 app 后**自动加入指定分区、自动同步播放**，无需任何手动对齐。
>
> **本文档面向**：后续开发安卓 TV 版、安卓手机版 app 的开发者（人或 AI）。目标是能据此复用现有协议与算法，不重设计、不碰服务端。

---

## 0. 一句话定位

服务端是**事实唯一来源**，客户端只听命令、不传时钟。app 要做的只有四件事：

1. WebSocket 连服务端，`register` 入网
2. NTP 式时钟同步（算本地↔服务端时间差）
3. 收 `play`/`seek`/`pause`/`stop`/`setVolume`，在服务端指定的**未来时刻**精确起播 / 暂停
4. 每 3s 漂移修正（小偏差调速、大偏差 seek）

**装上即同步**靠的是服务端的「中途加入」逻辑：app `register` 后，服务端立刻把当前播放快照投影成一条 fresh `play` 消息下发（见 §2.4），app 照常处理即可追上进度——app 端不需要任何额外追赶代码。

---

## 1. 复用边界（什么要移植、什么不要）

| 模块 | app 要不要 | 说明 |
|---|---|---|
| WebSocket 客户端 | ✅ 要 | 连 `/ws`，按协议收发消息 |
| NTP 时钟同步 | ✅ 要 | §3，必须复刻算法与参数 |
| 预约起播 + 漂移修正 | ✅ 要 | §4 §5，同步精度的核心 |
| 音频流式播放 | ✅ 要 | §6，用 ExoPlayer 走 `/audio` Range |
| 两层音量 | ✅ 要 | §7，master（服务端下发）× local（本机） |
| REST 管理 API | ❌ 不要 | `/api/auth` `/tracks` `/devices` `/zones` `/playlists` `/queue` 是 admin 网页用的，app 不碰 |
| 模式 / 队列 / 歌单逻辑 | ❌ 不要 | 服务端 `scheduler.mjs` 处理，app 只收结果（`play`/`seek`/`pause`/`stop`） |
| 自动切歌 | ❌ 不要 | 服务端 `scheduleAdvance` 到期调 `next` 下发新 `play`，app 不主动切 |
| 设备/分区/曲目 CRUD | ❌ 不要 | admin 管，app 只读自己收到的状态 |

**协议层参考实现**：`web/sync.js`（295 行）逐函数对照——它是浏览器的等价客户端，app 就是把它翻译成 Kotlin/ExoPlayer。

---

## 2. 连接协议（必须复刻）

### 2.1 WebSocket

- URL：`ws://<host>:3000/ws`（HTTPS 部署用 `wss`）
- 连上后**立刻**发 `register`，然后启动 ping 循环
- 断线 1500ms 后自动重连（`web/sync.js` `reconnectTimer`）

### 2.2 客户端 → 服务端

```jsonc
// 入网。deviceId 首次可不带，服务端生成后 hello 回传，app 持久化下次带上
{ "type": "register", "deviceId": "可选", "name": "客厅电视", "kind": "android-tv", "zoneId": 1 }

// 时钟探测。t0 = 客户端发送时刻（epoch ms）
{ "type": "ping", "t0": 1719000000000 }
```

`kind` 自定义（如 `android-tv` / `android-phone`），服务端仅记录用于命名兜底，不影响协议。`zoneId` 是设备要加入的分区；服务端 `ensureDevice` 会尊重它（已存在设备若 `zone_id` 为空才填，否则保留原分区——切分区走 admin `PATCH /api/devices/:id {zoneId}`，见 §9）。

### 2.3 服务端 → 客户端

```jsonc
// 入网回执。serverTime 用于首帧对齐参考；deviceId 要持久化
{ "type": "hello", "deviceId": "a1b2c3d4e5", "zoneId": 1, "serverTime": 1719000000123, "ip": "192.168.1.5" }

// master 音量（0-1），admin 调设备音量时下发
{ "type": "setVolume", "volume": 0.8 }

// 起播 / 跳转。startServerTime 是"未来时刻"，app 在该时刻（换算到本地）起播
{ "type": "play", "zoneId": 1, "trackId": "f0e1..", "trackUrl": "/audio/abc123.mp3",
  "durationMs": 253000, "startServerTime": 1719000001500, "trackOffsetMs": 0 }

// seek 复用 play：同曲、新 trackOffsetMs、新 startServerTime
{ "type": "seek", /* 字段同 play */ }

// 暂停。atServerTime 是未来时刻，app 在该时刻暂停（多设备同时停）
{ "type": "pause", "zoneId": 1, "atServerTime": 1719000000200 }

// 停止。立即停、清状态
{ "type": "stop", "zoneId": 1 }

// 时钟回执。t0 原样回传，t1 = 服务端收到 ping 的时刻
{ "type": "pong", "t0": 1719000000000, "t1": 1719000000080 }
```

### 2.4 中途加入（自动同步的关键，服务端已实现）

`register` 后服务端依次发：`hello` → `setVolume` → （若该 zone 正在播）`play`。

关键：这条 `play` 不是原始的，而是**投影过的**（`server/ws.mjs` `handleUpgrade`）：

```
newStart = Date.now() + PRELOAD_MS                    // 给新设备一个 fresh 起播时刻
projectedOffsetMs = snap.trackOffsetMs + max(0, newStart - snap.startServerTime)  // 已播时长加进来
→ 发 play { startServerTime: newStart, trackOffsetMs: projectedOffsetMs }
```

app 收到后按 §4 正常起播即可，自然落在当前进度上。**无需 app 写任何追赶逻辑**——这就是"装上即同步"的实现路径。

---

## 3. 时钟同步（NTP 式，必须复刻）

### 算法

1. 记 `t0 = now()`，发 `ping {t0}`
2. 收 `pong {t0, t1}`，记 `t2 = now()`
3. `rtt = t2 - t0`
4. `offset = (t1 - t0 + (t1 - t2)) / 2`  ← 即 `t1 - (t0+t2)/2`，服务端时刻减客户端 RTT 中点
5. 采样入队，保留**最近 10 个**
6. 取 RTT **最小的 3 个**，对它们的 offset 取**中位数**作为当前时钟差

> 取最小 RTT 是为了剔除排队/调度抖动——最小 RTT 最接近真实单程延迟。中位数防极端值。

### 收敛策略

- **开头连发 5 个 burst**（100ms 间隔）快速收敛时钟差
- 之后 **2000ms 一次**正常轮询
- `serverNow() = localNow() + offset`

### 参数（复刻用）

| 常量 | 值 | 来源 |
|---|---|---|
| `PING_INTERVAL_MS` | 2000 | `web/sync.js` |
| `PING_BURST_COUNT` | 5 | 同上 |
| `PING_BURST_INTERVAL_MS` | 100 | 同上 |
| 采样窗口 | 10 | 同上 |
| 最小 RTT 取数 | 3 | 同上 |

---

## 4. 预约起播（必须复刻）

收到 `play`/`seek`：

```
gen = ++起播代次                  // 快速切歌时让旧的 loadedmetadata 回调自废（见 §8 世代计数）
若 trackUrl 变了：换源（ExoPlayer setMediaItem），等元数据就绪
seek 到 trackOffsetMs（秒）
localTargetMs = startServerTime - offset
delay = max(0, localTargetMs - now())
setTimeout(delay: {
    若 gen 已变 → return（被更新的 play 取代）
    player.play()
})
```

**多设备同步靠这个"未来时刻起播"，不是靠同时收到消息**——服务端把同一条 `startServerTime` 广播给全 zone，各端各自换算到本地时刻同时起播，网络传播差异被 `delay` 吸收。

`seek` 与 `play` 同处理：服务端 `seek()` 内部就是 `play(zone, sameTrack, newOffset)`。

---

## 5. 漂移修正（必须复刻）

每 `DRIFT_CHECK_MS = 1500ms` 一次：

```
若不在播 / 冷却中 → 只上报 position，不修正
actualSec   = player.currentPosition / 1000
expectedSec = (serverNow() - startServerTime)/1000 + trackOffsetMs/1000
driftMs     = (actualSec - expectedSec) * 1000

|drift| ≥ 200ms → seek 到 expectedSec - 0.1s（回退 100ms 让音频自然追上来），冷却 800ms
30 ≤ |drift| < 200ms → 微调 playbackRate：drift>0 用 1-0.003（慢一点追平），drift<0 用 1+0.003；1500ms 后回 1.0
|drift| < 30ms → 不动
```

> **为什么强 seek 要回退 100ms**：直接跳到 `expectedSec` 在多秒级偏差时会有"扑通"声。回退一点让音频自然推进补齐，听感远更平滑。
>
> **为什么速率微调要"长持续低幅"**：`±0.5%` 在蓝牙/外置 DAC 上阶跃有可闻咔嗒声；`±0.3%` + `1500ms` 长持续让速率变化覆盖整个检查周期，听感平滑而非阶跃。

### 参数

| 常量 | 值 |
|---|---|
| `DRIFT_CHECK_MS` | 1500 |
| `RATE_TWEAK` | 0.003（±0.3%） |
| `RATE_LIMIT_MS` | 1500（微调持续时间，覆盖整个检查周期） |
| 强 seek 阈值 | 200ms |
| 强 seek 回退量 | 100ms（让音频自然追上来） |
| 微调阈值 | 30ms |
| seek 冷却 | 800ms |

---

## 6. 音频流式播放

- `trackUrl = /audio/<filename>`，服务端 `serveStatic` 支持 HTTP **Range**（206 Partial Content），按需分块
- **用 ExoPlayer（Media3）**：原生 Range 缓冲、`setPlaybackParameters` 调速、精准 `seekTo`
- **不要整文件下载再播**：300MB 白噪音会 OOM；边下边播（ExoPlayer 默认行为）
- 时钟基准用 ExoPlayer `currentPosition`（ms），等价 web 的 `audio.currentTime * 1000`
- `preload` 只取头部元数据（web 用 `preload="metadata"`），ExoPlayer 默认不预载全量
- 同源部署不需要 CORS；若走反代跨域，`/audio` 要放行 Range 头

### `onended` 自然播完

服务端 `scheduleAdvance` 在 `duration - offset` 后到时调 `next` 下发新 `play`，app **不主动切歌**。web 端 `audio.onended = () => {}` 空实现——app 也不用监听结束事件驱动状态，等下一条 `play` 即可。

> 注意：`duration <= 0`（M4A/FLAC 等服务端探测不出时长）时服务端**不自动 advance**，靠 admin 手动切。app 端 duration 只用于 UI，不影响同步。

---

## 7. 两层音量

```
masterVolume  ← setVolume 消息下发（0-1，admin 调）
localVolume   ← app 本机用户拉杆（0-1）
实际增益 = masterVolume × localVolume
```

- web 走 Web Audio `gain.gain.value = master * local`
- 安卓：`ExoPlayer.setVolume(master * local)` 一处搞定；或 `AudioManager` 管 STREAM_MUSIC（local）+ ExoPlayer volume（master）——推荐前者，简单且两层语义清晰
- admin 调某设备音量只影响该设备（服务端 `sendTo(deviceId, setVolume)` 单播），其它设备不动

---

## 8. 竞态处理（web 已踩的坑，app 直接避）

1. **世代计数器**（`_gen`）：快速切歌时，旧源的元数据回调可能晚到，用递增代次让旧回调自废——ExoPlayer 用 `setMediaItem` 返回的 sequence 或自增 token 等价实现：每次新 `play` 自增 token，回调里校验 token 一致才执行起播。
2. **先注册监听再设源**：web 先 `addEventListener("loadedmetadata")` 再设 `src`，否则 metadata 在注册前到达导致 `begin` 永不执行。ExoPlayer 设 `MediaItem` 前先挂好 `Player.Listener`。
3. **seek 风暴冷却**：强 seek 后 2s 内屏蔽漂移检查（`_seekCooldownUntil`），否则 seek 未完成时又判定漂移触发二次 seek。
4. **play() 被拒要如实更新状态**：web autoplay policy 拒绝 `play()` 时把 `isPlaying=false`，避免 UI 显示播放中却无声。安卓无 autoplay 限制，但首次播放在后台/无焦点时可能失败，同样要 catch + 状态回滚。
5. **setInterval 要 try/catch**：周期任务里异常别变成 unhandled rejection 打断循环。

---

## 9. 安卓特有（网页没有的坑）

| 项 | 处理 |
|---|---|
| **AudioFocus** | 起播前 `AudioManager.requestAudioFocus(AUDIOFOCUS_GAIN)`；失焦点时本地静音（不改 `isPlaying`，服务端不知情） |
| **前台服务** | 播放期间 Foreground Service + `PowerManager.WakeLock`，否则锁屏/后台 AudioTrack 暂停（等价 iOS Safari 后台限制） |
| **播放器** | ExoPlayer (Media3)，支持 Range 缓冲、`setPlaybackParameters` 调速、精准 `seekTo` |
| **时钟源** | `System.currentTimeMillis()`（epoch ms，对齐服务端 `Date.now()`）；**不要** `SystemClock.uptimeMillis()`（不含休眠） |
| **首次播放** | 无 autoplay 限制，但首次需用户交互启动 Service（否则后台受限） |
| **重连** | WS 断线 1500ms 后重连，重连后 `register` 重新触发 hello + snapshot，自动追上（§2.4） |
| **deviceId 持久化** | 首次不带，服务端生成（hex）回传 hello；存 `SharedPreferences`，下次带上保持身份一致 |
| **切分区** | app 不主动切；admin 调 `PATCH /api/devices/:id {zoneId}`，服务端 `hub.setDeviceZone` 改设备所属 zone，之后只收新 zone 广播 |
| **TV vs 手机** | 协议层完全一致，仅 UI 不同：TV 用 Leanback + D-Pad，手机可加本机音量拉杆 / 设备名输入 |

---

## 10. 关键参数总表（复刻速查）

| 参数 | 值 | 用途 | 来源 |
|---|---|---|---|
| `PRELOAD_MS` | 1500 | 服务端 `startServerTime = now + 1500`，客户端起播延迟预算 | `server/scheduler.mjs` |
| `PING_INTERVAL_MS` | 2000 | 时钟同步轮询 | `web/sync.js` |
| `PING_BURST_COUNT` | 5 | 收敛期连发数 | 同上 |
| `PING_BURST_INTERVAL_MS` | 100 | 收敛期间隔 | 同上 |
| `DRIFT_CHECK_MS` | 1500 | 漂移检查周期 | 同上 |
| `RATE_TWEAK` | 0.003 | 微调速率 ±0.3% | 同上 |
| `RATE_LIMIT_MS` | 1500 | 微调持续时间 | 同上 |
| `HARD_SEEK_BACK_MS` | 100 | 强 seek 前回退量（自然追） | 同上 |
| 漂移阈值 | 30 / 200 ms | 微调 / 强 seek 分界 | 同上 |
| seek 冷却 | 800 ms | 强 seek 后屏蔽漂移 | 同上 |
| 重连间隔 | 1500 ms | WS 断线重连 | 同上 |
| `STALE_MS` | 30000 | 服务端清理僵尸连接（>30s 无帧） | `server/ws.mjs` |
| `SWEEP_INTERVAL_MS` | 5000 | 服务端扫描间隔 | 同上 |

同步目标：多端相位差 **< 80ms**。

---

## 11. 移植验收清单

- [ ] app 启动 → 自动连 WS → `register` → 显示设备名 / 分区 / 在线
- [ ] admin 选歌 ▶ → app 在 `startServerTime` 时刻起播（不是收到消息立刻播）
- [ ] 两台 app + 一台网页聆听端，同曲相位差 < 80ms（录音软件测）
- [ ] admin 暂停 → app 跟随暂停（在 `atServerTime` 时刻）；继续 → 跟随继续
- [ ] admin seek / 上一首 / 下一首 → app 同步跳转
- [ ] app 杀进程重开 → 自动连上、自动追到当前进度（§2.4 中途加入）
- [ ] admin 单独调某设备音量 → 只该设备变，其它不动
- [ ] 锁屏 5s → 前台服务维持播放不断；切分区 → app 收新 zone 广播
- [ ] ≥ 5 分钟曲目，结尾各端漂移仍 < 80ms
- [ ] 客户端断 WiFi 5s 再连 → 自动重连并追到当前进度

---

## 12. 协议来源索引

| 关注点 | 看哪个文件 | 关键函数/段 |
|---|---|---|
| 客户端全套参考实现 | `web/sync.js` | `SyncClient`（connect/_startPing/_clockOffset/_handle/_startTrack/_drift） |
| 服务端 WS 协议 + 中途加入 | `server/ws.mjs` | `handleUpgrade`（register/ping 处理、snapshot 投影） |
| 播放状态机 | `server/scheduler.mjs` | `play`/`pause`/`resume`/`stop`/`seek`/`next`/`prev`/`snapshot`/`scheduleAdvance` |
| 音频流 + Range | `server/index.mjs` | `serveStatic`（206 Partial Content） |
| REST 管理 API（app 不用，仅供理解） | `server/index.mjs` | `route(...)` 全表 |

> 服务端代码**只读理解**即可，不需要移植。app 全部逻辑等价于把 `web/sync.js` 翻译成 Kotlin + ExoPlayer。
