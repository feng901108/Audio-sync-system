#!/usr/bin/env python3
"""Music Sync Server - FastAPI 控制面板，通过 MPD 协议控制 mopidy。

架构（方案A）：
  浏览器 ──HTTP/WS──> music-sync ──MPD──> mopidy ──FIFO──> snapserver ──> snapclient(多音箱)

本服务只负责"控制"，不处理音频流。音频由 mopidy 解码后写入 FIFO，
snapserver 读取 FIFO 并分发给各 snapclient，实现毫秒级同步播放。
"""

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Optional

import httpx
import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, Response, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, PlainTextResponse
from mpd import MPDClient, MPDError
from pydantic import BaseModel

# ─── Config ────────────────────────────────────────────────────────────────
MPD_HOST = os.environ.get("MPD_HOST", "mopidy")
MPD_PORT = int(os.environ.get("MPD_PORT", "6600"))
MPD_TIMEOUT = 10

# Snapserver JSON-RPC 端点（用于查询客户端状态）
SNAPSERVER_URL = os.environ.get("SNAPSERVER_URL", "http://snapserver:1780")

# 音乐库根目录（mopidy local:track:<relpath> 中的 relpath 相对该目录）
# 容器内挂载在 /music；部署时通过 MUSIC_DIR 透传
MUSIC_DIR = Path(os.environ.get("MUSIC_DIR", "/music"))

HOST = "0.0.0.0"
PORT = 8765

# /api/clients 后端 500ms 缓存（避免多页签同时轮询打爆 JSONRPC）
_clients_cache: dict = {"value": None, "ts": 0.0}
_CLIENTS_CACHE_TTL = 0.5  # 秒
_clients_lock: Optional["asyncio.Lock"] = None

