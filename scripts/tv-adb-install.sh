#!/bin/bash
# 小米电视 ADB 一键安装脚本（在电脑上执行）
# 用法: bash tv-adb-install.sh <电视IP> [NAS_IP]

set -e

TV_IP="${1:-}"
NAS_IP="${2:-192.168.1.100}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ -z "$TV_IP" ]; then
    echo -e "${YELLOW}用法: bash tv-adb-install.sh <电视IP> [NAS_IP]${NC}"
    echo "例如: bash tv-adb-install.sh 192.168.1.200 192.168.1.100"
    exit 1
fi

echo -e "${GREEN}=== 小米电视 snapclient 一键安装 ===${NC}"
echo "电视 IP: $TV_IP"
echo "NAS  IP: $NAS_IP"
echo ""

# 检查 ADB
echo -e "${GREEN}[1/5] 检查 ADB 工具...${NC}"
if ! command -v adb &> /dev/null; then
    echo -e "${RED}错误: 未找到 ADB 工具${NC}"
    echo "请安装 Android SDK Platform Tools:"
    echo "  macOS: brew install android-platform-tools"
    echo "  Linux: sudo apt install adb"
    exit 1
fi

# 连接电视
echo -e "${GREEN}[2/5] 连接电视...${NC}"
adb connect "$TV_IP:5555"

# 检查连接
if ! adb devices | grep -q "$TV_IP"; then
    echo -e "${RED}错误: 无法连接到电视，请确认：${NC}"
    echo "  1. 电视已开启 ADB 调试"
    echo "  2. 电视和电脑在同一局域网"
    echo "  3. 电视 IP 地址正确"
    exit 1
fi

echo -e "${GREEN}电视连接成功！${NC}"

# 下载 Termux
echo -e "${GREEN}[3/5] 下载 Termux...${NC}"
TERMUX_APK="/tmp/termux.apk"
TERMUX_BOOT_APK="/tmp/termux-boot.apk"

if [ ! -f "$TERMUX_APK" ]; then
    echo "下载 Termux..."
    wget -q "https://f-droid.org/repo/com.termux_118.apk" -O "$TERMUX_APK" || {
        echo -e "${YELLOW}警告: 无法下载 Termux，请手动下载后放置到 /tmp/termux.apk${NC}"
    }
fi

if [ ! -f "$TERMUX_BOOT_APK" ]; then
    echo "下载 Termux:Boot..."
    wget -q "https://f-droid.org/repo/com.termux.boot_1000.apk" -O "$TERMUX_BOOT_APK" || {
        echo -e "${YELLOW}警告: 无法下载 Termux:Boot，请手动下载后放置到 /tmp/termux-boot.apk${NC}"
    }
fi

# 安装 Termux
echo -e "${GREEN}[4/5] 安装 Termux 到电视...${NC}"
if [ -f "$TERMUX_APK" ]; then
    adb install -r "$TERMUX_APK" || echo -e "${YELLOW}Termux 安装失败或已安装${NC}"
fi

if [ -f "$TERMUX_BOOT_APK" ]; then
    adb install -r "$TERMUX_BOOT_APK" || echo -e "${YELLOW}Termux:Boot 安装失败或已安装${NC}"
fi

# 推送并执行配置脚本
echo -e "${GREEN}[5/5] 配置 snapclient...${NC}"

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP_SCRIPT="$SCRIPT_DIR/tv-termux-setup.sh"

if [ ! -f "$SETUP_SCRIPT" ]; then
    echo -e "${RED}错误: 找不到 tv-termux-setup.sh 脚本${NC}"
    echo "请确保 tv-termux-setup.sh 与 tv-adb-install.sh 在同一目录"
    exit 1
fi

# 推送脚本到电视
adb push "$SETUP_SCRIPT" /sdcard/Download/tv-termux-setup.sh

# 设置 NAS_IP 环境变量并执行脚本
adb shell "export NAS_IP=$NAS_IP && bash /sdcard/Download/tv-termux-setup.sh"

echo ""
echo -e "${GREEN}=== 安装完成！==="
echo ""
echo "电视将在开机后自动启动 snapclient"
echo ""
echo "如需手动控制，可以通过 ADB 连接电视后执行："
echo "  adb shell 'bash /data/data/com.termux/files/home/.snapclient-start.sh'"
echo ""
echo "查看日志："
echo "  adb shell 'cat /data/data/com.termux/files/home/.snapclient.log'"
echo -e "${NC}"
