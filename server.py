#!/usr/bin/env python3
"""Static file server for the MSE segmented player demo.

Beyond ordinary file serving it supports:
  * HTTP Range requests (required to exercise real segmented fetch behavior);
  * artificial latency (base + jitter) via runtime knobs;
  * per-request failure injection (status 503) and byte truncation (206 with
    a shortened body) to test download/decode error recovery;
  * a JSON control API so the browser UI and the automated suite can mutate
    knobs without restarting the server.

Knobs:
  GET  /api/knobs            -> current configuration
  POST /api/knobs            -> merge JSON configuration
  GET  /api/stats            -> request counters
  Any media URL may carry ?fail=1 / ?truncate=1 for one-shot injection.
"""
import json
import os
import random
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public')

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webm': 'video/webm',
    '.mpd': 'application/dash+xml',
    '.svg': 'image/svg+xml',
}

_lock = threading.Lock()
KNOBS = {
    'latencyBaseMs': 0,
    'latencyJitterMs': 0,
    'failRate': 0.0,        # probability a media request returns 503
    'truncateRate': 0.0,    # probability a media segment is delivered short
    'minBytes': 64,         # truncation keeps at least this many bytes
}
STATS = {'requests': 0, 'failures': 0, 'truncated': 0, 'rangeRequests': 0, 'errors': 0}


def _is_media(path):
    return path.endswith(('.webm', '.mp4', '.m4s'))


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'MseDemo/1.0'

    def log_message(self, fmt, *args):  # quiet by default; tests read stats instead
        if os.environ.get('DEMO_HTTP_LOG'):
            super().log_message(fmt, *args)

    # -- helpers -----------------------------------------------------------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _apply_latency(self):
        with _lock:
            base = KNOBS['latencyBaseMs']
            jitter = KNOBS['latencyJitterMs']
        if base or jitter:
            time.sleep(max(0, (base + random.uniform(0, jitter)) / 1000.0))

    def _resolve(self, url_path):
        # Map URL to a file under ROOT, rejecting traversal.
        rel = url_path.lstrip('/')
        full = os.path.normpath(os.path.join(ROOT, rel))
        if full != ROOT and not full.startswith(ROOT + os.sep):
            return None
        return full

    # -- routing -----------------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == '/api/knobs':
            with _lock:
                return self._send_json(KNOBS)
        if parsed.path == '/api/stats':
            with _lock:
                return self._send_json(STATS)
        return self._serve_file(parsed, query)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != '/api/knobs':
            self._send_json({'error': 'not found'}, 404)
            return
        length = int(self.headers.get('Content-Length') or 0)
        try:
            payload = json.loads(self.rfile.read(length).decode() or '{}')
            if not isinstance(payload, dict):
                raise ValueError
        except (ValueError, UnicodeDecodeError):
            return self._send_json({'error': 'invalid JSON'}, 400)
        with _lock:
            changed = {}
            for key, value in payload.items():
                if key not in KNOBS:
                    continue
                if key in ('failRate', 'truncateRate'):
                    value = min(1.0, max(0.0, float(value)))
                elif key in ('latencyBaseMs', 'latencyJitterMs', 'minBytes'):
                    value = max(0, int(value))
                KNOBS[key] = value
                changed[key] = KNOBS[key]
            snapshot = dict(KNOBS)
        self._send_json({'changed': changed, 'knobs': snapshot})

    # -- file serving ------------------------------------------------------
    def _serve_file(self, parsed, query):
        url_path = parsed.path
        if url_path in ('/', ''):
            url_path = '/index.html'
        full = self._resolve(url_path)
        if full is None or not os.path.isfile(full):
            with _lock:
                STATS['errors'] += 1
            return self._send_json({'error': 'not found'}, 404)

        self._apply_latency()
        with _lock:
            STATS['requests'] += 1
            knobs = dict(KNOBS)

        size = os.path.getsize(full)
        media = _is_media(parsed.path)
        force_fail = query.get('fail') == ['1']
        force_truncate = query.get('truncate') == ['1']
        roll = random.random()
        do_fail = media and (force_fail or roll < knobs['failRate'])
        do_truncate = media and not do_fail and (
            force_truncate or roll < knobs['truncateRate']
        )

        if do_fail:
            with _lock:
                STATS['failures'] += 1
            body = b'{"error":"injected failure"}'
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
            return

        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext, 'application/octet-stream')

        # Parse a single byte range; ignore multipart ranges deliberately.
        range_header = self.headers.get('Range')
        start, end = 0, size - 1
        is_range = False
        if range_header and range_header.startswith('bytes='):
            spec = range_header[6:].split(',')[0].strip()
            try:
                if spec.endswith('-'):
                    start = int(spec[:-1])
                elif spec.startswith('-'):
                    start = max(0, size - int(spec[1:]))
                else:
                    s, e = spec.split('-')
                    start, end = int(s), int(e)
                end = min(end, size - 1)
                is_range = start <= end < size
            except (ValueError, IndexError):
                is_range = False

        if is_range:
            with _lock:
                STATS['rangeRequests'] += 1
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        else:
            start, end = 0, size - 1
            self.send_response(200)
            self.send_header('Accept-Ranges', 'bytes')

        length = end - start + 1
        if do_truncate and length > knobs['minBytes']:
            length = max(knobs['minBytes'], length // 2)
            with _lock:
                STATS['truncated'] += 1
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(length))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()

        try:
            with open(full, 'rb') as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    port = int(os.environ.get('DEMO_PORT', '8080'))
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'MSE demo server on http://127.0.0.1:{port} (root={ROOT})')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
