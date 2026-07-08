# 聚光广播 · 安卓客户端开发环境 & APK 编译指南

> 配套阅读：[`docs/android-port-guide.md`](./android-port-guide.md)（协议层 / 时钟同步 / 漂移 / 音量的算法级文档）
> 本文档讲 Android 侧的开发环境、代码组织、出包、分发。**服务端协议不变**，Android 是单纯的客户端实现。

---

## 0. 一句话总览

**TV 和手机共用一套 Kotlin 代码 + ExoPlayer（Media3）**，分两个 productFlavor（或两个 module）编译成两个 APK：

- 手机版：Compose Material 3 + 系统音量拉杆
- TV 版：Leanback + D-Pad + 全屏播放

协议层 100% 复用 `android-port-guide.md` §1 的复用边界——`shared/` module 装协议，UI 各自实现。

核心工具栈：

| 工具 | 版本 |
|---|---|
| Android Studio | Ladybug 或更新 |
| JDK | 17（Studio 自带，不要单独装） |
| Android SDK Platform | 34（compileSdk / targetSdk） |
| Build Tools | 34+ |
| Kotlin | 1.9+ |
| Gradle | 8.x |
| ExoPlayer (Media3) | 1.4.1 |
| OkHttp | 4.12.0 |

---

## 1. 环境准备

### 1.1 必装工具

