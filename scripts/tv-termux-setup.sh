#!/data/data/com.termux/files/usr/bin/bash
# 小米电视 Termux + snapclient 预配置脚本
# 此脚本通过 ADB 推送到电视后在 Termux 中执行
# 无需在电视上手动操作终端

set -e

NAS_IP="${NAS_IP:-192.168.1.100}"

echo "=== 小米电视 snapclient 自动配置 ==="
echo "NAS IP: $NAS_IP"
echo ""

# 1. 更新源
echo "[1/6] 更新软件源..."
pkg update -y

# 2. 安装必要组件
echo "[2/6] 安装必要组件..."
pkg install -y wget curl proot-distro pulseaudio

# 3. 安装 Debian
echo "[3/6] 安装 Debian 发行版..."
if ! proot-distro list | grep -q "debian"; then
    proot-distro install debian
else
    echo "Debian 已安装，跳过"
fi

# 4. 在 Debian 中安装 snapclient
echo "[4/6] 安装 snapclient..."
proot-distro login debian << DEBIAN_EOF
set -e
apt update
apt install -y wget pulseaudio

ARCH=\$(dpkg --print-architecture)
VERSION="0.34.0-1"
DEB_URL="https://github.com/badaix/snapcast/releases/download/v0.34.0/snapclient_\${VERSION}_\${ARCH}_bookworm.deb"

if ! wget "\$DEB_URL" -O /tmp/snapclient.deb 2>/dev/null; then
    wget "https://github.com/badaix/snapcast/releases/download/v0.34.0/snapclient_\${VERSION}_\${ARCH}.deb" -O /tmp/snapclient.deb
fi

apt install -y /tmp/snapclient.deb
rm -f /tmp/snapclient.deb
DEBIAN_EOF

# 5. 创建启动脚本
echo "[5/6] 创建启动脚本..."
START_SCRIPT="$HOME/.snapclient-start.sh"

cat > "$START_SCRIPT" << EOF
#!/data/data/com.termux/files/usr/bin/bash
NAS_IP="$NAS_IP"

# 启动 PulseAudio
if ! pulseaudio --check 2>/dev/null; then
    pulseaudio --start
    sleep 1
fi

# 启动 snapclient
proot-distro login debian -- bash -c "export PULSE_SERVER=127.0.0.1 && snapclient -h \$NAS_IP"
EOF

chmod +x "$START_SCRIPT"

# 6. 配置开机自启
echo "[6/6] 配置开机自启..."
BOOT_DIR="$HOME/.termux/boot"
mkdir -p "$BOOT_DIR"

cat > "$BOOT_DIR/start-snapclient.sh" << EOF
#!/data/data/com.termux/files/usr/bin/bash
echo "[\$(date)] 启动 snapclient..." >> \$HOME/.snapclient.log
sleep 15
bash \$HOME/.snapclient-start.sh >> \$HOME/.snapclient.log 2>&1 &
EOF

chmod +x "$BOOT_DIR/start-snapclient.sh"

echo ""
echo "=== 配置完成 ==="
echo "电视将在开机后自动启动 snapclient"
echo "日志文件: $HOME/.snapclient.log"
