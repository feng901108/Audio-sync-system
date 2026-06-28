#!/usr/bin/env bash
# 聚光广播 · 本机 → NAS 一键部署
#
# 用法：
#   npm run deploy -- "feat: 你的改动说明"
#   bash scripts/deploy.sh "feat: 你的改动说明"
#
# 流程：
#   1. 读 .env（NAS WebDAV 路径等）
#   2. git add -A
#   3. git commit  （无新内容则跳过）
#   4. git push origin <当前分支>（默认 dev）
#   5. WebDAV 复制到 NAS 挂载点
#
# 注意：
#   - .env 不进 git，本机独有
#   - NAS 端的 docker rebuild + 重启由 fnOS 终端手动执行：
#       bash /vol1/1000/juguang/deploy.sh

set -euo pipefail

# === 0. 校验 ===
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if [ "$#" -lt 1 ]; then
  echo "✗ 用法：npm run deploy -- \"<commit message>\""
  echo "    例：npm run deploy -- \"feat(web): 歌单 UI\""
  exit 1
fi

MSG="$1"

# === 1. 读 .env ===
ENV_FILE="$PROJECT_ROOT/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "✗ .env 不存在，请复制 .env.example 并填值（尤其是 NAS_WEBDAV）"
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${NAS_WEBDAV:?NAS_WEBDAV 未在 .env 中配置}"
: "${TZ:?TZ 未在 .env 中配置}"

echo "==> 项目根：$PROJECT_ROOT"
echo "==> NAS WebDAV：$NAS_WEBDAV"
echo "==> Commit：$MSG"
echo ""

# === 2. git add / commit ===
echo "[$(date +%H:%M:%S)] git status:"
git status --short

# 没改动就跳过 commit + push（脚本可以仅做 sync）
if [ -z "$(git status --short)" ]; then
  echo ""
  echo "[$(date +%H:%M:%S)] 没有新改动，跳过 git commit/push"
  SKIP_GIT=1
else
  echo ""
  echo "[$(date +%H:%M:%S)] git add + commit"
  git add -A
  git commit -m "$MSG" || {
    echo "✗ git commit 失败"
    exit 1
  }
  SKIP_GIT=0
fi

# === 3. git push ===
if [ "$SKIP_GIT" -eq 0 ]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  echo "[$(date +%H:%M:%S)] git push origin $BRANCH"
  git push origin "$BRANCH" || {
    echo "✗ git push 失败"
    exit 1
  }
fi

# === 4. WebDAV 复制 ===
echo ""
echo "[$(date +%H:%M:%S)] 同步文件到 NAS：$NAS_WEBDAV"

if [ ! -d "$NAS_WEBDAV" ]; then
  echo "✗ WebDAV 挂载点不存在：$NAS_WEBDAV"
  echo "  请确认本机的 WebDAV 已挂载（Windows: 资源管理器 → 此电脑 → Z 盘）"
  exit 1
fi

# 用 rsync 优先，没有就退到 cp
if command -v rsync >/dev/null 2>&1; then
  echo "  · rsync server/  web/  scripts/  *.json *.yml Dockerfile .env.example .gitignore .dockerignore"
  rsync -av --delete \
    --exclude='data/' \
    --exclude='node_modules/' \
    --exclude='*.log' \
    --exclude='Snipaste_*' \
    --exclude='Screenshot*' \
    "$PROJECT_ROOT/server/" "$NAS_WEBDAV/server/"
  rsync -av --delete "$PROJECT_ROOT/web/" "$NAS_WEBDAV/web/"
  rsync -av --delete "$PROJECT_ROOT/scripts/" "$NAS_WEBDAV/scripts/"
  rsync -av \
    "$PROJECT_ROOT/package.json" \
    "$PROJECT_ROOT/Dockerfile" \
    "$PROJECT_ROOT/docker-compose.yml" \
    "$PROJECT_ROOT/docker-compose.fnOS.yml" \
    "$PROJECT_ROOT/.env.example" \
    "$PROJECT_ROOT/.gitignore" \
    "$PROJECT_ROOT/.dockerignore" \
    "$NAS_WEBDAV/"
else
  echo "  · cp（建议安装 rsync 加速增量同步）"
  # 不删除远端文件，只覆盖（--delete 在 cp 里没有，需要用 rsync 或 rm）
  cp -vR "$PROJECT_ROOT/server/." "$NAS_WEBDAV/server/" >/dev/null
  cp -vR "$PROJECT_ROOT/web/." "$NAS_WEBDAV/web/" >/dev/null
  cp -vR "$PROJECT_ROOT/scripts/." "$NAS_WEBDAV/scripts/" >/dev/null
  cp -v \
    "$PROJECT_ROOT/package.json" \
    "$PROJECT_ROOT/Dockerfile" \
    "$PROJECT_ROOT/docker-compose.yml" \
    "$PROJECT_ROOT/docker-compose.fnOS.yml" \
    "$PROJECT_ROOT/.env.example" \
    "$PROJECT_ROOT/.gitignore" \
    "$PROJECT_ROOT/.dockerignore" \
    "$NAS_WEBDAV/"
fi

echo ""
echo "[$(date +%H:%M:%S)] ✓ 文件同步完成"
echo ""
echo "下一步：在 fnOS 终端执行"
echo "    bash /vol1/1000/juguang/deploy.sh"
echo ""