#!/usr/bin/env python3
"""星露谷本地预览服务器 —— 故意不发任何缓存头。

为什么不用 `python3 -m http.server`：
  这个目录里的 index.html 会被反复修改，而有些写入方式**不改 mtime**。
  浏览器拿 If-Modified-Since 一问，服务器看 mtime 没变就回 304，
  页面就一直是旧版 —— 2026-10-21 踩过一次（改了 9 处，手机上还是旧界面）。
  这里对所有响应加 no-store，改完刷新就一定是新的。

用法：
    cd /sdcard/Download/WeiXin/星露谷
    python3 _serve.py          # 默认 8777
    python3 _serve.py 8080     # 换端口
"""
import http.server
import socketserver
import sys
import os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        # 只记非 200，别把控制台刷满
        if args and str(args[1]) not in ('200', '304'):
            super().log_message(fmt, *args)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(('127.0.0.1', PORT), Handler) as srv:
    print('星露谷预览: http://127.0.0.1:%d/  （no-store，改完刷新即可）' % PORT)
    srv.serve_forever()