# ─── App ───────────────────────────────────────────────────────────────────
app = FastAPI(title="Music Sync Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Connected clients: {ws: {"client_id": str}}
clients: dict[WebSocket, dict] = {}


# ─── MPD Helper ────────────────────────────────────────────────────────────
def _mpd_call(func, *args, **kwargs):
    """同步调用 MPD 命令，每次创建临时连接，避免并发问题。"""
    client = MPDClient()
    client.timeout = MPD_TIMEOUT
    client.connect(MPD_HOST, MPD_PORT)
    try:
        return func(client, *args, **kwargs)
    finally:
        try:
            client.close()
            client.disconnect()
        except Exception:
            pass


async def mpd_call(func, *args, **kwargs):
    """异步包装 MPD 调用，放到线程池执行避免阻塞事件循环。"""
    return await asyncio.to_thread(_mpd_call, func, *args, **kwargs)


def _ensure_playlist(client):
    """如果播放队列为空，列出音乐库所有曲目并加入播放队列。"""
    status = client.status()
    if int(status.get("playlistlength", 0)) == 0:
        # list file 返回所有曲目的 URI（格式: local:track:xxx）
        songs = client.list("file")
        if not songs:
            print("[MPD] No tracks found in library, run 'mopidy local scan' first")
            return
        client.clear()
        for song in songs:
            uri = song.get("file")
            if uri:
                client.add(uri)
        client.stop()
        print(f"[MPD] Initialized playlist with {len(songs)} tracks")


def _uri_to_relpath(uri: str) -> Optional[Path]:
    """把 MPD uri（如 local:track:foo/bar.mp3）翻译为 MUSIC_DIR 下的相对路径。"""
    if not uri:
        return None
    # mopidy-local 的 uri 格式：local:track:<urlencoded relpath>
    if uri.startswith("local:track:"):
        from urllib.parse import unquote
        rel = uri[len("local:track:"):]
        rel = unquote(rel)
    else:
        rel = uri
    try:
        p = Path(rel)
        if p.is_absolute():
            # 绝对路径：尝试取相对于 MUSIC_DIR 的部分
            try:
                return p.relative_to(MUSIC_DIR)
            except ValueError:
                return Path(p.name)
        return p
    except Exception:
        return None


def _cover_api_for(relpath_or_none: Optional[Path]) -> str:
    if relpath_or_none is None:
        return ""
    from urllib.parse import quote
    return f"/api/cover?path={quote(str(relpath_or_none))}"


def _normalize_track(song: dict, idx: int) -> dict:
    """将 MPD song 字典扁平化为前端友好的格式。"""
    file_uri = song.get("file", "")
    relpath = _uri_to_relpath(file_uri)
    title = song.get("title") or (relpath and relpath.stem) or f"track-{idx}"
    return {
        "id": idx,
        "pos": int(song.get("pos", idx)),
        "file": file_uri,
        "title": title,
        "artist": song.get("artist", ""),
        "album": song.get("album", ""),
        "duration": float(song.get("duration", song.get("time", 0)) or 0),
        "cover_url": _cover_api_for(relpath),
    }


def _get_full_state():
    """获取完整播放队列 + 当前状态。"""
    client = MPDClient()
    client.timeout = MPD_TIMEOUT
    client.connect(MPD_HOST, MPD_PORT)
    try:
        _ensure_playlist(client)
        playlist = client.playlistinfo()
        tracks = [_normalize_track(s, i) for i, s in enumerate(playlist)]
        status = client.status()
        currentsong = client.currentsong() or {}
        state = _build_state(status, currentsong)
        state["tracks"] = tracks
        return state
    finally:
        try:
            client.close()
            client.disconnect()
        except Exception:
            pass


def _build_state(status: dict, currentsong: dict) -> dict:
    """从 MPD status/currentsong 构建前端状态。"""
    song_pos = status.get("song")
    elapsed = float(status.get("elapsed", 0) or 0)
    duration = float(currentsong.get("duration", currentsong.get("time", 0)) or 0)
    return {
        "is_playing": status.get("state") == "play",
        "current_track_idx": int(song_pos) if song_pos is not None else 0,
        "position": elapsed,
        "duration": duration,
        "volume": int(status.get("volume", 0)),
        "repeat": int(status.get("repeat", 0)),
        "random": int(status.get("random", 0)),
        "server_time": time.time(),
    }


# ─── Startup ───────────────────────────────────────────────────────────────
@app.on_event("startup")
async def startup():
    global _clients_lock
    _clients_lock = asyncio.Lock()
    try:
        state = await asyncio.to_thread(_get_full_state)
        print(f"[Server] Connected to MPD at {MPD_HOST}:{MPD_PORT}")
        print(f"[Server] Playlist: {len(state['tracks'])} tracks")
    except Exception as e:
        print(f"[Server] WARNING: cannot connect to MPD ({e}). Will retry.")
    # 启动后台状态广播
    asyncio.create_task(state_broadcaster())


# ─── API Endpoints ────────────────────────────────────────────────────────
@app.get("/api/tracks")
async def get_tracks():
    state = await asyncio.to_thread(_get_full_state)
    return state["tracks"]


@app.get("/api/state")
async def get_state():
    try:
        status = await mpd_call(lambda c: c.status())
        current = await mpd_call(lambda c: c.currentsong()) or {}
        return _build_state(status, current)
    except Exception as e:
        return {"error": str(e)}


class PlayRequest(BaseModel):
    track_idx: Optional[int] = None
    position: Optional[float] = None


@app.post("/api/play")
async def play(req: Optional[PlayRequest] = Body(default=None)):
    """播放（向后兼容：允许空 body / 无 Content-Type）。

    - body 省略或空 → 继续当前歌曲（或从第 0 首开始，由 _ensure_playlist 兜底）
    - body 带 track_idx → 切到指定曲目
    - body 带 position → seek 到指定秒数
    """
    req = req or PlayRequest()

    def _do(client):
        _ensure_playlist(client)
        status = client.status()
        if req.track_idx is not None:
            client.play(req.track_idx)
        elif status.get("state") != "play":
            # 只在非播放状态时调用 play()，避免重置当前播放进度
            client.play()
        if req.position is not None:
            client.seekcur(req.position)
        return _build_state(client.status(), client.currentsong() or {})

    try:
        return await mpd_call(_do)
    except Exception as e:
        return {"error": str(e)}


@app.post("/api/pause")
async def pause():
    try:
        return await mpd_call(lambda c: (c.pause(1), _build_state(c.status(), c.currentsong() or {}))[1])
    except Exception as e:
        return {"error": str(e)}


@app.post("/api/next")
async def next_track():
    try:
        return await mpd_call(lambda c: (c.next(), _build_state(c.status(), c.currentsong() or {}))[1])
    except Exception as e:
        return {"error": str(e)}


@app.post("/api/prev")
async def prev_track():
    try:
        return await mpd_call(lambda c: (c.previous(), _build_state(c.status(), c.currentsong() or {}))[1])
    except Exception as e:
        return {"error": str(e)}


@app.post("/api/seek")
async def seek(position: float):
    try:
        return await mpd_call(lambda c: (c.seekcur(position), _build_state(c.status(), c.currentsong() or {}))[1])
    except Exception as e:
        return {"error": str(e)}


@app.post("/api/volume")
async def set_volume(volume: int):
    try:
        return await mpd_call(lambda c: (c.setvol(volume), {"ok": True, "volume": volume})[1])
    except Exception as e:
        return {"error": str(e)}


@app.post("/api/rescan")
async def rescan():
    """触发 mopidy 重新扫描音乐库。"""
    try:
        return await mpd_call(lambda c: {"ok": True, "job": c.update("/")})
    except Exception as e:
        return {"error": str(e)}


# ─── 封面图 ────────────────────────────────────────────────────────────
# 优先顺序：
#   1. 歌曲同目录：cover / folder / .folder / Album / <歌曲同名> 的 jpg/png/jpeg/webp
#   2. 父目录递归查找上述名称（最多 3 层）
#   3. SVG 渐变占位图（根据 artist + album 哈希，稳定配色）
COVER_NAMES = [
    "cover", "Cover", "COVER",
    "folder", "Folder", "FOLDER",
    ".folder", "Album", "album", "AlbumArtSmall", "AlbumArt",
    "front", "Front",
]
COVER_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".JPG", ".JPEG", ".PNG", ".WEBP"]
ALLOWED_COVER_MIME = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".webp": "image/webp",
}


