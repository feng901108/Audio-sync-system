FROM python:3.12-slim

WORKDIR /app

# fastapi + uvicorn: Web 服务; python-mpd2: 通过 MPD 协议控制 mopidy; httpx: 反向代理 SnapWeb; websockets: 代理 SnapWeb 的 JSON-RPC WS
RUN pip install --no-cache-dir fastapi "uvicorn[standard]" python-mpd2 httpx websockets

COPY server/main.py /app/main.py
COPY player/ /app/player/

# 兼容两种 URL 约定：
#   /tv.html       → /app/player/tv.html  (StaticFiles 直接挂在 /)
#   /player/tv.html → /app/player/player/tv.html → 软链 player → .  → /app/player/tv.html
RUN ln -sf /app/player /app/player/player && chmod -R a+rX /app

EXPOSE 8765

# music-sync 通过网络连接 mopidy 的 6600 端口，不需要挂载音乐目录
ENV MPD_HOST=mopidy \
    MPD_PORT=6600

CMD ["python", "main.py"]
