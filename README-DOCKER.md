# 聚光广播 · Docker 部署手册（fnOS 飞牛 NAS）

> 部署目标：飞牛 NAS (fnOS) · Intel Celeron J3455 (x86_64) · 12 GB 内存 · 10.92 TB HDD
> 网络拓扑：本机 → GitHub → NAS WebDAV/Web Terminal → Docker 应用
> 公网访问：FN Connect 反代（`https://5ddd.com/spotlightculture:3000`）

---

## 0. 前置检查（首次部署一次性）

### 0.1 NAS 上确认 Docker 已装

fnOS 桌面有 **Docker** 图标即表示已装。也可以登录 `https://5ddd.com/spotlightculture` → 应用中心 → 搜 "Docker"。

如果应用中心没有 Docker 应用，桌面也没图标：
- 桌面找 "应用中心" 或 Docker 应用（部分 fnOS 直接放桌面）
- 联系 fnOS 客服 / 看官方文档

### 0.2 确认存储池路径

`系统设置 → 存储空间管理` 看挂在哪个路径下。fnOS 默认 `/vol1/1000/`（每个用户独立）。
本手册用 `/vol1/1000/juguang`。

### 0.3 镜像源（**关键**）

fnOS Docker daemon 默认走私有 registry `docker.fnnas.com`，对 `library/*` 镜像返回 401。
**不要用** 阿里云 `registry.cn-hangzhou.aliyuncs.com/library/node`（也 401，insufficient_scope）。
**用** DaoCloud 公益镜像：`docker.m.daocloud.io/library/node:24-alpine`。

本项目 `Dockerfile` 已默认配置 NODE_IMAGE 走 DaoCloud。如果还不行，按顺序换：
1. `docker.m.daocloud.io/library/node:24-alpine` （默认，已验证）
2. `docker.mirrors.ustc.edu.cn/library/node:24-alpine`
3. `dockerproxy.com/library/node:24-alpine`

改一处即可：`Dockerfile` 第 6 行 `ARG NODE_IMAGE=...` 和 `docker-compose*.yml` 里的 `NODE_IMAGE:`。

### 0.4 文件传输（**关键**）

本机到 NAS 网络**不通**（不同子网）。SSH 22 也连不上。文件传输走 **WebDAV**：

**WebDAV 挂载**：
- 浏览器打开 `https://dav.spotlightculture.5ddd.com:443`（登录你的 fnOS 账号）
- 或 Windows 资源管理器 → "映射网络驱动器" → 文件夹填上面 URL → 驱动器选 `Z:`
- 挂载后 `Z:\juguang\` 就是 NAS 上的 `/vol1/1000/juguang/`

### 0.5 SSH 状态

`系统设置 → SSH`：保持启用，端口 22。本手册主流程不依赖 SSH，但保留以便日后调试。

---

## 1. 首次部署

### 1.1 创建部署目录

**方法 A：WebDAV 挂载后在本机创建**
- 在 `Z:\juguang\` 下右键新建 `data` 文件夹
- 创建后 `/vol1/1000/juguang/data/` 就存在

**方法 B：Docker 应用自带终端**
- 打开 Docker 应用 → 容器标签 → 任意容器（甚至只是新建空容器）的终端
- 执行：`mkdir -p /vol1/1000/juguang/data`

### 1.2 上传代码（**WebDAV 方式**）

**WebDAV 已挂载 `Z:` 后**（参见 §0.4）：

```bash
# 在本机执行：
# 1. 从 GitHub 下载或 git clone 出整个项目目录
# 2. 拷贝以下文件/目录到 Z:\juguang\
#    - Dockerfile
#    - docker-compose.yml
#    - docker-compose.override.yml.example
#    - .env.example（拷贝后改名为 .env）
#    - .dockerignore
#    - package.json
#    - server/ 整个目录（8 个 .mjs 文件）
#    - web/ 整个目录（4 个文件）
```

**⚠️ 坑**：WebDAV 复制**空目录**没问题，但**大量小文件**可能漏传。复制后验证：
- `Z:\juguang\server\` 下应有 8 个 `.mjs`
- `Z:\juguang\web\` 下应有 4 个文件

如果漏了，从本机 `cp -v` 补传。

**为什么要 WebDAV 而不是 git clone**：
fnOS Docker 应用内置终端只支持容器内 shell，**不能直接跑 git**（git 在 fnOS 基础镜像里可能没装）。
WebDAV 一次性把所有文件传上去最稳。

### 1.3 启动容器

**Docker 应用 → Compose 标签 → 创建新项目**：
- 项目名：`juguang`
- 路径：`/vol1/1000/juguang`
- 模式选"docker-compose"（YAML 文件）
- 文件路径：`/vol1/1000/juguang/docker-compose.yml`

启动 → 等待 build（首次 2-5 分钟，因为要下载 `node:24-alpine` 镜像 ~50MB + 构建）

### 1.4 初始化管理员

容器跑起来后，在 Docker 应用 → 容器标签 → 找到 `juguang` 容器：

**点"终端"按钮**（如果你没看到这个按钮，说明 fnOS Docker UI 没暴露终端功能。备选：找"执行命令"或类似功能）

```bash
node server/init-admin.mjs admin your_password
# 应输出：已创建管理员：admin / your_password
# 当前管理员总数：1
```

**⚠️ 坑**：**不要**手动跑 `node server/index.mjs &`，会 `EADDRINUSE`——容器已经在跑（Dockerfile CMD 启动的）。

### 1.5 验证

在容器终端里：
```bash
curl http://127.0.0.1:3000/api/health
# 应返回 {"ok":true,...,"serverIps":[{"iface":"eth0","address":"172.19.0.2"}],"port":3000}
```

### 1.6 浏览器访问

按 fnOS FN Connect 配置：
- **公网（推荐）**：`https://5ddd.com/spotlightculture:3000`
- 内网（需要和 NAS 同子网）：`http://192.168.108.199:3000`