def _find_cover_for(relpath: Path) -> Optional[tuple[Path, str]]:
    """返回 (absolute_path, mime)，找不到返回 None。"""
    try:
        # 防止 ../ 越界
        abs_song = (MUSIC_DIR / relpath).resolve()
        MUSIC_DIR.resolve().relative_to(abs_song.parent)  # 会抛错或继续
        abs_song.relative_to(MUSIC_DIR.resolve())
    except Exception:
        return None

    candidates_dirs = [abs_song.parent]
    # 最多追 3 层父目录
    for _ in range(3):
        p = candidates_dirs[-1].parent
        if p == candidates_dirs[-1] or not str(p).startswith(str(MUSIC_DIR.resolve())):
            break
        candidates_dirs.append(p)

    song_stem = abs_song.stem
    for d in candidates_dirs:
        if not d.exists():
            continue
        # a) 固定名
        for name in COVER_NAMES:
            for ext in COVER_EXTS:
                f = d / f"{name}{ext}"
                if f.is_file():
                    return f, ALLOWED_COVER_MIME.get(ext.lower(), "image/jpeg")
        # b) 与歌曲同名（只在歌曲目录这一级找）
        if d == abs_song.parent:
            for ext in COVER_EXTS:
                f = d / f"{song_stem}{ext}"
                if f.is_file():
                    return f, ALLOWED_COVER_MIME.get(ext.lower(), "image/jpeg")
    return None


