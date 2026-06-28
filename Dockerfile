# syntax=docker/dockerfile:1.7
# 聚光广播 Juguang 服务端 — 多阶段 Docker 构建
# 最终镜像基于 node:24-alpine，不含构建工具，< 100MB

ARG NODE_VERSION=24-alpine

# ---- builder 阶段：仅用于安装生产依赖（虽然零依赖，留接口）----
FROM node:${NODE_VERSION} AS builder
WORKDIR /build
# 当前 package.json 无 dependencies；如果以后加，仅生产依赖
COPY package.json ./
# RUN npm ci --omit=dev  # 未来添加依赖时启用

# ---- runtime 阶段 ----
FROM node:${NODE_VERSION} AS runtime
LABEL org.opencontainers.image.title="juguang"
LABEL org.opencontainers.image.description="园区多设备音频同步广播系统"

# 安装 tini 用于正确处理 PID 1 信号（SIGTERM/SIGINT/SIGKILL）
# node:24-alpine 已经内置 tini？不内置，需装
RUN apk add --no-cache tini curl

# node 用户（alpine 自带 node 用户 uid=1000）
WORKDIR /app

# 先拷贝 package.json（依赖变更频率低，复用 layer cache）
COPY package.json ./

# 再拷贝源码
COPY server ./server
COPY web ./web

# 数据目录（会被 volume 挂载覆盖，但保留目录结构）
RUN mkdir -p /app/data/audio && chown -R node:node /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

EXPOSE 3000

# tini 作为 PID 1，传递信号给 node 进程
ENTRYPOINT ["/sbin/tini", "--"]

# 健康检查：调 /api/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

USER node

CMD ["node", "server/index.mjs"]
