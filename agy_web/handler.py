"""HTTP RequestHandler and routing logic for AGY Mobile Web."""

from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import queue
import secrets
import subprocess
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .config import (
    AUTHORIZED_DEVICES_FILE,
    IMAGE_EXTS,
    SAFE_FILE_EXTS,
    STATIC_DIR,
    get_cli_default_model,
    load_nodes,
)
from .files import get_recent_conversation_images, is_within_roots, list_recent_images
from .proxy import NodeProxyManager
from .session import SessionManager
from .transcript import _save_session_name, list_existing_conversations


FALLBACK_MODELS = [
    {"id": "gemini-4-neon-medium", "label": "Gemini 4 Neon (Medium)"},
    {"id": "gemini-4-neon-high", "label": "Gemini 4 Neon (High)"},
    {"id": "gemini-4-neon-xhigh", "label": "Gemini 4 Neon (XHigh)"},
    {"id": "gemini-4-neon-low", "label": "Gemini 4 Neon (Low)"},
    {"id": "gemini-4-argon-medium", "label": "Gemini 4 Argon (Medium)"},
    {"id": "gemini-4-argon-high", "label": "Gemini 4 Argon (High)"},
    {"id": "gemini-4-argon-low", "label": "Gemini 4 Argon (Low)"},
    {"id": "gemini-4-hydrogen-medium", "label": "Gemini 4 Hydrogen (Medium)"},
    {"id": "gemini-4-hydrogen-high", "label": "Gemini 4 Hydrogen (High)"},
    {"id": "gemini-4-hydrogen-xhigh", "label": "Gemini 4 Hydrogen (XHigh)"},
    {"id": "gemini-4-hydrogen-low", "label": "Gemini 4 Hydrogen (Low)"},
    {"id": "gemini-3.8-flash-medium", "label": "Gemini 3.8 Flash (Medium)"},
    {"id": "gemini-3.8-flash-high", "label": "Gemini 3.8 Flash (High)"},
    {"id": "gemini-3.8-flash-low", "label": "Gemini 3.8 Flash (Low)"},
]


def list_available_models(agy_bin: str) -> List[Dict[str, str]]:
    try:
        out = subprocess.check_output([agy_bin, "models"], text=True, stderr=subprocess.STDOUT, timeout=15)
        models: List[Dict[str, str]] = []
        for line in out.splitlines():
            line = line.strip()
            if not line or line.startswith("⠋") or "Fetching available models" in line:
                continue
            if "\t" in line:
                mid, label = line.split("\t", 1)
                models.append({"id": mid.strip(), "label": label.strip()})
            elif "  " in line:
                parts = [p.strip() for p in re.split(r"\s{2,}", line, maxsplit=1) if p.strip()]
                if len(parts) == 2:
                    models.append({"id": parts[0], "label": parts[1]})
        return models or FALLBACK_MODELS
    except Exception:
        return FALLBACK_MODELS


_LOGIN_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <meta name="theme-color" content="#0f172a" />
  <title>AGY Console · Login</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0b1120; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 20px;
    }
    .card {
      width: 100%; max-width: 360px; background: #0f172a; border: 1px solid #1e293b;
      border-radius: 14px; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.4);
    }
    h1 { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
    p { margin: 0 0 18px; font-size: 13px; color: #94a3b8; }
    input {
      width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid #334155;
      background: #020617; color: #f8fafc; font-size: 16px; outline: none; margin-bottom: 12px;
    }
    input:focus { border-color: #38bdf8; }
    button {
      width: 100%; padding: 12px; border-radius: 10px; border: none; background: #2563eb;
      color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
    }
    button:disabled { opacity: 0.6; }
    .err { color: #f87171; font-size: 13px; margin-top: 10px; min-height: 18px; }
  </style>
</head>
<body>
  <form class="card" id="f">
    <h1>AGY Console</h1>
    <p>请输入访问密码以继续</p>
    <input id="pw" type="password" autocomplete="current-password" placeholder="Password" autofocus required />
    <button id="btn" type="submit">登录</button>
    <div class="err" id="err"></div>
  </form>
  <script>
    const f = document.getElementById('f');
    const pw = document.getElementById('pw');
    const btn = document.getElementById('btn');
    const err = document.getElementById('err');
    f.onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = '';
      btn.disabled = true;
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw.value })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          location.replace('/');
        } else {
          err.textContent = data.error || '密码错误';
          pw.select();
        }
      } catch (_) {
        err.textContent = '网络错误，请重试';
      } finally {
        btn.disabled = false;
      }
    };
  </script>
