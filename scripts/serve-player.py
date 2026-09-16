#!/usr/bin/env python3
"""本地播放器静态服务（8017）：与生产 nginx 同策略——SPA 入口 no-cache，assets 可长缓存。

为什么不用 python -m http.server：它只发 Last-Modified，浏览器启发式缓存会抱住旧 index.html，
导致旧 bundle 引旧 manifest 的幽灵 404（2026-08-28 just_listen/04_narrator.mp3 假告警事故）。

用法：python3 scripts/serve-player.py   （在 apps/player/dist 上起 8017）
"""
import http.server
import functools
from pathlib import Path

DIST = Path(__file__).parent.parent / "apps" / "player" / "dist"
PORT = 8017


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        if self.path.endswith(".html") or self.path == "/" or self.path.endswith("manifest.json"):
            # SPA 入口 + 语音清单：每次必拿最新
            self.send_header("Cache-Control", "no-cache")
        elif "/assets/" in self.path:
            # vite hash 产物：内容定哈希，可永久缓存
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        super().end_headers()


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(
        ("127.0.0.1", PORT), functools.partial(Handler, directory=str(DIST))
    ).serve_forever()