打开后：
- `/admin` → 登录 `admin / your_password` → 进入管理面板
- `/` → 选 zone（默认 "默认分区"）→ 输入设备名 → 加入广播
- 管理端上传一首 MP3 → 点 ▶ → 聆听端能否听到

---

## 2. 代码更新流程

### 2.1 本机推代码

```bash
git add . && git commit -m "feat: ..."
git push origin main
```

### 2.2 NAS 上拉 + 重启

Web Terminal：
```bash
cd /vol1/1000/juguang
git pull
docker compose up -d --build
```

也可以只重启（如果只是配置变更）：
```bash
docker compose restart juguang
```

---

## 3. 数据持久化

`./data/` 目录挂载到容器内 `/app/data/`：
```
data/
├── audio/        # 上传的音频文件（不删容器就在）
└── app.db        # SQLite（不删容器就在）
```

**备份建议**（每周/每月）：
```bash
# 停服 → 打包 data → 启动
docker compose stop juguang
tar czf data-$(date +%Y%m%d).tar.gz data/
docker compose start juguang
```

**恢复**：
```bash
# 停服 → 解压 → 启动
docker compose stop juguang
tar xzf data-20260628.tar.gz
docker compose start juguang
```

更高级的备份：rsync 到云盘 / 异地 NAS。

---

## 4. 常用命令

```bash
# 查看运行状态
docker compose ps

# 看实时日志
docker compose logs -f juguang

# 看最近 100 行
docker compose logs --tail=100 juguang

# 重启
docker compose restart juguang

# 停止（不删容器）
docker compose stop juguang

# 停止 + 删容器（数据卷保留）
docker compose down

# 完全清理（容器 + 镜像 + 数据，慎用）
docker compose down --rmi all -v

# 进容器 shell 调试
docker compose exec juguang sh

# 看资源占用
docker stats juguang
```

---

## 5. 故障排查

### 5.1 容器起不来

```bash
# 看完整启动日志
docker compose logs juguang

# 常见原因：
# - 端口被占：改 .env 的 JUGUANG_PORT
# - data 目录权限：sudo chown -R $USER:$USER data/
```

### 5.2 健康检查失败

```bash
# 在容器内手动 curl
docker compose exec juguang curl -fsS http://127.0.0.1:3000/api/health
```

### 5.3 磁盘满

```bash
# 看容器日志占用
docker system df

# 清理
docker system prune -a --volumes  # 慎用，会删所有未用镜像和卷
```

### 5.4 重建镜像

如果改了 Dockerfile 或 package.json：
```bash
docker compose build --no-cache
docker compose up -d
```

### 5.5 看 NAS 端 logs

容器日志路径：`/vol1/1000/juguang/data/server.log`（如果开启），
或者直接 `docker compose logs`。

---

## 6. 公网访问方案

### 6.1 FN Connect（**已验证可用**）

fnOS 的 `https://5ddd.com/spotlightculture` 自带反代，**3000 端口可直接通过这个域名访问**：

```
https://5ddd.com/spotlightculture:3000  →  NAS:3000 → juguang 容器
```

不需要额外配置，fnOS Docker 应用启动容器后自动注册反代规则。

### 6.2 路由器端口映射

路由器后台把 NAS 3000 端口映射到公网。**不推荐**——需要公网 IP + 防火墙配置，国内还要备案。

### 6.3 Cloudflare Tunnel（如果以后换域名）

如果以后有公网域名，加一个 `cloudflared` 容器进 docker-compose：

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel run
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}
    depends_on:
      - juguang
    networks:
      - juguang-net
    restart: unless-stopped
```

Cloudflare Dashboard 加路由：`juguang.example.com → http://juguang:3000`。

---

## 7. 目录结构

部署后 NAS 上的目录：
```
/vol1/1000/juguang/
├── Dockerfile
├── docker-compose.yml
├── .env                  # 不进 git
├── .dockerignore
├── server/
├── web/
├── data/                 # 挂载到容器
│   ├── audio/
│   └── app.db
└── README-DOCKER.md
```

---

## 8. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `JUGUANG_PORT` | `3000` | NAS 上对外的端口（容器内固定 3000） |
| `TZ` | `Asia/Shanghai` | 时区 |

不需要设置管理员密码环境变量——首次部署后用 `init-admin` 命令创建。

---

## 9. 升级清单

- 修改了 `package.json`？→ 必须重建：`docker compose up -d --build`
- 只改 `server/*.mjs` 或 `web/*`？→ 改完直接 `docker compose restart juguang`（容器内会重启 Node 进程——但代码需要重新 COPY 进镜像，所以**改源码也必须 rebuild**）

最稳：
```bash
git pull && docker compose up -d --build
```
