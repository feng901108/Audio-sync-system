#!/bin/bash
# ============================================================
# Snapcast + Mopidy + myMPD 一键部署脚本
# 适用于飞牛 fnOS
# 在 NAS 的 Web 终端中执行: bash nas-deploy.sh
# ============================================================

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 配置
MUSIC_DIR="/vol1/1000/音乐"
DEPLOY_DIR="/vol1/1000/docker/yinyue"
TZ="Asia/Shanghai"

info "开始部署 Snapcast 音频同步系统..."
info "音乐目录: ${MUSIC_DIR}"
info "部署目录: ${DEPLOY_DIR}"

# 检查 Docker
if ! command -v docker &>/dev/null; then
    error "未找到 Docker，请先在飞牛 fnOS 中安装 Docker"
    exit 1
fi
info "Docker 版本: $(docker --version)"

# 检查 Docker Compose
if docker compose version &>/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
elif command -v docker-compose &>/dev/null; then
    COMPOSE_CMD="docker-compose"
else
    error "未找到 Docker Compose，请先安装"
    exit 1
fi
info "Compose: ${COMPOSE_CMD}"

# 创建目录
info "创建部署目录..."
mkdir -p "${DEPLOY_DIR}/config/snapserver"
mkdir -p "${DEPLOY_DIR}/config/mopidy"
mkdir -p "${DEPLOY_DIR}/music"

# 如果音乐目录存在，创建软链接；否则创建空目录
if [ -d "${MUSIC_DIR}" ]; then
    info "音乐目录存在: ${MUSIC_DIR}"
else
    warn "音乐目录 ${MUSIC_DIR} 不存在，将创建"
    mkdir -p "${MUSIC_DIR}"
fi

# 创建 .env 文件
info "创建环境配置..."
cat > "${DEPLOY_DIR}/.env" << EOF
TZ=${TZ}
MUSIC_DIR=${MUSIC_DIR}
EOF

# 创建 docker-compose.yml
info "创建 docker-compose.yml..."
cat > "${DEPLOY_DIR}/docker-compose.yml" << 'COMPOSEEOF'
version: "3.8"

services:
  snapserver:
    image: ghcr.io/badaix/snapcast:latest
    container_name: snapserver
    restart: unless-stopped
    network_mode: host
    user: "0:0"
    volumes:
      - ./config/snapserver:/etc/snapserver
      - snapcast-data:/var/lib/snapserver
      - audio-pipe:/tmp/audio
      - /etc/localtime:/etc/localtime:ro
    environment:
      - TZ=${TZ:-Asia/Shanghai}
    command: snapserver -c /etc/snapserver/snapserver.conf

  mopidy:
    image: mopidy/mopidy:latest
    container_name: mopidy
    restart: unless-stopped
    network_mode: host
    user: "0:0"
    volumes:
      - ./config/mopidy:/etc/mopidy
      - ${MUSIC_DIR:-./music}:/music:ro
      - mopidy-data:/var/lib/mopidy
      - audio-pipe:/tmp/audio
      - /etc/localtime:/etc/localtime:ro
    environment:
      - TZ=${TZ:-Asia/Shanghai}
    command: mopidy --config /etc/mopidy/mopidy.conf
    depends_on:
      - snapserver

  mympd:
    image: ghcr.io/jcorporation/mympd:latest
    container_name: mympd
    restart: unless-stopped
    network_mode: host
    user: "0:0"
    volumes:
      - mympd-data:/var/lib/mympd
      - ${MUSIC_DIR:-./music}:/music:ro
      - /etc/localtime:/etc/localtime:ro
    environment:
      - TZ=${TZ:-Asia/Shanghai}
      - MYMPD_MPD_HOST=127.0.0.1
      - MYMPD_MPD_PORT=6600
      - MYMPD_HTTP_PORT=8080
    depends_on:
      - mopidy

volumes:
  snapcast-data:
  mopidy-data:
  mympd-data:
  audio-pipe:
COMPOSEEOF

# 创建 snapserver 配置
info "创建 Snapserver 配置..."
cat > "${DEPLOY_DIR}/config/snapserver/snapserver.conf" << 'SNAPCONF'
[stream]
stream = pipe:///tmp/audio/snapfifo?name=Mopidy&sampleformat=44100:16:2

[http]
bind_to_address = 0.0.0.0
port = 1780
doc_root = /usr/share/snapserver/snapweb

[tcp]
bind_to_address = 0.0.0.0
port = 1704

[server]
instance = 1
datadir = /var/lib/snapserver
send_to_muted = false

[logging]
filter = *:info

[buffer]
ms = 1000

[streaming]
buffer_ms = 1000
codec = flac
sampleformat = 48000:16:2
chunk_ms = 20

