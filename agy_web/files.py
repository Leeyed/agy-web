"""File inspection and image discovery helpers for AGY Mobile Web."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Dict, List, Tuple

from .config import IMAGE_EXTS


def is_within_roots(target: Path, roots: List[Path]) -> bool:
    try:
        resolved = target.resolve()
    except OSError:
        return False
    for r in roots:
        try:
            resolved.relative_to(r.resolve())
            return True
        except ValueError:
            continue
    return False


def extract_images_from_text(text: str, cwd: Path, allowed_roots: List[Path]) -> List[Dict[str, str]]:
    if not text:
        return []
    pattern = re.compile(r"(?:file://)?([A-Za-z0-9_./~\-]+\.(?:png|jpg|jpeg|webp|gif|svg))", re.IGNORECASE)
    seen = set()
    found: List[Dict[str, str]] = []
    for m in pattern.finditer(text):
        raw = m.group(1)
        p = Path(os.path.expanduser(raw))
        if not p.is_absolute():
            p = cwd / p
        try:
            rp = p.resolve()
        except OSError:
            continue
        rp_str = str(rp)
        if rp_str in seen:
            continue
        if rp.is_file() and rp.suffix.lower() in IMAGE_EXTS and is_within_roots(rp, allowed_roots):
            seen.add(rp_str)
            found.append({"path": rp_str, "name": rp.name})
    return found


def list_recent_images(cwd: Path, limit: int = 30) -> List[Dict[str, Any]]:
    skip_dirs = {".git", ".venv", "__pycache__", "node_modules", ".pytest_cache"}
    items: List[Tuple[float, Path]] = []
    for root, dirs, files in os.walk(cwd):
        dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith(".")]
        for fname in files:
            p = Path(root) / fname
            if p.suffix.lower() in IMAGE_EXTS:
                try:
                    items.append((p.stat().st_mtime, p))
                except OSError:
                    pass
    items.sort(key=lambda x: x[0], reverse=True)
    result = []
    for mtime, p in items[:limit]:
        try:
            rel = str(p.relative_to(cwd))
        except ValueError:
            rel = p.name
        result.append({"path": str(p.resolve()), "name": p.name, "rel": rel, "mtime": mtime})
    return result
