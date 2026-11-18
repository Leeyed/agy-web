"""Transcript parser, usage tracker, and conversation history helpers."""

from __future__ import annotations

import json
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .config import BRAIN_DIR, SESSION_NAMES_FILE, SESSION_MODELS_FILE
from .files import extract_images_from_text


def _clean_user_prompt(raw_content: str) -> str:
    m = re.search(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", raw_content, re.DOTALL)
    if m:
        return m.group(1).strip()
    return raw_content.strip()


def _read_transcript_lines(cid: str) -> List[Dict[str, Any]]:
    compact = BRAIN_DIR / cid / ".system_generated" / "logs" / "transcript.jsonl"
    full = BRAIN_DIR / cid / ".system_generated" / "logs" / "transcript_full.jsonl"
    if not compact.is_file():
        return []
    full_lines: Optional[List[str]] = None
    records: List[Dict[str, Any]] = []
    with compact.open("r", encoding="utf-8", errors="replace") as f:
        for idx, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("truncated_fields") and full.is_file():
                if full_lines is None:
                    full_lines = full.read_text(encoding="utf-8", errors="replace").splitlines()
                if idx < len(full_lines):
                    try:
                        obj = json.loads(full_lines[idx])
                    except json.JSONDecodeError:
                        pass
            records.append(obj)
    return records


def _load_session_names() -> Dict[str, str]:
    try:
        if SESSION_NAMES_FILE.is_file():
            data = json.loads(SESSION_NAMES_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return {str(k): str(v) for k, v in data.items() if str(v).strip()}
    except Exception:
        pass
    return {}


def _save_session_name(cid: str, name: str) -> None:
    names = _load_session_names()
    clean = name.strip()
    if clean:
        names[cid] = clean
    else:
        names.pop(cid, None)
    SESSION_NAMES_FILE.write_text(json.dumps(names, ensure_ascii=False, indent=2), encoding="utf-8")


def _load_session_models() -> Dict[str, str]:
    try:
        if SESSION_MODELS_FILE.is_file():
            data = json.loads(SESSION_MODELS_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return {str(k): str(v).strip() for k, v in data.items() if str(v).strip()}
    except Exception:
        pass
    return {}


def _save_session_model(cid: str, model: str) -> None:
    models = _load_session_models()
    clean = model.strip()
    if clean:
        models[cid] = clean
    else:
        models.pop(cid, None)
    try:
        SESSION_MODELS_FILE.write_text(json.dumps(models, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def list_existing_conversations(limit: int = 30) -> List[Dict[str, Any]]:
    if not BRAIN_DIR.is_dir():
        return []
    custom_names = _load_session_names()
    items: List[Tuple[float, Path]] = []
    for entry in BRAIN_DIR.iterdir():
        if not entry.is_dir():
            continue
        tfile = entry / ".system_generated" / "logs" / "transcript.jsonl"
        if tfile.is_file():
            try:
                items.append((tfile.stat().st_mtime, entry))
            except OSError:
                pass
    items.sort(key=lambda x: x[0], reverse=True)
    out: List[Dict[str, Any]] = []
    for mtime, entry in items[:limit]:
        cid = entry.name
        preview = "(empty)"
        tfile = entry / ".system_generated" / "logs" / "transcript.jsonl"
        try:
            with tfile.open("r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if obj.get("type") == "USER_INPUT" and obj.get("content"):
                        txt = _clean_user_prompt(str(obj["content"])).replace("\n", " ")
                        preview = txt[:48] + ("..." if len(txt) > 48 else "")
                        break
        except OSError:
            pass
        out.append({
            "id": cid,
            "updated": time.strftime("%m-%d %H:%M", time.localtime(mtime)),
            "preview": custom_names.get(cid, preview),
        })
    return out


_TOOL_NAME_MAP = {
    "read_file": "Read",
    "edit_file": "Edit",
    "write_file": "Write",
    "run_command": "Bash",
    "search_web": "Search",
    "invoke_subagent": "Subagent",
    "manage_task": "Task",
    "manage_subagents": "Subagents",
    "send_message": "Message",
    "ask_question": "Ask",
    "schedule": "Schedule",
    "run_workflow": "Workflow",
    "swarm": "Swarm",
    "planner_thought": "Thought",
}


def _short_tool_name(raw: str) -> str:
    key = raw.strip()
    return _TOOL_NAME_MAP.get(key.lower(), key)


def _format_tool_call(tc: Dict[str, Any]) -> str:
    name = _short_tool_name(str(tc.get("name") or "tool"))
    args = tc.get("args") or {}
    detail = ""
    if isinstance(args, dict):
        for k in ("Path", "CommandLine", "toolSummary", "query", "Action"):
            if k in args and args[k]:
                val = str(args[k]).strip().strip('"').strip("'")
                if k == "Path":
                    val = Path(val).name
                detail = val[:70] + ("..." if len(val) > 70 else "")
                break
    return f"● {name}({detail})" if detail else f"● {name}"


def parse_conversation_messages_and_usage(
    cid: str, cwd: Path, allowed_roots: List[Path]
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    records = _read_transcript_lines(cid)
    messages: List[Dict[str, Any]] = []
    usage: Dict[str, Any] = {
        "model": "unknown",
        "last_input_tokens": 0,
        "last_cache_read_tokens": 0,
        "last_output_tokens": 0,
        "total_input_tokens": 0,
        "total_cache_read_tokens": 0,
        "total_output_tokens": 0,
        "total_tokens": 0,
        "cache_pct": 0.0,
        "steps": len(records),
        "tps": "-",
    }
    cur_assistant: Optional[Dict[str, Any]] = None
    turn_start_ts: Optional[str] = None
    turn_end_ts: Optional[str] = None
    turn_out_tokens = 0

    for obj in records:
        t = obj.get("type")
        ts = str(obj.get("created_at", ""))
        hhmmss = ts[11:19] if len(ts) >= 19 else ""
        if t == "USER_INPUT":
            cur_assistant = None
            turn_start_ts = ts or None
            turn_end_ts = None
            turn_out_tokens = 0
            txt = _clean_user_prompt(str(obj.get("content", "")))
            if txt:
                messages.append({"role": "user", "text": txt, "time": hhmmss})
        elif t == "PLANNER_RESPONSE":
            if obj.get("model"):
                usage["model"] = obj["model"]
            if "input_tokens" in obj:
                in_tok = int(obj.get("input_tokens") or 0)
                usage["last_input_tokens"] = in_tok
                usage["total_input_tokens"] += in_tok
            if "cache_read_tokens" in obj:
                cr_tok = int(obj.get("cache_read_tokens") or 0)
                usage["last_cache_read_tokens"] = cr_tok
                usage["total_cache_read_tokens"] += cr_tok
            if "output_tokens" in obj:
                out_tok = int(obj.get("output_tokens") or 0)
                usage["last_output_tokens"] = out_tok
                usage["total_output_tokens"] += out_tok
                turn_out_tokens += out_tok
            if ts:
                turn_end_ts = ts

            if cur_assistant is None:
                cur_assistant = {"role": "assistant", "text": "", "steps": [], "images": [], "time": hhmmss}
                messages.append(cur_assistant)

            thinking = str(obj.get("thinking") or "").strip()
            if thinking:
                one_line = " ".join(thinking.split())
                preview = one_line[:110] + ("..." if len(one_line) > 110 else "")
                cur_assistant["steps"].append(f"▸ Thought: {preview}")

            for tc in obj.get("tool_calls") or []:
                if isinstance(tc, dict):
                    cur_assistant["steps"].append(_format_tool_call(tc))

            content = str(obj.get("content", "")).strip()
            if content:
                cur_assistant["text"] = (cur_assistant["text"] + "\n\n" + content).strip() if cur_assistant["text"] else content
                cur_assistant["images"] = extract_images_from_text(cur_assistant["text"], cwd, allowed_roots)
                cur_assistant["time"] = hhmmss
    tot_in_all = usage["total_input_tokens"] + usage["total_cache_read_tokens"]
    usage["total_tokens"] = tot_in_all + usage["total_output_tokens"]
    usage["cache_pct"] = (usage["total_cache_read_tokens"] / tot_in_all * 100.0) if tot_in_all > 0 else 0.0
    if turn_start_ts and turn_end_ts and turn_out_tokens > 0:
        try:
            t0 = datetime.fromisoformat(turn_start_ts.replace("Z", "+00:00"))
            t1 = datetime.fromisoformat(turn_end_ts.replace("Z", "+00:00"))
            dt = (t1 - t0).total_seconds()
            if dt >= 1.0:
                usage["tps"] = f"{turn_out_tokens / dt:.1f}"
        except Exception:
            pass
    return messages, usage