def _placeholder_cover(artist: str, album: str, title: str) -> bytes:
    """生成一张 SVG 渐变占位封面：黑底 + 暖色圆形光晕 + 歌名首字。"""
    seed = abs(hash((artist, album))) % 1000
    palette = [
        ("#e8c07d", "#5a3e1b"),   # 香槟金 → 琥珀黑
        ("#b8a9ff", "#2a2455"),   # 薰衣草 → 深蓝紫
        ("#ff9fb1", "#5a1a33"),   # 樱花 → 莓果黑
        ("#7ad7c3", "#164a42"),   # 翡翠薄荷 → 墨绿
        ("#ffb74d", "#5a3610"),   # 橙 → 深橙黑
    ]
    c1, c2 = palette[seed % len(palette)]
    def letter(s):
        for ch in s:
            if ch.strip():
                return ch
        return "♪"
    big = letter(title or album or artist or "♪")
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#141414"/>
      <stop offset="100%" stop-color="#050505"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="45%" r="60%">
      <stop offset="0%" stop-color="{c1}" stop-opacity="0.55"/>
      <stop offset="60%" stop-color="{c2}" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="800" height="800" fill="url(#bg)"/>
  <rect width="800" height="800" fill="url(#glow)"/>
  <circle cx="400" cy="400" r="210" fill="none" stroke="{c1}" stroke-opacity="0.18" stroke-width="1"/>
  <circle cx="400" cy="400" r="170" fill="none" stroke="{c1}" stroke-opacity="0.28" stroke-width="1"/>
  <circle cx="400" cy="400" r="132" fill="none" stroke="{c1}" stroke-opacity="0.40" stroke-width="1"/>
