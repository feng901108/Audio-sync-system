#!/data/data/com.termux/files/usr/bin/bash
# Termux 一键安装 snapclient 脚本
# 使用方法：在 Termux 中执行 bash termux-install.sh <NAS_IP>

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# NAS IP 参数
NAS_IP="${1:-}"

if [ -z "$NAS_IP" ]; then
    echo -e "${YELLOW}未提供 NAS IP 地址${NC}"
    echo "用法: bash termux-install.sh <NAS_IP>"
    echo "例如: bash termux-install.sh 192.168.1.100"
    echo ""
    read -p "请输入 NAS 的 IP 地址: " NAS_IP
fi

if [ -z "$NAS_IP" ]; then
    echo -e "${RED}错误: 必须提供 NAS IP 地址${NC}"
    exit 1
fi

echo -e "${GREEN}=== Termux snapclient 安装脚本 ===${NC}"
echo "NAS IP: $NAS_IP"
echo ""

# 1. 更新源
echo -e "${GREEN}[1/7] 更新软件源...${NC}"
pkg update -y

# 2. 安装必要组件
echo -e "${GREEN}[2/7] 安装必要组件...${NC}"
pkg install -y wget curl proot-distro pulseaudio

# 3. 安装 Debian
echo -e "${GREEN}[3/7] 安装 Debian 发行版...${NC}"
if ! proot-distro list | grep -q "debian"; then
    proot-distro install debian
else
    echo "Debian 已安装，跳过"
fi

# 4. 在 Debian 中安装 snapclient
echo -e "${GREEN}[4/7] 在 Debian 中安装 snapclient...${NC}"
proot-distro login debian << DEBIAN_EOF
set -e

echo "更新 Debian 源..."
apt update

echo "安装依赖..."
apt install -y wget pulseaudio

echo "下载 snapclient..."
ARCH=\$(dpkg --print-architecture)
VERSION="0.34.0-1"
DEB_URL="https://github.com/badaix/snapcast/releases/download/v0.34.0/snapclient_\${VERSION}_\${ARCH}_bookworm.deb"

# 如果下载失败，尝试备用 URL
if ! wget "\$DEB_URL" -O /tmp/snapclient.deb 2>/dev/null; then
    echo "尝试备用下载地址..."
    # 备用：直接下载通用二进制
    wget "https://github.com/badaix/snapcast/releases/download/v0.34.0/snapclient_\${VERSION}_\${ARCH}.deb" -O /tmp/snapclient.deb
fi

echo "安装 snapclient..."
apt install -y /tmp/snapclient.deb

# 清理
rm -f /tmp/snapclient.deb

echo "Debian 环境配置完成"
DEBIAN_EOF

# 5. 创建启动脚本
echo -e "${GREEN}[5/7] 创建启动脚本...${NC}"
START_SCRIPT="$HOME/.snapclient-start.sh"

cat > "$START_SCRIPT" << EOF
#!/data/data/com.termux/files/usr/bin/bash
# snapclient 启动脚本
# 自动生成，请勿手动修改

NAS_IP="$NAS_IP"

# 启动 PulseAudio
if ! pulseaudio --check 2>/dev/null; then
    echo "启动 PulseAudio..."
    pulseaudio --start
    sleep 1
fi

# 启动 snapclient
echo "连接 snapserver: \$NAS_IP..."
proot-distro login debian -- bash -c "export PULSE_SERVER=127.0.0.1 && snapclient -h \$NAS_IP"
EOF

chmod +x "$START_SCRIPT"

# 6. 配置开机自启
echo -e "${GREEN}[6/7] 配置开机自启...${NC}"
BOOT_DIR="$HOME/.termux/boot"
mkdir -p "$BOOT_DIR"

cat > "$BOOT_DIR/start-snapclient.sh" << EOF
#!/data/data/com.termux/files/usr/bin/bash
# Termux:Boot 自动启动脚本

echo "[\$(date)] 启动 snapclient..." >> /data/data/com.termux/files/home/.snapclient.log

# 等待网络就绪
sleep 10

# 启动 snapclient
bash /data/data/com.termux/files/home/.snapclient-start.sh >> /data/data/com.termux/files/home/.snapclient.log 2>&1 &
EOF

chmod +x "$BOOT_DIR/start-snapclient.sh"

# 7. 创建快捷命令
echo -e "${GREEN}[7/7] 创建快捷命令...${NC}"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/snapstart" << EOF
#!/data/data/com.termux/files/usr/bin/bash
bash \$HOME/.snapclient-start.sh
EOF
chmod +x "$BIN_DIR/snapstart"

cat > "$BIN_DIR/snapstop" << EOF
#!/data/data/com.termux/files/usr/bin/bash
pkill -f snapclient
EOF
chmod +x "$BIN_DIR/snapstop"

# 添加到 PATH（如果还没有）
if ! grep -q "$BIN_DIR" "$HOME/.bashrc" 2>/dev/null; then
    echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$HOME/.bashrc"
fi

echo ""
echo -e "${GREEN}=== 安装完成！==="
echo ""
echo "使用方法："
echo "  snapstart  - 启动 snapclient"
echo "  snapstop   - 停止 snapclient"
echo ""
echo "配置信息："
echo "  NAS IP: $NAS_IP"
echo "  启动脚本: $START_SCRIPT"
echo "  开机自启: $BOOT_DIR/start-snapclient.sh"
echo ""
echo "注意："
echo "  1. 安装 Termux:Boot 应用以实现开机自启"
echo "  2. 关闭电池优化防止 Termux 被杀后台"
echo "  3. 在 Snapweb (http://$NAS_IP:1780) 中校准延迟"
echo -e "${NC}"
