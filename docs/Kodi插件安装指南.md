# Kodi Snapcast 插件安装指南

## 概述

本插件允许您在 Kodi 内部运行 Snapcast 客户端，实现多房间音频同步播放。插件提供了美观的配置界面和运行控制功能。

## 插件结构

```
kodi-plugin/snapcast/
├── addon.xml              # 插件元数据
├── main.py                # 主入口和客户端逻辑
└── resources/
    ├── language/
    │   └── resource.language.zh_cn/
    │       └── strings.po  # 中文语言包
    ├── settings/
    │   └── settings.xml    # 设置界面定义
    └── images/
        └── icon.png        # 插件图标
```

## 安装步骤

### 方法一：手动安装（推荐）

1. **压缩插件文件夹**：
   ```bash
   cd /Users/fengjing/Code/YinYue/kodi-plugin
   zip -r snapcast.zip snapcast/
   ```

2. **传输到电视**：
   - 将 `snapcast.zip` 复制到 U 盘或通过网络传输到小米电视

3. **在 Kodi 中安装**：
   - 打开 Kodi → 附加组件 → 从 ZIP 文件安装
   - 选择传输的 `snapcast.zip` 文件

### 方法二：通过文件管理器安装

1. 将 `snapcast` 文件夹复制到 Kodi 的附加组件目录：
   - Android: `/storage/emulated/0/Android/data/org.xbmc.kodi/files/.kodi/addons/`
   - Linux: `~/.kodi/addons/`

2. 重启 Kodi

## 配置插件

1. **打开插件设置**：
   - Kodi → 附加组件 → 程序附加组件 → Snapcast Client → 右键 → 设置

2. **配置项说明**：

   | 配置项 | 说明 | 默认值 |
   |--------|------|--------|
   | 服务器 IP 地址 | Snapcast 服务器（NAS）的 IP | 无 |
   | 服务器端口 | Snapcast 服务端口 | 1704 |
   | 客户端名称 | 此设备在服务器上显示的名称 | 默认 |
   | 延迟补偿 | 音频延迟调整（毫秒） | 无 |
   | 使用 PulseAudio | 是否使用 PulseAudio 播放器 | 否 |
   | 开机自启 | Kodi 启动时自动连接服务器 | 否 |
   | 运行模式 | 服务模式（后台运行）或脚本模式（手动启动） | 服务模式 |

## 使用方法

### 服务模式（推荐）

1. 在设置中启用「开机自启」
2. 重启 Kodi 后，插件会自动连接到 Snapcast 服务器
3. 通过浏览器访问 `http://<NAS_IP>:1780` 控制播放

### 脚本模式

1. 在 Kodi 中找到「Snapcast Client」插件
2. 点击运行，弹出控制界面
3. 使用遥控器操作：启动/停止/切换连接

## 注意事项

### snapclient 二进制文件

插件需要系统中已安装 `snapclient` 二进制文件。有以下几种方式：

**方式一：通过 Termux 安装（推荐）**

1. 在电视上安装 Termux：https://f-droid.org/packages/com.termux/
2. 打开 Termux，执行：
   ```bash
   pkg update && pkg upgrade -y
   pkg install snapcast -y
   ```

**方式二：手动下载二进制**

1. 下载适合 Android 的 snapclient 二进制：
   - https://github.com/badaix/snapcast/releases

2. 将二进制文件放到以下任一位置：
   - `/data/data/com.termux/files/usr/bin/snapclient`
   - `/usr/bin/snapclient`
   - `/usr/local/bin/snapclient`

### 音频输出设置

确保 Kodi 的音频输出设备设置正确：

1. Kodi → 设置 → 系统 → 音频
2. 设置正确的输出设备
3. 启用「直通」模式（可选）

## 故障排除

### 插件无法启动

1. 检查服务器 IP 地址是否正确
2. 检查 NAS 上的 Snapcast 服务是否运行：
   ```bash
   docker compose ps
   ```

### 没有声音

1. 检查 snapclient 是否正常运行：
   ```bash
   ps | grep snapclient
   ```

2. 检查音频输出设备：
   - 在 Kodi 设置中确认音频输出设备

3. 检查延迟补偿设置：
   - 尝试调整延迟补偿值

### 同步问题

1. 打开 `http://<NAS_IP>:1780`
2. 在客户端列表中微调各设备的 Latency 值
3. 确保所有设备连接到同一网络

## 卸载插件

1. Kodi → 附加组件 → 程序附加组件
2. 找到 Snapcast Client → 右键 → 卸载