| 工具 | 用途 | 安装方式 | 验证命令 |
|---|---|---|---|
| **Android Studio** | IDE + SDK 管理 + 签名 + 模拟器 | [官网下载](https://developer.android.com/studio) | 启动后能进 Settings 看到 SDK |
| **JDK 17** | Gradle / Kotlin 编译 | Studio 自带，**别**装到环境变量里跟别的 JDK 冲突 | Studio → Settings → Build, Execution, Deployment → Build Tools → Gradle → Gradle JDK = 17 |
| **Android SDK Platform 34** | compileSdk / targetSdk | Studio → SDK Manager → SDK Platforms 勾 Android 34 | `ls $ANDROID_HOME/platforms/android-34` |
| **Build Tools 34+** | aapt2 / d8 / zipalign | 装 Platform 34 时自动勾选 | `which aapt2` |
| **Platform Tools（adb）** | 安装 APK / 看 logcat | SDK Manager → SDK Tools 勾选 | `adb --version` |
| **Android TV 系统镜像**（可选） | TV 版模拟器 | SDK Manager → SDK Tools → 勾 "Android TV" Intel/ARM 镜像 | Studio AVD Manager 选 TV 设备 |

### 1.2 OneDrive 坑

**Android Studio 项目必须放在 OneDrive 之外**（比如 `D:\dev\juguang-android`）。原因：

- Gradle 缓存 + build 产物 5GB+，OneDrive 同步会拖死编译
- `.gradle/` / `build/` / `.idea/` 不可能精细 ignore
- 长路径 + Windows 锁文件，NIO 报错率上升

建议：juguang 主仓（服务端 + web）继续放 OneDrive；安卓客户端**单开独立仓库** `juguang-android` 放 D 盘下。

### 1.3 测试设备

- **手机**：自己的安卓机，开"开发者模式"+"USB 调试"，USB 连电脑，`adb devices` 能看到
- **TV / 小米电视**：开"ADB 调试"（小米路径：账户与安全 → ADB调试），`adb connect <电视IP>:5555` 无线连；或 USB 接双公头 USB 线接电视 service 口
- **TV 模拟器**（不想折腾真机时用）：Studio AVD Manager → New Device → Category: TV → 选 1080p 或 4K 模板

### 1.4 关键依赖

`app/build.gradle.kts`：

```kotlin
dependencies {
    // ExoPlayer (Media3) — 协议层文档指定
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.4.1")  // Range 请求更稳
    implementation("androidx.media3:media3-session:1.4.1")             // 前台服务 + MediaSession

    // WebSocket — OkHttp 自带客户端，自动回协议层 pong（§9 要求）
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // TV 专用
    "leanbackImplementation"("androidx.leanback:leanback:1.0.0")

    // 手机用 Compose
    implementation(platform("androidx.compose:compose-bom:2024.xx.xx"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.x")

    // 协程 — 时钟同步 / WS 收发 / setTimeout 替代
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.x")
}
```

---

## 2. 项目结构

### 2.1 多 module 仓库

```
juguang-android/                          ← 新仓库，D:\dev 下，不进 OneDrive
├─ settings.gradle.kts
├─ build.gradle.kts                       ← 根 Gradle（plugins 声明）
├─ gradle.properties                      ← android.useAndroidX=true
├─ local.properties                       ← sdk.dir（不进 git）
├─ gradle/wrapper/                        ← gradle wrapper 锁版本
├─ keystore/                              ← 签名 jks（不进 git，备份到 1Password）
│  └─ juguang-release.jks
├─ shared/                                ← 共享 module：协议 / 时钟 / 播放器抽象
│  ├─ build.gradle.kts
│  └─ src/main/kotlin/com/juguang/shared/
│     ├─ protocol/
│     │  ├─ MessageCodec.kt              ← WS 消息 JSON 编解码
│     │  ├─ Constants.kt                 ← android-port-guide.md §10 参数表复刻
│     │  └─ Models.kt
│     ├─ clock/
│     │  └─ NtpClock.kt                  ← §3 NTP 式时钟同步
│     └─ player/
│        ├─ PlayerEngine.kt              ← ExoPlayer 抽象接口
│        └─ DriftController.kt           ← §5 漂移修正（1500ms 周期）
├─ app-mobile/                            ← 手机 module
│  ├─ build.gradle.kts
│  └─ src/main/
│     ├─ AndroidManifest.xml
│     ├─ kotlin/com/juguang/client/
│     │  ├─ MainActivity.kt
│     │  ├─ SyncEngine.kt                ← 协议层核心（§2-5 翻译）
│     │  ├─ WebSocketClient.kt           ← OkHttp WS
│     │  ├─ PlayerEngineImpl.kt          ← ExoPlayer 封装 + §7 音量 ramp
│     │  ├─ VolumeRamp.kt                ← 100ms 平滑
│     │  ├─ ReportLoaded.kt              ← §9 metadata 加载耗时上报
│     │  ├─ PlaybackService.kt           ← 前台服务（§9 AudioFocus + WakeLock）
│     │  └─ ui/                          ← Compose 屏
│     └─ res/
└─ app-tv/                                ← TV module
   ├─ build.gradle.kts                   ← leanback + TV banner
   └─ src/main/
      ├─ AndroidManifest.xml             ← <uses-feature android:name="android.software.leanback"/>
      ├─ kotlin/com/juguang/tv/
      │  ├─ MainActivity.kt              ← BrowseSupportFragment
      │  └─ ui/                          ← TV 专用 Compose
      └─ res/
```

### 2.2 `shared/` 是协议层的 single source of truth

`android-port-guide.md` §10 参数表（`PING_INTERVAL_MS=2000`、`DRIFT_CHECK_MS=1500`、`SEEK_THRESHOLD_MS=100` 等）在 `shared/.../Constants.kt` 复刻为 Kotlin 常量，**不**从 web 端 import。改协议时先改文档，再改 Kotlin。

---

## 3. APK 编译

### 3.1 Debug APK（开发自测，1 分钟）

**Studio 鼠标流**：
1. 顶栏选 `app-mobile`（或 `app-tv`）作为 active module
2. Build → Build Bundle(s) / APK(s) → Build APK(s)
3. 弹窗点 "locate"，打开 `app-mobile/build/outputs/apk/debug/app-mobile-debug.apk`

**命令行**（CI 友好）：
```bash
cd D:\dev\juguang-android
.\gradlew.bat :app-mobile:assembleDebug
# 产物：app-mobile/build/outputs/apk/debug/app-mobile-debug.apk

.\gradlew.bat :app-tv:assembleDebug
# 产物：app-tv/build/outputs/apk/debug/app-tv-debug.apk
```

**安装到设备**：
```bash
# USB 连手机
adb devices                                    # 确认设备在线
adb install -r app-mobile/build/outputs/apk/debug/app-mobile-debug.apk

# TV 无线（小米电视）
adb connect 192.168.1.200:5555                 # 替换为电视实际 IP
adb install -r app-tv/build/outputs/apk/debug/app-tv-debug.apk

# 看 logcat（过滤 Juguang 标签）
adb logcat -s Juguang:* SyncEngine:* PlayerEngine:*

# 卸载
adb uninstall com.juguang.client
```

### 3.2 Release APK（真用户，5 分钟）

**Step 1：生成签名 keystore**（首次做一次，永久复用）

Android Studio → Build → Generate Signed Bundle / APK → 选 APK → Create new... → 填：

- Key store path：`D:\dev\juguang-android\keystore\juguang-release.jks`
- Password：强密码（存 1Password / Bitwarden，**别**明文存项目里）
- Alias：`juguang`
- Validity：10000 天（27 年）
- First and Last Name：填你名字或公司名

或者命令行：
```bash
keytool -genkey -v -keystore D:\dev\juguang-android\keystore\juguang-release.jks ^
  -keyalg RSA -keysize 2048 -validity 10000 -alias juguang
```

**jks 一定备份到云盘 / 密码管理器**——丢了就发不了新版。

**Step 2：配 signingConfigs**（`app-mobile/build.gradle.kts` 和 `app-tv/build.gradle.kts` 都加）

```kotlin
android {
    signingConfigs {
        create("release") {
            storeFile = file("../keystore/juguang-release.jks")
            storePassword = System.getenv("JUGUANG_STORE_PWD") ?: ""
            keyAlias = "juguang"
            keyPassword = System.getenv("JUGUANG_KEY_PWD") ?: ""
        }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = true          // R8 混淆 / 缩包
            isShrinkResources = true
            signingConfig = signingConfigs.getByName("release")
        }
    }
}
```

> 密码用环境变量注入，别写死 build.gradle。CI / 本地都从 shell / Studio Run Config 里设。

**Step 3：编译**

```bash
# 一次性出两个 APK
.\gradlew.bat :app-mobile:assembleRelease :app-tv:assembleRelease
# 产物：
# app-mobile/build/outputs/apk/release/app-mobile-release.apk
# app-tv/build/outputs/apk/release/app-tv-release.apk
```

### 3.3 AAB（Google Play 上架，1 分钟）

国内不走 Google Play（小米电视用 U 盘装、微信群扫码装），**两个 APK 就够了**。如要上 Google Play：

```bash
.\gradlew.bat :app-mobile:bundleRelease
# 产物：app-mobile/build/outputs/bundle/release/app-mobile-release.aab
```

---

## 4. 分发渠道

| 渠道 | TV | 手机 | 做法 |
|---|---|---|---|
| 小米电视 | ✅ 主力 | — | 装"小白文件管理器"，APK 放 U 盘插电视；或 `adb install` 推 |
| 微信群 | — | ✅ 主力 | APK 传群文件，群里点开装（首次"未知来源"需手动允许） |
| 自建 OTA | 备用 | 备用 | 服务端 `data/` 落 APK + `versionCode`，app 启动拉 `/api/app-version` 弹升级 |
| `adb` 直装 | 调试 | 调试 | `adb install -r xxx.apk` |

**签名一致是 OTA 升级的前置条件**——同一 keystore 签的 APK 才能覆盖装，否则系统当成不同 app 装两次。jks 备份就是为这个。

---

## 5. 跟现有项目（juguang 主仓）的关系

| 关注点 | 决定 |
|---|---|
| 仓库放哪 | **新建独立仓库** `juguang-android`，不进 juguang 主仓（OneDrive + Gradle 缓存不可调和） |
| 协议层参考 | `docs/android-port-guide.md` 是事实文档，**逐函数翻译** `web/sync.js` |
| 服务端改动 | **零**——`server/ws.mjs` 协议对 `kind` 不敏感，`android-tv` / `android-phone` 都按现有 register 流程 |
| 共享常量 | 文档 §10 参数表是 single source of truth，Android 端在 `shared/Constants.kt` 复刻，**不要**从 web 端 import |
| WebDAV / Docker 部署 | 安卓客户端发布流程不沾 WebDAV，跟 NAS 部署完全解耦 |
| 鉴权 | 当前 `/audio/*` 无 token 校验，URL 拿到即可下——**内网限定**；若要走公网需先在服务端加签名 URL（`index.mjs` `serveStatic` 改造） |

---

## 6. 第一次动手的最小路径（30 分钟跑通"真机起播同步"）

> 跟 juguang 服务端当初"先 WebSocket ping 通再调时钟差"是同一个迭代节奏——**先跑通再补全**。

1. 装 Android Studio Ladybug，开新 project "Empty Activity"，minSdk=24，targetSdk=34
2. 加 Media3 + OkHttp + 协程依赖到 `app/build.gradle.kts`（§1.4）
3. 抄 `android-port-guide.md` §3 的 `NtpClock`（~30 行）+ §2.2 register + §2.3 play 接收 + §4 预约起播，共 ~150 行 Kotlin
4. `.\gradlew.bat :app-mobile:assembleDebug` + `adb install -r ...` + admin 网页选歌 → 手机出声
5. 然后才回过头补：
   - §5 漂移修正（1500ms 周期）
   - §7 音量 ramp（100ms 平滑，避免蓝牙 DAC 咔声）
   - §9 `reportLoaded` 上报（让服务端按慢设备拉长 preload）
   - §9 前台服务 + WakeLock（锁屏不断流）
   - §8 竞态处理（世代计数器 + onPlayerError 重试）
   - WS 自动重连（1500ms）

---

## 7. 出问题先查这几条

| 现象 | 大概率根因 | 排查 |
|---|---|---|
| 编译报 `JAVA_HOME` | Studio 自带 JDK 没被识别 | Settings → Build Tools → Gradle → Gradle JDK 显式选 17 |
| `adb devices` 看不到 | 手机没开 USB 调试 / 驱动没装 | 换根数据线；装厂商 USB 驱动（小米 / 华为各自有） |
| TV 装完 `adb install` 报 `INSTALL_FAILED_OLDER_SDK` | TV 系统版本低于 minSdk | 调 minSdk 到 21 或装个旧 TV |
| ExoPlayer 起播有"咔"声 | `setVolume` 阶跃 | 走 §7 音量 ramp |
| 多设备相位差 ≥ 200ms | 时钟同步没收敛 / 时钟源用了 `uptimeMillis` | 改用 `SystemClock.elapsedRealtime()` + `currentTimeMillis()` 基准换算（§3） |
| 服务端 30s 把 app 判离线 | 协议层 ping 没回 | 确认用 OkHttp WS（自动回 pong），不要自己写 WS 库 |
| 锁屏 5s 后无声 | 没起前台服务 | 加 `PlaybackService` + `MediaSession`（§9） |
| 二次安装报"签名不一致" | keystore 换了 | 用同一 jks 重签；装新版前 `adb uninstall` 旧版 |

---

## 8. 跟 CLAUDE.md 的衔接

juguang 主仓 `CLAUDE.md` 描述的是**服务端 + web** 的开发规范（git 工作流、命令速查、验证流程）。安卓客户端在独立仓库，`juguang-android/CLAUDE.md` 应自行约定：

- Active module 切换（`app-mobile` vs `app-tv`）
- 签名密钥管理（环境变量 + jks 路径）
- 设备测试流程（adb 无线 / TV 模拟器）
- 协议常量同步节奏（先改 `android-port-guide.md`，再改 `shared/Constants.kt`）

写安卓时遇到的服务端问题（WS 协议 / 调度器行为 / 缓存策略）回主仓查 `docs/` 即可。
