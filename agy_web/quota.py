"""Fetch 5h / Weekly quota percentages via interactive `agy` `/usage` in a PTY."""

from __future__ import annotations

import fcntl
import os
import pty
import re
import select
import signal
import struct
import termios
import time
from typing import Dict, Optional

_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")


def _strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


def _fmt_pct(raw: str) -> str:
    try:
        return f"{round(float(raw))}%"
    except ValueError:
        return f"{raw}%"


def _parse_group_quota(section: str) -> Optional[Dict[str, str]]:
    weekly_m = re.search(r"Weekly Limit Remaining[\s\S]{0,160}?(\d+(?:\.\d+)?)%", section)
    h5_m = re.search(r"Five Hour Limit Remaining[\s\S]{0,160}?(\d+(?:\.\d+)?)%", section)
    if not weekly_m and not h5_m:
        return None
    return {
        "weekly": _fmt_pct(weekly_m.group(1)) if weekly_m else "-",
        "h5": _fmt_pct(h5_m.group(1)) if h5_m else "-",
    }


def parse_usage_output(clean: str) -> Dict[str, Dict[str, str]]:
    """Parse GEMINI MODELS and CLAUDE AND GPT MODELS quota percentages from `/usage` output."""
    result: Dict[str, Dict[str, str]] = {}
    gemini_idx = clean.find("GEMINI MODELS")
    claude_idx = clean.find("CLAUDE AND GPT MODELS")
    argon_idx = clean.find("GEMINI 4 ARGON")

    if gemini_idx != -1:
        end = claude_idx if claude_idx > gemini_idx else (argon_idx if argon_idx > gemini_idx else len(clean))
        parsed = _parse_group_quota(clean[gemini_idx:end])
        if parsed:
            result["gemini"] = parsed

    if claude_idx != -1:
        end = argon_idx if argon_idx > claude_idx else len(clean)
        parsed = _parse_group_quota(clean[claude_idx:end])
        if parsed:
            result["claude_gpt"] = parsed

    return result


def fetch_agy_quota(agy_bin: str, timeout: float = 12.0) -> Dict[str, Dict[str, str]]:
    """Spawn `agy` in a PTY, send `/usage`, and parse quota percentages."""
    master, slave = pty.openpty()
    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 120, 0, 0))
    except OSError:
        pass

    pid = os.fork()
    if pid == 0:
        try:
            os.setsid()
            os.dup2(slave, 0)
            os.dup2(slave, 1)
            os.dup2(slave, 2)
            if slave > 2:
                os.close(slave)
            os.close(master)
            os.execvp(agy_bin, [agy_bin])
        except Exception:
            os._exit(1)

    os.close(slave)
    buf = b""
    sent_usage = False
    found_at: Optional[float] = None
    t0 = time.monotonic()

    try:
        while time.monotonic() - t0 < timeout:
            r, _, _ = select.select([master], [], [], 0.2)
            if r:
                try:
                    chunk = os.read(master, 4096)
                    if not chunk:
                        break
                    buf += chunk
                except OSError:
                    break
            clean = _strip_ansi(buf.decode("utf-8", errors="replace"))
            if not sent_usage and (time.monotonic() - t0 > 2.5 or ">" in clean):
                try:
                    os.write(master, b"/usage\r")
                except OSError:
                    break
                sent_usage = True
            if "GEMINI MODELS" in clean and "Five Hour Limit Remaining" in clean:
                if found_at is None:
                    found_at = time.monotonic()
                # Wait briefly so CLAUDE AND GPT MODELS section also flushes if present.
                if "CLAUDE AND GPT MODELS" in clean and clean.count("%") >= 4:
                    break
                if time.monotonic() - found_at >= 0.6:
                    break
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
            deadline = time.monotonic() + 1.0
            while time.monotonic() < deadline:
                wpid, _ = os.waitpid(pid, os.WNOHANG)
                if wpid != 0:
                    break
                time.sleep(0.05)
            else:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
        except Exception:
            pass
        try:
            os.close(master)
        except OSError:
            pass

    clean = _strip_ansi(buf.decode("utf-8", errors="replace"))
    return parse_usage_output(clean)
