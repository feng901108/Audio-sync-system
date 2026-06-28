# 部署方案：fnOS (飞牛 NAS) · 纯局域网 · 无 SSH 直连

> **当前现实**：本机和 NAS 不在同一可路由网段，节点小宝做了应用层组网但没暴露 SSH 22 端口。
> **结论**：**放弃 SSH/GitHub Actions 自动部署**，改用**手动部署 + Web Terminal**。
> 网络拓扑：`本机 (git push) → GitHub → NAS (Web Terminal git pull + docker compose up)`

---

## 我会交付什么（commit 1：Docker 化）

### 文件清单
- `Dockerfile` — node:24-alpine 多阶段，最终镜像 < 100MB
- `.dockerignore` — 排除 data/、.git/、.chrome-data/、node_modules/
- `docker-compose.yml` — 含 juguang 服务、健康检查、卷挂载、重启策略
- `docker-compose.override.yml.example` — 本机开发用（mount 源码）

### 镜像架构选择 ⚠️
fnOS 大部分型号是 **x86_64**（Docker Hub tag：`linux/amd64`）。
如果是 ARM（如 fnOS 某些新款）：用 `linux/arm64`。
**告诉我你的 NAS 架构**（登录 fnOS → 系统信息 → CPU 架构）。

---

## 你的部署步骤（在 NAS Web Terminal 执行）

### 1. 打开 NAS Web Terminal
登录 `https://spotlightculture.5ddd.com` → 应用中心 → 装"终端"（或"Terminal"）→ 打开

### 2. 安装 Docker（如果还没装）
- 方案 A：在 fnOS 应用中心搜 "Docker" → 一键装
- 方案 B：Web Terminal 里执行（**要 root**）：
  ```bash
  sudo docker --version
  # 没有就：
  # sudo apt update && sudo apt install docker.io docker-compose-plugin -y
  ```

### 3. 拉代码 + 启动
```bash
# 创建部署目录
sudo mkdir -p /vol1/1000/juguang/data
sudo chown -R $USER:$USER /vol1/1000/juguang

# 拉代码（用 https 协议 + Personal Access Token）
cd /vol1/1000/juguang
git clone https://github.com/feng901108/Audio-sync-system.git .

# 首次启动
docker compose up -d --build
docker compose logs -f  # 看日志
```

### 4. 初始化管理员
```bash
# exec 进容器
docker compose exec juguang node server/init-admin.mjs admin your_password
```

### 5. 访问
- NAS 内网：`http://<NAS_IP>:3000`
- fnOS 域名（如果 fnOS 反代了 3000）：`https://spotlightculture.5ddd.com:3000`（看 fnOS 是否开了这个端口映射）

---

## 代码更新流程

每次本地改完代码：
```bash
# 本机
git add . && git commit -m "..." && git push origin main

# NAS Web Terminal
cd /vol1/1000/juguang
git pull
docker compose up -d --build
```

5 分钟流程。

---

## 我需要你给我的 3 个信息 ⚠️

| # | 信息 | 你现在的状态 |
|---|---|---|
| 1 | NAS CPU 架构（x86_64 还是 aarch64） | ❓ 待你查 fnOS 系统信息 |
| 2 | 部署目录路径（我猜 `/vol1/1000/juguang`，看你的存储池） | ❓ 待你确认 |
| 3 | `https://spotlightculture.5ddd.com` 后台能不能装 Docker | ❓ 待你在 fnOS 应用中心看 |

---

## 为什么不做 GitHub Actions 自动部署

| 尝试 | 结果 |
|---|---|
| GitHub Actions → SSH 22 → NAS | **NAS 22 端口从本机 ping 超时**，节点小宝没暴露 22 |
| GitHub Actions → Web Terminal API | fnOS Web Terminal 不是公开 API |
| GitHub Actions → webhook 接收器 | 需要 NAS 上跑接收服务，又回到 SSH 问题 |

**手动 git pull + docker compose up** 是当前网络环境**唯一稳**的方案。

---

## 网络问题彻底解决时（未来）

如果你以后搞定了：
- NAS 在公网（通过 `spotlightculture.5ddd.com:22` 反代 SSH）
- 或者路由器做了端口映射
- 或者节点小宝开通了 22 端口转发

**我可以马上加回 `.github/workflows/deploy.yml`**，实现 push main → 自动部署。

---

## 待办

- [ ] 你给我 NAS 架构（x86_64 / aarch64）
- [ ] 你确认 Docker 已装 / 准备装
- [ ] 我写 Dockerfile + compose.yml（commit 1）
- [ ] 你在 NAS 上跑部署步骤
- [ ] 测试 http://NAS_IP:3000 能否访问
