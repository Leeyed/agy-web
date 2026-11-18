"""Configuration and environment detection for AGY Mobile Web."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

CONFIG_FILE = Path(__file__).resolve().parent.parent / "config.json"


def _load_config() -> Dict[str, Any]:
    if not CONFIG_FILE.is_file():
        return {}
    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


_CFG = _load_config()
DEFAULT_CWD = Path(str(_CFG.get("cwd") or Path.cwd())).expanduser()
DEFAULT_AGY_BIN = str(
    Path(str(_CFG.get("agy_bin") or shutil.which("agy") or (Path.home() / ".local" / "bin" / "agy"))).expanduser()
)
DEFAULT_HOST = str(_CFG.get("host") or "127.0.0.1")
DEFAULT_PORT = int(_CFG.get("port") or 8088)
DEFAULT_MODE = str(_CFG.get("mode") or "auto")
if DEFAULT_MODE not in ("auto", "accept-edits", "plan"):
    DEFAULT_MODE = "auto"
DEFAULT_PASSWORD = str(_CFG.get("password") or "").strip()
DEFAULT_MAX_DEVICES = int(_CFG.get("max_devices") or 0)


def load_nodes() -> List[Dict[str, Any]]:
    cfg = _load_config()
    raw = cfg.get("nodes")
    return raw if isinstance(raw, list) else []

BRAIN_DIR = Path.home() / ".gemini" / "antigravity-cli" / "brain"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}
SAFE_FILE_EXTS = IMAGE_EXTS | {".json", ".txt", ".log", ".md"}
SESSION_NAMES_FILE = Path(__file__).resolve().parent.parent / "session_names.json"
SESSION_MODELS_FILE = Path(__file__).resolve().parent.parent / "session_models.json"
AUTHORIZED_DEVICES_FILE = Path(__file__).resolve().parent.parent / "authorized_devices.json"
LAST_SESSION_FILE = Path(__file__).resolve().parent.parent / "last_session.json"
STATIC_DIR = Path(__file__).resolve().parent / "static"


def get_cli_default_model() -> str:
    settings_file = Path.home() / ".gemini" / "antigravity-cli" / "settings.json"
    if settings_file.is_file():
        try:
            data = json.loads(settings_file.read_text(encoding="utf-8"))
            raw = str(data.get("model") or "").strip()
            if raw:
                return raw
        except Exception:
            pass
    return ""


def detect_tailscale_ipv4() -> Optional[str]:
    try:
        out = subprocess.check_output(["tailscale", "ip", "-4"], text=True, stderr=subprocess.DEVNULL, timeout=3)
        ip = out.strip().splitlines()[0].strip()
        return ip or None
    except Exception:
        return None
