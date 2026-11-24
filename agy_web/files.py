"""File inspection and image discovery helpers for AGY Mobile Web."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from .config import BRAIN_DIR, IMAGE_EXTS

def _extract_candidate_image_paths(text: str) -> List[str]:
    if not text:
        return []
    candidates: List[str] = []
    # 1. Markdown link / image target: ![label](url) or [label](url)
    for m in re.finditer(r"!?\[[^\]]*\]\(\s*(?:file://)?([^\s)]+)\s*\)", text):
        candidates.append(m.group(1))
    # 2. Explicit file:// URIs
    for m in re.finditer(r"file://([^\s\"\'`<>\[\]\)]+)", text):
        candidates.append(m.group(1))
    # 3. Delimited or quoted paths (backticks, quotes, parens, spaces)
    for m in re.finditer(
        r"(?:^|[\s\"\'`\(<])([^\s\"\'`\(\)<>\[\]]+\.(?:png|jpg|jpeg|webp|gif|svg))",
        text,
        re.IGNORECASE,
    ):
        candidates.append(m.group(1))
    return candidates


def is_within_roots(target: Path, roots: List[Path]) -> bool:
    """Helper to check if target is within any root (retained for backward compatibility)."""
    if not roots:
        return True
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


def extract_images_from_text(
    text: str,
    cwd: Optional[Path] = None,
    allowed_roots: Optional[List[Path]] = None,
) -> List[Dict[str, str]]:
    """Extract valid image paths from markdown links, code blocks, or raw text.

    Directly inspects file existence without directory traversal or root whitelist restrictions.
    """
    if not text:
        return []
    seen: Set[str] = set()
    found: List[Dict[str, str]] = []
    for raw in _extract_candidate_image_paths(text):
        c = raw.split("#")[0].split("?")[0].strip(".,;:!?'\"`()[]")
        if c.startswith("file://"):
            c = c[7:]
        if not c:
            continue
        p = Path(os.path.expanduser(c))
        if not p.is_absolute() and cwd is not None:
            p = cwd / p
        try:
            rp = p.resolve()
        except OSError:
            continue
        rp_str = str(rp)
        if rp_str in seen:
            continue
        if rp.is_file() and rp.suffix.lower() in IMAGE_EXTS:
            seen.add(rp_str)
            found.append({"path": rp_str, "name": rp.name})
    return found


def _collect_images_from_text(
    text: str,
    cwd: Optional[Path],
    seen: Dict[str, Dict[str, Any]],
) -> None:
    if not text:
        return
    for raw in _extract_candidate_image_paths(text):
        c = raw.split("#")[0].split("?")[0].strip(".,;:!?'\"`()[]")
        if c.startswith("file://"):
            c = c[7:]
        if not c:
            continue
        p = Path(os.path.expanduser(c))
        if not p.is_absolute() and cwd is not None:
            p = cwd / p
        try:
            rp = p.resolve()
        except OSError:
            continue
        rp_str = str(rp)
        if rp_str in seen:
            continue
        if rp.is_file() and rp.suffix.lower() in IMAGE_EXTS:
            try:
                st = rp.stat()
                mtime = st.st_mtime
            except OSError:
                continue
            seen[rp_str] = {
                "path": rp_str,
                "name": rp.name,
                "rel": rp.name,
                "mtime": mtime,
            }


class _DummyLock:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


def get_recent_conversation_images(
    session_manager: Any = None,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    """Retrieve recently generated images directly from active and recent conversation outputs.

    Avoids expensive filesystem walks (e.g. multi-TB NAS mounts) for instant millisecond responses.
    """
    seen: Dict[str, Dict[str, Any]] = {}
    default_cwd = getattr(session_manager, "cwd", None) if session_manager else None

    # 1. Inspect in-memory messages of the active slot first (fastest, most immediate)
    if session_manager is not None:
        try:
            lock = getattr(session_manager, "_lock", None) or _DummyLock()
            with lock:
                slots = list(getattr(session_manager, "_slots", {}).values())
                active_key = getattr(session_manager, "_active_key", "")
                active_slot = getattr(session_manager, "_slots", {}).get(active_key)
            ordered_slots = [active_slot] if active_slot else []
            for s in slots:
                if s and s is not active_slot:
                    ordered_slots.append(s)

            for slot in ordered_slots:
                slot_cwd = getattr(slot, "cwd", None) or default_cwd
                for msg in reversed(getattr(slot, "messages", []) or []):
                    # Check pre-parsed images
                    for im in msg.get("images") or []:
                        ip = im.get("path")
                        if ip and ip not in seen:
                            p = Path(ip)
                            if p.is_file():
                                try:
                                    seen[ip] = {
                                        "path": ip,
                                        "name": im.get("name") or p.name,
                                        "rel": im.get("name") or p.name,
                                        "mtime": p.stat().st_mtime,
                                    }
                                except OSError:
                                    pass
                    # Check message text and steps
                    _collect_images_from_text(msg.get("text") or "", slot_cwd, seen)
                    for step in msg.get("steps") or []:
                        _collect_images_from_text(str(step), slot_cwd, seen)
        except Exception:
            pass

    # 2. Inspect transcripts of recently modified conversations in BRAIN_DIR
    if BRAIN_DIR.is_dir():
        items: List[Tuple[float, Path]] = []
        try:
            for entry in BRAIN_DIR.iterdir():
                if not entry.is_dir():
                    continue
                tf = entry / ".system_generated" / "logs" / "transcript.jsonl"
                if tf.is_file():
                    try:
                        items.append((tf.stat().st_mtime, tf))
                    except OSError:
                        pass
        except OSError:
            pass
        items.sort(key=lambda x: x[0], reverse=True)

        for _, tf in items[:10]:
            try:
                with tf.open("r", encoding="utf-8", errors="replace") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            obj = json.loads(line)
                        except Exception:
                            continue
                        content = str(obj.get("content") or "")
                        _collect_images_from_text(content, default_cwd, seen)
                        for tc in obj.get("tool_calls") or []:
                            if isinstance(tc, dict):
                                args = tc.get("args") or {}
                                if isinstance(args, dict):
                                    for v in args.values():
                                        _collect_images_from_text(str(v), default_cwd, seen)
            except Exception:
                continue

    results = sorted(seen.values(), key=lambda x: float(x.get("mtime") or 0.0), reverse=True)
    return results[:limit]


def list_recent_images(
    cwd: Path,
    limit: int = 30,
    max_depth: int = 5,
    max_entries: int = 8000,
    time_budget: float = 1.5,
) -> List[Dict[str, Any]]:
    """Kept for backward compatibility; delegates directly to fast conversation image discovery."""
    return get_recent_conversation_images(None, limit=limit)