</body>
</html>"""


class _DeviceAuthStore:
    """Persists bound device tokens in `authorized_devices.json` and enforces max_devices."""

    def __init__(self, auth_password: str, max_devices: int) -> None:
        self._lock = threading.Lock()
        self.auth_password = auth_password
        self.max_devices = max_devices
        self._fail_count = 0
        self._locked_until = 0.0
        self._secret = ""
        self._devices: List[Dict[str, str]] = []
        self._load()

    def _load(self) -> None:
        data: Dict[str, Any] = {}
        if AUTHORIZED_DEVICES_FILE.is_file():
            try:
                loaded = json.loads(AUTHORIZED_DEVICES_FILE.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    data = loaded
            except Exception:
                data = {}
        secret = str(data.get("secret") or "").strip()
        if not secret:
            secret = secrets.token_hex(32)
        devices = data.get("devices")
        if not isinstance(devices, list):
            devices = []
        self._secret = secret
        self._devices = [d for d in devices if isinstance(d, dict) and d.get("id")]
        self._save()

    def _save(self) -> None:
        try:
            AUTHORIZED_DEVICES_FILE.write_text(
                json.dumps({"secret": self._secret, "devices": self._devices}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass

    def _sign(self, dev_id: str) -> str:
        key = f"{self._secret}:{self.auth_password}".encode("utf-8")
        return hmac.new(key, dev_id.encode("utf-8"), hashlib.sha256).hexdigest()

    def verify_cookie(self, token: str) -> Optional[str]:
        if "." not in token:
            return None
        dev_id, sig = token.split(".", 1)
        if not dev_id or not hmac.compare_digest(sig, self._sign(dev_id)):
            return None
        with self._lock:
            if any(d.get("id") == dev_id for d in self._devices):
                return dev_id
        return None

    def try_login(self, password: str, existing_token: str, user_agent: str) -> Tuple[int, Optional[str], str]:
        now = time.monotonic()
        with self._lock:
            if now < self._locked_until:
                wait_s = int(self._locked_until - now) + 1
                return 429, None, f"尝试次数过多，请 {wait_s} 秒后再试"
        if not hmac.compare_digest(password.encode("utf-8"), self.auth_password.encode("utf-8")):
            time.sleep(0.3)
            with self._lock:
                self._fail_count += 1
                if self._fail_count >= 5:
                    self._locked_until = time.monotonic() + 60.0
                    self._fail_count = 0
            return 401, None, "密码错误"

        with self._lock:
            self._fail_count = 0
            self._locked_until = 0.0

        existing_id = self.verify_cookie(existing_token) if existing_token else None
        with self._lock:
            if existing_id:
                return 200, f"{existing_id}.{self._sign(existing_id)}", ""
            if self.max_devices > 0 and len(self._devices) >= self.max_devices:
                return 403, None, "已达最大授权设备数上限，拒绝新设备登录"
            dev_id = secrets.token_hex(16)
            self._devices.append({
                "id": dev_id,
                "ua": user_agent[:120],
                "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            })
            self._save()
            return 200, f"{dev_id}.{self._sign(dev_id)}", ""


def make_handler(session: SessionManager, auth_password: str = "", max_devices: int = 0):
    proxy_mgr = NodeProxyManager(load_nodes())
    auth_store = _DeviceAuthStore(auth_password, max_devices) if auth_password else None

    class BridgeHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            return

        def _get_auth_cookie(self) -> str:
            raw_cookie = self.headers.get("Cookie", "")
            if not raw_cookie:
                return ""
            c = SimpleCookie()
            try:
                c.load(raw_cookie)
            except Exception:
                return ""
            morsel = c.get("agy_auth")
            return morsel.value if morsel else ""

        def _is_authed(self) -> bool:
            if auth_store is None:
                return True
            return auth_store.verify_cookie(self._get_auth_cookie()) is not None

        def _send_login_page(self) -> None:
            body = _LOGIN_HTML.encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, data: Any, status: int = 200) -> None:
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _proxy_if_remote(self, parsed: urllib.parse.ParseResult, method: str, raw_body: Optional[bytes] = None) -> bool:
            if not parsed.path.startswith("/api/") or parsed.path in ("/api/login", "/api/nodes"):
                return False
            params = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
            node_id = ""
            kept = []
            for k, v in params:
                if k == "node" and not node_id:
                    node_id = v.strip()
                else:
                    kept.append((k, v))
            if not node_id or not proxy_mgr.is_remote(node_id):
                return False
            clean_q = urllib.parse.urlencode(kept)
            clean_path = f"{parsed.path}?{clean_q}" if clean_q else parsed.path

            if method == "GET" and parsed.path == "/api/events":
                conn, resp = proxy_mgr.open_sse(node_id, clean_path)
                if conn is None or resp is None:
                    self._send_json({"error": "upstream sse unavailable"}, status=502)
                    return True
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.end_headers()
                try:
                    while True:
                        line = resp.readline()
                        if not line:
                            break
                        self.wfile.write(line)
                        if line in (b"\n", b"\r\n"):
                            self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                finally:
                    try:
                        conn.close()
                    except Exception:
                        pass
                return True

            ctype = self.headers.get("Content-Type", "")
            status, out_headers, resp_body = proxy_mgr.proxy_http(
                node_id, method, clean_path, body=raw_body, content_type=ctype
            )
            self.send_response(status)
            for hk, hv in out_headers:
                self.send_header(hk, hv)
            self.send_header("Content-Length", str(len(resp_body)))
            self.end_headers()
            self.wfile.write(resp_body)
            return True

        def do_GET(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/login":
                if self._is_authed():
                    self.send_response(HTTPStatus.FOUND)
                    self.send_header("Location", "/")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self._send_login_page()
                return

            if parsed.path == "/manifest.json":
                self._send_json({
                    "name": "AGY Console",
                    "short_name": "AGY",
                    "start_url": "/",
                    "display": "standalone",
                    "background_color": "#0b1120",
                    "theme_color": "#0f172a",
                })
                return

            if not self._is_authed():
                if parsed.path == "/":
                    self._send_login_page()
                else:
                    self._send_json({"error": "unauthorized"}, status=401)
                return

            if parsed.path == "/api/nodes":
                self._send_json({"nodes": proxy_mgr.list_public_nodes()})
                return

            if self._proxy_if_remote(parsed, "GET"):
                return

            if parsed.path == "/":
                index_path = STATIC_DIR / "index.html"
                if not index_path.is_file():
                    self._send_json({"error": "index.html not found"}, status=404)
                    return
                body = index_path.read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(body)
                return

            if parsed.path.startswith("/static/"):
                rel_path = parsed.path[len("/static/") :].lstrip("/")
                target = (STATIC_DIR / rel_path).resolve()
                if not is_within_roots(target, [STATIC_DIR]) or not target.is_file():
                    self._send_json({"error": "not found"}, status=404)
                    return
                ctype, _ = mimetypes.guess_type(str(target))
                if target.suffix == ".css":
                    ctype = "text/css; charset=utf-8"
                elif target.suffix == ".js":
                    ctype = "application/javascript; charset=utf-8"
                elif target.suffix == ".html":
                    ctype = "text/html; charset=utf-8"
                body = target.read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", ctype or "application/octet-stream")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(body)
                return

            if parsed.path == "/manifest.json":
                self._send_json({
                    "name": "AGY Console",
                    "short_name": "AGY",
                    "start_url": "/",
                    "display": "standalone",
                    "background_color": "#0b1120",
                    "theme_color": "#0f172a",
                })
                return

            if parsed.path == "/api/state":
                qs = urllib.parse.parse_qs(parsed.query)
                show_all = qs.get("all", [""])[0] == "1"
                self._send_json(session.snapshot(limit=None if show_all else 60))
                return

            if parsed.path == "/api/conversations":
                self._send_json({"conversations": list_existing_conversations(limit=30)})
                return

            if parsed.path == "/api/models":
                qs = urllib.parse.parse_qs(parsed.query)
                force_refresh = qs.get("refresh", [""])[0] == "1"
                if force_refresh:
                    session._cached_models = list_available_models(session.agy_bin)
                models = session._cached_models if session._cached_models is not None else FALLBACK_MODELS
                cli_def = get_cli_default_model()
                self._send_json({"models": models, "default": cli_def})
                return

            if parsed.path == "/api/recent-images":
                self._send_json({"images": get_recent_conversation_images(session, limit=30)})
                return

            if parsed.path == "/api/browse":
                qs = urllib.parse.parse_qs(parsed.query)
                raw_dir = qs.get("dir", [""])[0]
                target = Path(raw_dir) if raw_dir else session.cwd
                try:
                    resolved = target.resolve()
                except OSError:
                    self._send_json({"error": "invalid directory"}, status=400)
                    return
                if not resolved.is_dir():
                    self._send_json({"error": "not a directory"}, status=404)
                    return
                parent = resolved.parent
                parent_str = str(parent) if parent != resolved else None
                entries = []
                try:
                    for item in sorted(resolved.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
                        if item.name in {".git", "__pycache__", "node_modules", ".pytest_cache"}:
                            continue
                        try:
                            is_d = item.is_dir()
                            sz = 0 if is_d else item.stat().st_size
                        except OSError:
                            continue
                        entries.append({
                            "name": item.name,
                            "path": str(item.resolve()),
                            "is_dir": is_d,
                            "size": sz,
                            "is_image": (not is_d) and (item.suffix.lower() in IMAGE_EXTS),
                        })
                except OSError as exc:
                    self._send_json({"error": str(exc)}, status=500)
                    return
                self._send_json({"current_dir": str(resolved), "parent_dir": parent_str, "entries": entries})
                return

            if parsed.path == "/api/read-text":
                qs = urllib.parse.parse_qs(parsed.query)
                raw_path = qs.get("path", [""])[0]
                if not raw_path:
                    self._send_json({"error": "missing path"}, status=400)
                    return
                target = Path(raw_path)
                if not target.is_absolute():
                    target = session.cwd / target
                try:
                    resolved = target.resolve()
                except OSError:
                    self._send_json({"error": "invalid path"}, status=400)
                    return
                if not resolved.is_file():
                    self._send_json({"error": "not found or not a file"}, status=404)
                    return
                if resolved.stat().st_size > 256 * 1024:
                    raw_bytes = resolved.read_bytes()[: 256 * 1024]
                    content = raw_bytes.decode("utf-8", errors="replace") + "\n\n... (truncated at 256KB)"
                else:
                    content = resolved.read_text(encoding="utf-8", errors="replace")
                self._send_json({"path": str(resolved), "content": content})
                return

            if parsed.path == "/api/file-info":
                qs = urllib.parse.parse_qs(parsed.query)
                raw_path = qs.get("path", [""])[0]
                if not raw_path:
                    self._send_json({"error": "missing path"}, status=400)
                    return
                target = Path(raw_path)
                if not target.is_absolute():
                    target = session.cwd / target
                try:
                    resolved = target.resolve()
                except OSError:
                    self._send_json({"error": "invalid path"}, status=400)
                    return
                if not resolved.is_file() or resolved.suffix.lower() not in SAFE_FILE_EXTS:
                    self._send_json({"error": "not found or unsupported"}, status=404)
                    return
                self._send_json({"size": resolved.stat().st_size, "name": resolved.name})
                return

            if parsed.path == "/api/file":
                qs = urllib.parse.parse_qs(parsed.query)
                raw_path = qs.get("path", [""])[0]
                if not raw_path:
                    self._send_json({"error": "missing path"}, status=400)
                    return
                target = Path(raw_path)
                if not target.is_absolute():
                    target = session.cwd / target
                try:
                    resolved = target.resolve()
                except OSError:
                    self._send_json({"error": "invalid path"}, status=400)
                    return
                if not resolved.is_file() or resolved.suffix.lower() not in SAFE_FILE_EXTS:
                    self._send_json({"error": "not found or unsupported"}, status=404)
                    return
                is_thumb = qs.get("thumb", ["0"])[0] == "1"
                is_preview = qs.get("preview", ["0"])[0] == "1"
                mode_tag = "thumb" if is_thumb else ("preview" if is_preview else "orig")
                st = resolved.stat()
                etag = f'"{st.st_mtime_ns}-{st.st_size}-{mode_tag}"'
                if self.headers.get("If-None-Match") == etag:
                    self.send_response(HTTPStatus.NOT_MODIFIED)
                    self.send_header("ETag", etag)
                    self.send_header("Cache-Control", "public, max-age=300")
                    self.end_headers()
                    return

                ctype, _ = mimetypes.guess_type(str(resolved))
                data: Optional[bytes] = None
                if (is_thumb or is_preview) and resolved.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
                    cache_key = (str(resolved), st.st_mtime_ns, mode_tag)
                    cached = getattr(session, "_thumb_cache", {}).get(cache_key)
                    if cached is not None:
                        data = cached
                        ctype = "image/jpeg"
                    else:
                        try:
                            import io
                            from collections import OrderedDict
                            from PIL import Image

                            max_dim = (480, 480) if is_thumb else (1440, 1440)
                            quality = 75 if is_thumb else 82
                            with Image.open(resolved) as im:
                                im.thumbnail(max_dim)
                                if im.mode != "RGB":
                                    im = im.convert("RGB")
                                buf = io.BytesIO()
                                im.save(buf, format="JPEG", quality=quality, optimize=True)
                                data = buf.getvalue()
                                ctype = "image/jpeg"
                                tc = getattr(session, "_thumb_cache", None)
                                if tc is None:
                                    tc = OrderedDict()
                                    session._thumb_cache = tc
                                tc[cache_key] = data
                                if len(tc) > 32:
                                    tc.popitem(last=False)
                        except Exception:
                            data = None

                if data is None:
                    data = resolved.read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", ctype or "application/octet-stream")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", "public, max-age=300")
                self.end_headers()
                self.wfile.write(data)
                return

            if parsed.path == "/api/events":
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.end_headers()
                q = session.subscribe()
                try:
                    init_msg = json.dumps({"type": "state", "state": session.snapshot()}, ensure_ascii=False)
                    self.wfile.write(f"data: {init_msg}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    while True:
                        try:
                            msg = q.get(timeout=15)
                            self.wfile.write(f"data: {msg}\n\n".encode("utf-8"))
                        except queue.Empty:
                            self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                finally:
                    session.unsubscribe(q)
                return

            self._send_json({"error": "not found"}, status=404)

        def do_POST(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            length = int(self.headers.get("Content-Length", "0") or "0")
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                body = json.loads(raw.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                self._send_json({"error": "invalid json"}, status=400)
                return

            if parsed.path == "/api/login":
                if auth_store is None:
                    self._send_json({"ok": True})
                    return
                pw = str(body.get("password", ""))
                ua = self.headers.get("User-Agent", "")
                status, token, err_msg = auth_store.try_login(pw, self._get_auth_cookie(), ua)
                if status == 200 and token:
                    res_body = json.dumps({"ok": True}, ensure_ascii=False).encode("utf-8")
                    self.send_response(HTTPStatus.OK)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(res_body)))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header(
                        "Set-Cookie",
                        f"agy_auth={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000",
                    )
                    self.end_headers()
                    self.wfile.write(res_body)
                else:
                    self._send_json({"ok": False, "error": err_msg}, status=status)
                return

            if not self._is_authed():
                self._send_json({"error": "unauthorized"}, status=401)
                return

            if self._proxy_if_remote(parsed, "POST", raw):
                return

            if parsed.path == "/api/chat":
                prompt = str(body.get("prompt", "")).strip()
                if not prompt:
                    self._send_json({"error": "empty prompt"}, status=400)
                    return
                immediate = bool(body.get("immediate", False))
                ok, msg = session.start_turn(prompt, immediate=immediate)
                self._send_json({"ok": ok, "message": msg}, status=200 if ok else 409)
                return

            if parsed.path == "/api/load-conversation":
                cid = str(body.get("conversation_id", "")).strip()
                ok, info = session.load_existing(cid)
                self._send_json({"ok": ok, "summary": info, "error": None if ok else info}, status=200 if ok else 400)
                return

            if parsed.path == "/api/rename-conversation":
                cid = str(body.get("conversation_id", "")).strip()
                name = str(body.get("name", "")).strip()
                if not cid:
                    self._send_json({"error": "missing conversation_id"}, status=400)
                    return
                _save_session_name(cid, name)
                session._broadcast_state()
                self._send_json({"ok": True, "conversation_id": cid, "name": name})
                return

            if parsed.path == "/api/delete-conversation":
                cid = str(body.get("conversation_id", "")).strip()
                ok, info = session.delete_conversation(cid)
                self._send_json({"ok": ok, "message": info, "error": None if ok else info}, status=200 if ok else 400)
                return

            if parsed.path == "/api/settings":
                session.update_settings(mode=body.get("mode"), model=body.get("model"))
                self._send_json({"ok": True})
                return

            if parsed.path == "/api/stop":
                session.stop()
                self._send_json({"ok": True})
                return

            if parsed.path == "/api/refresh-quota":
                started = session.trigger_quota_refresh(min_interval=5.0)
                self._send_json({"ok": True, "started": started})
                return

            if parsed.path == "/api/reset":
                raw_cwd = str(body.get("cwd") or "").strip()
                ok, info = session.reset(cwd=raw_cwd or None)
                self._send_json({"ok": ok, "cwd": info if ok else None, "error": None if ok else info}, status=200 if ok else 400)
                return

            self._send_json({"error": "not found"}, status=404)

    return BridgeHandler
