"""HTTP RequestHandler and routing logic for AGY Mobile Web."""

from __future__ import annotations

import json
import mimetypes
import queue
import subprocess
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, Dict, List, Optional

from .config import IMAGE_EXTS, SAFE_FILE_EXTS, STATIC_DIR, get_cli_default_model
from .files import is_within_roots, list_recent_images
from .session import SessionManager
from .transcript import _save_session_name, list_existing_conversations


FALLBACK_MODELS = [
    {"id": "gemini-4-hydrogen-medium", "label": "Gemini 4 Hydrogen (Medium)"},
    {"id": "gemini-4-hydrogen-high", "label": "Gemini 4 Hydrogen (High)"},
    {"id": "gemini-4-carbon-medium", "label": "Gemini 4 Carbon (Medium)"},
    {"id": "gemini-4-carbon-high", "label": "Gemini 4 Carbon (High)"},
    {"id": "gemini-3.8-flash-medium", "label": "Gemini 3.8 Flash (Medium)"},
    {"id": "gemini-3.8-flash-high", "label": "Gemini 3.8 Flash (High)"},
    {"id": "gemini-3.7-flash-medium", "label": "Gemini 3.7 Flash (Medium)"},
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


def make_handler(session: SessionManager):
    class BridgeHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            return

        def _send_json(self, data: Any, status: int = 200) -> None:
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
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
                self._send_json(session.snapshot())
                return

            if parsed.path == "/api/conversations":
                self._send_json({"conversations": list_existing_conversations(limit=30)})
                return

            if parsed.path == "/api/models":
                if session._cached_models is None:
                    session._cached_models = list_available_models(session.agy_bin)
                cli_def = get_cli_default_model()
                self._send_json({"models": session._cached_models, "default": cli_def})
                return

            if parsed.path == "/api/recent-images":
                self._send_json({"images": list_recent_images(session.cwd, limit=10)})
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
                if not is_within_roots(resolved, session.allowed_roots) or not resolved.is_dir():
                    self._send_json({"error": "forbidden or not a directory"}, status=403)
                    return
                parent = resolved.parent
                parent_str = str(parent) if (parent != resolved and is_within_roots(parent, session.allowed_roots)) else None
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
                if not is_within_roots(resolved, session.allowed_roots) or not resolved.is_file():
                    self._send_json({"error": "forbidden or not found"}, status=403)
                    return
                if resolved.stat().st_size > 256 * 1024:
                    raw_bytes = resolved.read_bytes()[: 256 * 1024]
                    content = raw_bytes.decode("utf-8", errors="replace") + "\n\n... (truncated at 256KB)"
                else:
                    content = resolved.read_text(encoding="utf-8", errors="replace")
                self._send_json({"path": str(resolved), "content": content})
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
                if not is_within_roots(resolved, session.allowed_roots):
                    self._send_json({"error": "forbidden"}, status=403)
                    return
                if not resolved.is_file() or resolved.suffix.lower() not in SAFE_FILE_EXTS:
                    self._send_json({"error": "not found or unsupported"}, status=404)
                    return
                is_thumb = qs.get("thumb", ["0"])[0] == "1"
                st = resolved.stat()
                etag = f'"{st.st_mtime_ns}-{st.st_size}-{int(is_thumb)}"'
                if self.headers.get("If-None-Match") == etag:
                    self.send_response(HTTPStatus.NOT_MODIFIED)
                    self.send_header("ETag", etag)
                    self.send_header("Cache-Control", "public, max-age=300")
                    self.end_headers()
                    return

                ctype, _ = mimetypes.guess_type(str(resolved))
                data: Optional[bytes] = None
                if is_thumb and resolved.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
                    cache_key = (str(resolved), st.st_mtime_ns)
                    cached = getattr(session, "_thumb_cache", {}).get(cache_key)
                    if cached is not None:
                        data = cached
                        ctype = "image/jpeg"
                    else:
                        try:
                            import io
                            from collections import OrderedDict
                            from PIL import Image

                            with Image.open(resolved) as im:
                                im.thumbnail((480, 480))
                                if im.mode != "RGB":
                                    im = im.convert("RGB")
                                buf = io.BytesIO()
                                im.save(buf, format="JPEG", quality=75, optimize=True)
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

            if parsed.path == "/api/reset":
                raw_cwd = str(body.get("cwd") or "").strip()
                ok, info = session.reset(cwd=raw_cwd or None)
                self._send_json({"ok": ok, "cwd": info if ok else None, "error": None if ok else info}, status=200 if ok else 400)
                return

            self._send_json({"error": "not found"}, status=404)

    return BridgeHandler
