#!/usr/bin/env python3
"""Lightweight mobile-friendly Web console & image viewer bridge for Antigravity CLI (`agy`).

Zero external dependencies (Python standard library only).
"""

from __future__ import annotations

import argparse
import signal
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any

from agy_web.config import (
    DEFAULT_AGY_BIN,
    DEFAULT_CWD,
    DEFAULT_HOST,
    DEFAULT_MODE,
    DEFAULT_PORT,
    detect_tailscale_ipv4,
)
from agy_web.handler import make_handler
from agy_web.session import SessionManager


class QuietHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def handle_error(self, request: Any, client_address: Any) -> None:
        _, exc, _ = sys.exc_info()
        if isinstance(exc, (ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="AGY Mobile Web Console (Tailscale / Localhost)")
    parser.add_argument("--host", type=str, default=DEFAULT_HOST, help=f"Bind host (default {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Bind port (default {DEFAULT_PORT})")
    parser.add_argument("--tailscale", action="store_true", help="Auto-bind to local Tailscale IPv4")
    parser.add_argument("--cwd", type=Path, default=DEFAULT_CWD, help="Working directory for agy")
    parser.add_argument("--agy-bin", type=str, default=DEFAULT_AGY_BIN, help="Path to agy executable")
    parser.add_argument(
        "--mode", type=str, default=DEFAULT_MODE, choices=["auto", "accept-edits", "plan"], help="agy --mode"
    )
    parser.add_argument("--conversation", type=str, default=None, help="Optional initial conversation ID to resume")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    host = args.host
    if args.tailscale:
        ts_ip = detect_tailscale_ipv4()
        if not ts_ip:
            print("[Error] Tailscale IPv4 not detected. Run `sudo tailscale up` first.", file=sys.stderr)
            sys.exit(1)
        host = ts_ip

    session = SessionManager(
        agy_bin=args.agy_bin,
        cwd=args.cwd,
        mode=args.mode,
        initial_conversation_id=args.conversation,
    )
    if args.conversation:
        session.load_existing(args.conversation)

    server = QuietHTTPServer((host, args.port), make_handler(session))
    print(f"[AGY Console] Listening on http://{host}:{args.port}")
    print(f"[AGY Console] Workspace: {session.cwd} | mode={args.mode}")

    def _shutdown(signum: int, _frame: Any) -> None:
        print("\n[AGY Console] Shutting down...")
        session.stop()
        threading.Thread(target=server.shutdown, daemon=True).start()

    try:
        signal.signal(signal.SIGINT, _shutdown)
        signal.signal(signal.SIGTERM, _shutdown)
    except (ValueError, AttributeError):
        pass
    server.serve_forever()


if __name__ == "__main__":
    main()