[dir]
data = /var/lib/snapserver
SNAPCONF

# 创建 mopidy 配置
info "创建 Mopidy 配置..."
cat > "${DEPLOY_DIR}/config/mopidy/mopidy.conf" << 'MOPCONF'
[core]
cache_dir = /var/lib/mopidy/cache
config_dir = /etc/mopidy
data_dir = /var/lib/mopidy

[logging]
color = true
console_format = %(levelname)-8s %(message)s
debug_format = %(levelname)-8s %(asctime)s [%(process)d:%(threadName)s] %(name)s\n  %(message)s
debug_file = /var/lib/mopidy/mopidy.log
config_file =

[audio]
mixer = software
mixer_volume =
output = audioconvert ! audioresample ! audio/x-raw,rate=44100,channels=2,format=S16LE ! filesink location=/tmp/audio/snapfifo
buffer_time =

[mpd]
enabled = true
hostname = 0.0.0.0
port = 6600
password =
max_connections = 20
connection_timeout = 60
zeroconf = Mopidy MPD server on $hostname
command_blacklist =
  listall
  listallinfo
default_playlist_scheme = m3u

[http]
enabled = true
hostname = 0.0.0.0
port = 6680
static_dir =
zeroconf = Mopidy HTTP server on $hostname
allowed_origins =
csrf_protection = true

[m3u]
enabled = true
base_dir =
default_encoding = latin-1
default_extension = .m3u8
playlists_dir = /var/lib/mopidy/playlists

[softwaremixer]
enabled = true

[file]
enabled = true
media_dirs =
  /music|Music
excluded_file_extensions =
  .jpg
  .jpeg
  .png
  .gif
  .db
  .m3u
  .m3u8
  .pls
  .cue
  .nfo
show_dotfiles = false
follow_symlinks = false
metadata_timeout = 1000

[local]
enabled = true
media_dir = /music
scan_timeout = 1000
scan_flush_threshold = 100
scan_follow_symlinks = false
included_file_extensions =
excluded_file_extensions =
  .m3u
  .m3u8
  .pls
  .cue
  .jpg
  .jpeg
  .png
  .gif
  .db
  .nfo
directories =
album_art_files =
  *.jpg
  *.jpeg
  *.png

[local-images]
enabled = true
library = json
base_uri = /images/
image_dir =
album_art_files =
  *.jpg
  *.jpeg
  *.png
MOPCONF

# 同时配置 SSH 公钥（方便后续远程管理）
info "配置 SSH 公钥免密登录..."
mkdir -p ~/.ssh
PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAy2hjI3vpLZUUjurskLHQ1MBhoAmexxNOi4917o/IE8 wanchuncms"
if ! grep -q "wanchuncms" ~/.ssh/authorized_keys 2>/dev/null; then
    echo "${PUBKEY}" >> ~/.ssh/authorized_keys
    chmod 600 ~/.ssh/authorized_keys
    info "SSH 公钥已添加"
else
    info "SSH 公钥已存在"
fi

# 启动服务
info "拉取 Docker 镜像并启动服务..."
cd "${DEPLOY_DIR}"
${COMPOSE_CMD} pull
${COMPOSE_CMD} up -d

# 等待服务启动
info "等待服务启动..."
sleep 10

# 检查服务状态
info "检查服务状态..."
${COMPOSE_CMD} ps

# 扫描音乐库
info "扫描音乐库..."
${COMPOSE_CMD} exec -T mopidy mopidy local scan 2>/dev/null || warn "音乐库扫描可能需要手动执行"

echo ""
echo "========================================"
echo -e "${GREEN}部署完成！${NC}"
echo "========================================"
echo ""
echo "服务地址："
echo "  Snapcast 控制台: http://192.168.108.199:1780"
echo "  myMPD 音乐控制:  http://192.168.108.199:8080"
echo "  Mopidy HTTP:      http://192.168.108.199:6680"
echo "  MPD 端口:         192.168.108.199:6600"
echo "  Snapcast 端口:    192.168.108.199:1704"
echo ""
echo "音乐目录: ${MUSIC_DIR}"
echo "部署目录: ${DEPLOY_DIR}"
echo ""
echo "常用命令："
echo "  查看状态: cd ${DEPLOY_DIR} && ${COMPOSE_CMD} ps"
echo "  查看日志: cd ${DEPLOY_DIR} && ${COMPOSE_CMD} logs -f"
echo "  重启服务: cd ${DEPLOY_DIR} && ${COMPOSE_CMD} restart"
echo "  停止服务: cd ${DEPLOY_DIR} && ${COMPOSE_CMD} down"
echo "  扫描音乐: cd ${DEPLOY_DIR} && ${COMPOSE_CMD} exec mopidy mopidy local scan"
echo ""
