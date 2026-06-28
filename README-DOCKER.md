# 聚光广播 · Docker 部署手册（fnOS 飞牛 NAS）

> 部署目标：飞牛 NAS (fnOS) · Intel Celeron J3455 (x86_64) · 12 GB 内存 · 10.92 TB HDD
> 网络拓扑：本机 → GitHub → NAS Web Terminal → `git pull` + `docker compose up`

---

## 0. 前置检查（首次部署一次性）

### 0.1 NAS 上确认 Docker 已装

登录 `https://5ddd.com/spotlightculture`（FN Connect 远程访问）→ 应用中心 → 搜 "Docker" → 安装。

如果应用中心没有：
- Web Terminal 里执行：`sudo docker --version`（fnOS 的 sudo 默认免密）
- 没有就装：`sudo apt update && sudo apt install -y docker.io docker-compose-plugin`
- 验证：`sudo docker compose version`（要 v2，不是老版 `docker-compose`）

### 0.2 确认存储池路径

`存储空间管理` 看挂在哪个路径下。fnOS 默认 `/vol1/1000/`（每个用户独立）。本手册用 `/vol1/1000/juguang`。

### 0.3 SSH 状态

`系统设置 → SSH`：保持启用，端口 22。本手册不用 SSH 22（你本机到 NAS 网络不通），但保留启用方便以后 web terminal 调用。

---

## 1. 首次部署

### 1.1 创建部署目录

在 NAS **Web Terminal**（应用中心装 "终端" 应用）执行：

```bash
# 创建目录
mkdir -p /vol1/1000/juguang/data
cd /vol1/1000/juguang
```

### 1.2 拉代码

```bash
# 第一次：克隆仓库
git clone https://github.com/feng901108/Audio-sync-system.git .

# 后续更新代码：git pull
```

### 1.3 准备运行时文件

```bash
# 复制环境变量模板
cp .env.example .env

# （可选）改端口：默认 3000
# sed -i 's/JUGUANG_PORT=3000/JUGUANG_PORT=8080/' .env
```

### 1.4 启动容器

```bash
# 构建镜像并后台启动
docker compose up -d --build

# 跟踪启动日志（首次构建较慢，1-2 分钟）
docker compose logs -f
```

看到 `聚光广播服务端已启动：http://localhost:3000` 就 OK 了，按 `Ctrl+C` 退出日志跟踪。

### 1.5 初始化管理员

```bash
# 在容器内执行 init-admin（替换 your_password）
docker compose exec juguang node server/init-admin.mjs admin your_password

# 应输出：已创建管理员：admin / your_password
```

### 1.6 验证

```bash
# 健康检查
curl http://localhost:3000/api/health
# 应返回 {"ok":true,...,"serverIps":[...],"port":3000}

# 看容器状态
docker compose ps
# STATUS 应是 Up (healthy)
```

浏览器访问（**注意：当前网络环境可能不行**）：
- 内网：http://192.168.108.199:3000（同 WiFi）
- 公网：需要 fnOS 反代或端口映射（参见 §6）

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

当前默认**仅内网**访问（http://192.168.108.199:3000）。

### 6.1 FN Connect 反代（如果 fnOS 支持）

fnOS "远程访问 → FN Connect" 已经有 `https://5ddd.com/spotlightculture` 的 HTTPS 入口。
如果 fnOS 支持加自定义子路径，可以加 `/juguang → http://juguang:3000`（容器名 juguang）。
**问 fnOS 文档或客服确认**。

### 6.2 Cloudflare Tunnel（推荐，需公网域名）

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

### 6.3 路由器端口映射

路由器后台把 NAS 3000 端口映射到公网。**不推荐**——需要公网 IP + 防火墙配置，国内还要备案。

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