</svg>
"""
    return svg.encode("utf-8")


@app.get("/api/cover")
async def get_cover(path: str, artist: str = "", album: str = "", title: str = ""):
    """根据歌曲相对路径返回封面图（jpeg/png/webp 或 SVG 占位）。"""
    relpath = Path(path) if path else None
    cover_bytes = None
    mime = "image/jpeg"
    if relpath:
        found = _find_cover_for(relpath)
        if found:
            f, mime = found
            try:
                cover_bytes = f.read_bytes()
            except Exception:
                cover_bytes = None
    if cover_bytes is None:
        cover_bytes = _placeholder_cover(artist or "", album or "", title or "")
        mime = "image/svg+xml"
    return Response(content=cover_bytes, media_type=mime,
                    headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/clients")
async def get_clients():
    """查询 snapserver 客户端状态（反向代理 JSONRPC，避免前端跨域）。

    加入 500ms 内存缓存 + 单飞锁：同时间内即使 20 个页签同时轮询，
    也只会向后端 snapserver:1780/jsonrpc 打 1 次请求。
    """
    global _clients_cache
    import time as _time
    now = _time.monotonic()
    if _clients_cache["value"] is not None and (now - _clients_cache["ts"]) < _CLIENTS_CACHE_TTL:
        return _clients_cache["value"]

    # 单飞：第一个请求实际请求，其余等待结果
    lock = _clients_lock or asyncio.Lock()
    async with lock:
        now = _time.monotonic()
        if _clients_cache["value"] is not None and (now - _clients_cache["ts"]) < _CLIENTS_CACHE_TTL:
            return _clients_cache["value"]
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.post(
                    f"{SNAPSERVER_URL}/jsonrpc",
                    json={"id": 1, "jsonrpc": "2.0", "method": "Server.GetStatus"},
                )
                data = r.json()
            clients = data.get("result", {}).get("server", {}).get("clients", [])
            result = {"clients": [{"id": c.get("id"), "name": c.get("name"),
                                   "connected": c.get("connected", False),
                                   "volume": c.get("config", {}).get("volume", {}).get("percent", 0),
                                   "muted": c.get("config", {}).get("volume", {}).get("muted", False)}
                                  for c in clients]}
        except Exception as e:
            result = {"clients": [], "error": str(e)}
        _clients_cache = {"value": result, "ts": _time.monotonic()}
        return result


# ─── WebSocket Synchronization ─────────────────────────────────────────────
# 非 WS 请求命中这些路径时（健康检查/爬虫/错误的 HTTP 探测），
# 明确返回 426 Upgrade Required，避免 uvicorn 打印 "Invalid HTTP request received." 并误伤真实 WS 连接。
@app.api_route("/ws", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
async def ws_http_not_upgrade():
    return PlainTextResponse(
        content="426 Upgrade Required: this endpoint is WebSocket-only; send Upgrade: websocket header.\n",
        status_code=426,
        headers={"Upgrade": "websocket", "Connection": "Upgrade"},
    )

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    client_id = f"client-{len(clients)+1}"
    clients[ws] = {"client_id": client_id}
    print(f"[WS] {client_id} connected")

    try:
        # 推送一次完整状态
        state = await asyncio.to_thread(_get_full_state)
        await ws.send_json({"type": "state", **state})
        # 保持连接，接收心跳
        while True:
            msg = await ws.receive_json()
            if msg.get("type") == "pong":
                continue
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[WS] {client_id} error: {e}")
    finally:
        clients.pop(ws, None)
        print(f"[WS] {client_id} disconnected")


async def broadcast(msg: dict):
    dead = []
    for ws in clients:
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.pop(ws, None)


async def state_broadcaster():
    """后台任务：每秒查询 MPD 状态并广播给前端。

    播放中：每秒广播（前端更新进度条）。
    暂停/停止：只在 track/volume/state 变化时广播。
    """
    last_key = None  # (is_playing, track_idx, volume)
    while True:
        await asyncio.sleep(1)
        if not clients:
            continue
        try:
            status = await mpd_call(lambda c: c.status())
            current = await mpd_call(lambda c: c.currentsong()) or {}
            state = _build_state(status, current)
            key = (state["is_playing"], state["current_track_idx"], state["volume"])
            if state["is_playing"] or key != last_key:
                await broadcast({"type": "state", **state})
                last_key = key
        except Exception as e:
            print(f"[Broadcast] error: {e}")


# ─── SnapWeb 全量反向代理（同源，避免跨域；HTML 注入深色主题）─────────────
# 所有 /snapweb/* 请求（HTML/JS/CSS/字体/JSON-RPC/WebSocket）都代理到 snapserver:1780
SNAPWEB_DARK_CSS = """
<style id="force-dark">
  html, body, #root { background-color: #121212 !important; color: rgba(255,255,255,0.7) !important; color-scheme: dark !important; }
  .MuiPaper-root, .MuiAppBar-root, .MuiDrawer-paper, .MuiCard-root,
  .MuiDialog-paper, .MuiPopover-paper, .MuiMenu-paper {
    background-color: #1e1e1e !important; color: rgba(255,255,255,0.7) !important;
  }
  .MuiAppBar-colorPrimary { background-color: #1e1e1e !important; }
  .MuiTypography-root, .MuiListItemText-primary, .MuiListItemText-secondary,
  .MuiInputLabel-root, .MuiButton-label, .MuiSelect-select, td, th, span, div, p, label {
    color: rgba(255,255,255,0.7) !important;
  }
  .MuiTypography-colorTextPrimary, .MuiTypography-colorTextSecondary { color: rgba(255,255,255,0.7) !important; }
  .MuiInputBase-root { color: rgba(255,255,255,0.7) !important; }
  .MuiOutlinedInput-notchedOutline { border-color: rgba(255,255,255,0.23) !important; }
  .MuiSlider-root { color: #266798 !important; }
  .MuiSwitch-root .MuiSwitch-track { background-color: rgba(255,255,255,0.12) !important; }
  .MuiDivider-root { border-color: rgba(255,255,255,0.12) !important; }
  .MuiListItem-root:hover { background-color: rgba(255,255,255,0.04) !important; }
  .MuiListItem-root.Mui-selected { background-color: rgba(255,255,255,0.08) !important; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: #121212; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
</style>
<script>
  // 在 SnapWeb 的 module 脚本加载前，强制持久化默认配置：
  //   - showoffline=true：显示离线客户端（无 snapclient 在线时也能看到控制界面）
  //   - theme=dark：强制深色主题，与左侧控制面板统一
  //   - snapserver.host=当前页面 ws URL：通过 music-sync 代理访问时，确保连到 8765 而非 1780
  (function(){
    try {
      var host = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
      localStorage.setItem("snapserver.host", host);
      localStorage.setItem("showoffline", "true");
      localStorage.setItem("theme", "dark");
    } catch(e) {}
  })();
</script>
"""

# 不转发的 hop-by-hop 头
_HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}


def _filter_headers(headers) -> dict:
    return {k: v for k, v in headers if k.lower() not in _HOP_HEADERS}


@app.get("/snapweb")
async def snapweb_root_redirect():
    """访问 /snapweb 重定向到 /snapweb/（带尾部斜杠，确保相对路径正确解析）。"""
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/snapweb/", status_code=302)


@app.api_route("/snapweb/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
async def snapweb_proxy(path: str, request: Request):
    """全量反向代理 SnapWeb。HTML 响应注入深色 CSS。"""
    target_url = f"{SNAPSERVER_URL}/{path}" if path else f"{SNAPSERVER_URL}/"

    # 转发查询参数
    if request.url.query:
        target_url += f"?{request.url.query}"

    # 转发请求头（过滤 hop-by-hop）
    fwd_headers = _filter_headers(request.headers.items())

    # 读取请求体
    body = await request.body()

    async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
        try:
            upstream = await client.request(
                request.method, target_url, headers=fwd_headers, content=body,
            )
        except Exception as e:
            return Response(content=f"SnapWeb proxy error: {e}", status_code=502)

    # HTML 响应：注入深色 CSS（仅根路径 /snapweb 或 /snapweb/）
    content_type = upstream.headers.get("content-type", "")
    if "text/html" in content_type and path in ("", "/"):
        html = upstream.text
        if "<head>" in html:
            html = html.replace("<head>", "<head>" + SNAPWEB_DARK_CSS, 1)
        elif "<head " in html:
            html = html.replace("<head ", SNAPWEB_DARK_CSS + "<head ", 1)
        return Response(content=html, media_type="text/html; charset=utf-8",
                        headers=_filter_headers(upstream.headers.items()))

    # 其他响应原样转发（JS/CSS/字体/JSON 等）
    resp_headers = _filter_headers(upstream.headers.items())
    return Response(content=upstream.content, media_type=content_type or "application/octet-stream",
                    status_code=upstream.status_code, headers=resp_headers)


_ws_only_http_routes_installed = False
def _ws_only_426(path: str):
    """给 /stream /snapweb/stream 等纯 WebSocket 路径加 426 兜底 HTTP 路由。"""
    def decorator_factory():
        async def _handler():
            return PlainTextResponse(
                content="426 Upgrade Required: this endpoint is WebSocket-only; send Upgrade: websocket header.\n",
                status_code=426,
                headers={"Upgrade": "websocket", "Connection": "Upgrade"},
            )
        return _handler
    # 注册该路径的全部 HTTP 方法
    handler = decorator_factory()
    handler.__name__ = f"http_426_{path.strip('/').replace('/','_') or 'root'}"
    app.add_api_route(path, handler, methods=["GET","POST","PUT","DELETE","PATCH","OPTIONS","HEAD"])

_ws_only_426("/stream")
_ws_only_426("/snapweb/stream")
_ws_only_426("/snapweb/ws")
_ws_only_426("/jsonrpc")  # 额外兜底（我们已经有 HTTP 路由，但不会冲突——HTTP路由和add_api_route同时存在取已注册的）


@app.websocket("/stream")
async def snapweb_stream_ws_proxy(websocket: WebSocket):
    """反向代理 SnapWeb 的音频流 WebSocket（ws://host/stream，SnapWeb 浏览器客户端真实播放音频用）。

    SnapWeb 点击播放按钮后，会 E1（Web Audio snapclient）打开 baseUrl+"/stream" WS，
    接收二进制 PCM/FLAC 帧解码成声音输出；没有这个端点，SnapWeb 只显示控制、无法真正发声。
    """
    await websocket.accept()
    import websockets as _ws
    ws_url = SNAPSERVER_URL.replace("http://", "ws://").replace("https://", "wss://") + "/stream"
    upstream_ws = None
    try:
        async with _ws.connect(ws_url, max_size=None) as upstream_ws:
            async def upstream_to_client():
                try:
                    async for msg in upstream_ws:
                        if isinstance(msg, (bytes, bytearray)):
                            await websocket.send_bytes(bytes(msg))
                        elif isinstance(msg, str):
                            await websocket.send_text(msg)
                except Exception as e:
                    print(f"[stream proxy] upstream→client: {e}")

            async def client_to_upstream():
                try:
                    while True:
                        data = await websocket.receive()
                        if data.get("type") == "websocket.disconnect":
                            break
                        if "bytes" in data:
                            await upstream_ws.send(data["bytes"])
                        elif "text" in data:
                            await upstream_ws.send(data["text"])
                except WebSocketDisconnect:
                    pass
                except Exception as e:
                    print(f"[stream proxy] client→upstream: {e}")

            await asyncio.gather(upstream_to_client(), client_to_upstream())
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[SnapWeb stream WS proxy] error: {e}")
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/snapweb/stream")
async def snapweb_stream_ws_proxy_nested(websocket: WebSocket):
    """兜底：如果 SnapWeb 未来在 /snapweb/ 子路径下请求 /stream，也做代理。"""
    await snapweb_stream_ws_proxy(websocket)


@app.websocket("/snapweb/ws")
async def snapweb_ws_proxy(websocket: WebSocket):
    """反向代理 SnapWeb 的 WebSocket（兜底路径）。"""
    await websocket.accept()
    try:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("GET", f"{SNAPSERVER_URL}/ws") as upstream:
                async for chunk in upstream.aiter_raw():
                    if chunk:
                        await websocket.send_bytes(chunk)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[SnapWeb WS proxy] error: {e}")
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/jsonrpc")
async def snapweb_jsonrpc_ws_proxy(websocket: WebSocket):
    """反向代理 SnapWeb 的 JSON-RPC WebSocket（SnapWeb 基于页面 host 连 ws://host/jsonrpc）。"""
    await websocket.accept()
    # 用 websockets 库连接 snapserver 的 /jsonrpc
    import websockets
    ws_url = SNAPSERVER_URL.replace("http://", "ws://").replace("https://", "wss://") + "/jsonrpc"
    upstream_ws = None
    try:
        async with websockets.connect(ws_url) as upstream_ws:
            # 双向转发
            async def upstream_to_client():
                try:
                    async for msg in upstream_ws:
                        if isinstance(msg, str):
                            await websocket.send_text(msg)
                        else:
                            await websocket.send_bytes(msg)
                except Exception as e:
                    print(f"[jsonrpc proxy] upstream→client: {e}")

            async def client_to_upstream():
                try:
                    while True:
                        msg = await websocket.receive()
                        if msg.get("type") == "websocket.disconnect":
                            break
                        if "text" in msg:
                            await upstream_ws.send(msg["text"])
                        elif "bytes" in msg:
                            await upstream_ws.send(msg["bytes"])
                except WebSocketDisconnect:
                    pass
                except Exception as e:
                    print(f"[jsonrpc proxy] client→upstream: {e}")

            await asyncio.gather(upstream_to_client(), client_to_upstream())
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[jsonrpc WS proxy] error: {e}")
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@app.api_route("/jsonrpc", methods=["POST", "GET"])
async def snapweb_jsonrpc_http_proxy(request: Request):
    """反向代理 SnapWeb 的 JSON-RPC HTTP 请求（SnapWeb 也可能用 POST 而非 WS）。"""
    body = await request.body()
    fwd_headers = _filter_headers(request.headers.items())
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            upstream = await client.request(
                request.method, f"{SNAPSERVER_URL}/jsonrpc",
                headers=fwd_headers, content=body,
            )
        except Exception as e:
            return Response(content=f"SnapWeb jsonrpc proxy error: {e}", status_code=502)
    return Response(content=upstream.content, media_type="application/json",
                    status_code=upstream.status_code,
                    headers=_filter_headers(upstream.headers.items()))


# ─── Serve player UI ───────────────────────────────────────────────────────
PLAYER_DIR = Path("/app/player")
if PLAYER_DIR.exists():
    app.mount("/", StaticFiles(directory=str(PLAYER_DIR), html=True), name="player")


# ─── Main ──────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
