"""Session and process management for AGY Mobile Web."""

from __future__ import annotations

import json
import os
import queue
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .config import BRAIN_DIR, LAST_SESSION_FILE
from .files import extract_images_from_text
from .quota import fetch_agy_quota
from .transcript import (
    _load_session_models,
    _load_session_names,
    _save_session_model,
    _save_session_name,
    _short_tool_name,
    list_existing_conversations,
    parse_conversation_messages_and_usage,
)


def load_last_session() -> str:
    try:
        if LAST_SESSION_FILE.is_file():
            data = json.loads(LAST_SESSION_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return str(data.get("conversation_id") or "").strip()
    except Exception:
        pass
    latest = list_existing_conversations(limit=1)
    return str(latest[0]["id"]) if latest else ""


def _save_last_session(cid: str) -> None:
    if not cid:
        return
    try:
        LAST_SESSION_FILE.write_text(
            json.dumps({"conversation_id": cid}, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:
        pass

def _terminate_proc(proc: Optional[subprocess.Popen[str]], timeout: float = 2.0) -> None:
    """Best-effort terminate a subprocess and its process group, escalating to SIGKILL on timeout."""
    if proc is None or proc.poll() is not None:
        return
    try:
        pgid = os.getpgid(proc.pid)
        os.killpg(pgid, signal.SIGTERM)
    except Exception:
        try:
            proc.terminate()
        except Exception:
            return
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        try:
            proc.wait(timeout=1.0)
        except Exception:
            pass
    except Exception:
        pass


class ConvSlot:
    """State for a single conversation slot (can run independently in background)."""

    def __init__(self, key: str, cid: Optional[str] = None, mode: str = "auto", model: str = "") -> None:
        self.key = key
        self.cid = cid
        self.busy = False
        self.proc: Optional[subprocess.Popen[str]] = None
        self.messages: List[Dict[str, Any]] = []
        self.queue: List[str] = []
        self.last_usage: Dict[str, Any] = {}
        self.mode: str = mode
        self.model: str = model
        self.tps: str = "-"
        self.stop_requested: bool = False
        self.turn_gen: int = 0
        self.last_transcript_mtime: float = 0.0


class SessionManager:
    """Thread-safe multi-session manager for `agy` conversations & SSE subscribers."""

    def __init__(self, agy_bin: str, cwd: Path, mode: str, initial_conversation_id: Optional[str] = None) -> None:
        self.agy_bin = agy_bin
        self.cwd = cwd.resolve()
        self.mode = mode
        self.model = ""
        self.allowed_roots = [self.cwd, Path.home(), BRAIN_DIR]
        self._lock = threading.RLock()
        self._draft_counter = 1
        init_key = initial_conversation_id or "draft-1"
        init_model = ""
        if initial_conversation_id:
            saved_models = _load_session_models()
            init_model = saved_models.get(initial_conversation_id, "")
        self._slots: Dict[str, ConvSlot] = {
            init_key: ConvSlot(init_key, initial_conversation_id, mode=self.mode, model=init_model)
        }
        self._active_key: str = init_key
        self._cached_models: Optional[List[Dict[str, str]]] = None
        self._quota: Dict[str, Dict[str, str]] = {}
        self._quota_last_ts: float = 0.0
        self._quota_refreshing: bool = False
        self._subscribers: List[queue.Queue[str]] = []
        threading.Thread(target=self._watch_transcript_loop, daemon=True).start()

    def _refresh_quota_once(self) -> None:
        try:
            q = fetch_agy_quota(self.agy_bin)
            if q:
                with self._lock:
                    self._quota = q
                    self._quota_last_ts = time.monotonic()
                self._broadcast_state()
        except Exception:
            pass
        finally:
            with self._lock:
                self._quota_refreshing = False

    def trigger_quota_refresh(self, min_interval: float = 5.0) -> bool:
        with self._lock:
            if self._quota_refreshing or (time.monotonic() - self._quota_last_ts < min_interval):
                return False
            self._quota_refreshing = True
        threading.Thread(target=self._refresh_quota_once, daemon=True).start()
        return True

    def _watch_transcript_loop(self) -> None:
        while True:
            time.sleep(2.0)
            with self._lock:
                slot = self._slots[self._active_key]
                if slot.busy or not slot.cid:
                    continue
                key = slot.key
                cid = slot.cid
                last_mt = slot.last_transcript_mtime
            tfile = BRAIN_DIR / cid / ".system_generated" / "logs" / "transcript.jsonl"
            try:
                mt = tfile.stat().st_mtime
            except OSError:
                continue
            if mt > last_mt + 1e-6:
                msgs, usage = parse_conversation_messages_and_usage(cid, self.cwd, self.allowed_roots)
                with self._lock:
                    cur = self._slots.get(key)
                    if cur and not cur.busy and cur.cid == cid:
                        if cur.stop_requested and msgs and msgs[-1].get("role") == "assistant":
                            msgs[-1]["cancelled"] = True
                        cur.messages = msgs
                        cur.last_usage = usage
                        if usage.get("tps") and usage["tps"] != "-":
                            cur.tps = usage["tps"]
                        cur.last_transcript_mtime = mt
                self._broadcast_state()

    def _slot_stats(self, slot: ConvSlot) -> Dict[str, Any]:
        u = slot.last_usage or {}
        tot_in = int(u.get("total_input_tokens") or u.get("input_tokens") or 0)
        tot_cr = int(u.get("total_cache_read_tokens") or u.get("cache_read_tokens") or 0)
        tot_out = int(u.get("total_output_tokens") or u.get("output_tokens") or 0)
        total_tokens = int(u.get("total_tokens") or (tot_in + tot_cr + tot_out))
        in_sum = tot_in + tot_cr
        cache_pct = float(u.get("cache_pct") if "cache_pct" in u else ((tot_cr / in_sum * 100.0) if in_sum > 0 else 0.0))
        model_name = str(slot.model or u.get("model") or "").lower()
        q_group = "claude_gpt" if ("claude" in model_name or "gpt" in model_name) else "gemini"
        q = self._quota.get(q_group) or self._quota.get("gemini") or {}
        return {
            "tps": slot.tps,
            "h5": q.get("h5", "-"),
            "weekly": q.get("weekly", "-"),
            "total_tokens": total_tokens,
            "cache_pct": cache_pct,
        }

    def snapshot(self, limit: Optional[int] = 60) -> Dict[str, Any]:
        names = _load_session_names()
        with self._lock:
            slot = self._slots[self._active_key]
            bg_running = sum(1 for k, s in self._slots.items() if k != self._active_key and s.busy)
            total_messages = len(slot.messages)
            raw_msgs = slot.messages[-limit:] if (limit and limit > 0 and total_messages > limit) else slot.messages
            msgs = [
                {k: (list(v) if isinstance(v, list) else v) for k, v in m.items()}
                for m in raw_msgs
            ]
            return {
                "busy": slot.busy,
                "queued_count": len(slot.queue),
                "bg_running": bg_running,
                "conversation_id": slot.cid,
                "session_name": names.get(slot.cid, "") if slot.cid else "",
                "cwd": str(self.cwd),
                "mode": slot.mode,
                "model": slot.model,
                "last_model": str((slot.last_usage or {}).get("model") or ""),
                "stats": self._slot_stats(slot),
                "total_messages": total_messages,
                "messages": msgs,
            }

    def update_settings(self, mode: Optional[str] = None, model: Optional[str] = None) -> None:
        with self._lock:
            slot = self._slots[self._active_key]
            if mode in ("auto", "accept-edits", "plan"):
                self.mode = mode
                slot.mode = mode
            if model is not None:
                clean = model.strip()
                self.model = clean
                slot.model = clean
                if slot.cid:
                    _save_session_model(slot.cid, clean)
        self._broadcast_state()

    def subscribe(self) -> queue.Queue[str]:
        q: queue.Queue[str] = queue.Queue(maxsize=128)
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: queue.Queue[str]) -> None:
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def _broadcast_state(self) -> None:
        payload = json.dumps({"type": "state", "state": self.snapshot()}, ensure_ascii=False)
        with self._lock:
            subs = list(self._subscribers)
        for q in subs:
            try:
                q.put_nowait(payload)
            except queue.Full:
                pass

    def reset(self, cwd: Optional[str] = None) -> Tuple[bool, str]:
        if cwd:
            target = Path(cwd).expanduser().resolve()
            if not target.is_dir():
                return False, f"Directory not found: {target}"
        else:
            target = None
        with self._lock:
            if target is not None:
                self.cwd = target
                if target not in self.allowed_roots:
                    self.allowed_roots.append(target)
            self._draft_counter += 1
            new_key = f"draft-{self._draft_counter}"
            self._slots[new_key] = ConvSlot(new_key, None, mode=self.mode, model=self.model)
            self._active_key = new_key
        self._broadcast_state()
        return True, str(self.cwd)

    def load_existing(self, cid: str) -> Tuple[bool, str]:
        switched_info: Optional[str] = None
        with self._lock:
            existing = self._slots.get(cid)
            if existing is not None:
                self._active_key = cid
                msg_count = len(existing.messages)
                status = "running" if existing.busy else "idle"
                switched_info = f"Switched to {cid[:8]} ({status}, messages={msg_count})"
        if switched_info is not None:
            _save_last_session(cid)
            self._broadcast_state()
            return True, switched_info

        msgs, usage = parse_conversation_messages_and_usage(cid, self.cwd, self.allowed_roots)
        if not msgs and usage["steps"] == 0:
            return False, f"Transcript not found for {cid}"
        tfile = BRAIN_DIR / cid / ".system_generated" / "logs" / "transcript.jsonl"
        try:
            mt = tfile.stat().st_mtime
        except OSError:
            mt = 0.0
        saved_models = _load_session_models()
        chosen_model = saved_models.get(cid)
        if chosen_model is None:
            chosen_model = str(usage.get("model") or self.model or "")
        with self._lock:
            slot = self._slots.get(cid)
            if slot is None:
                slot = ConvSlot(cid, cid, mode=self.mode, model=chosen_model)
                slot.messages = msgs
                slot.last_usage = usage
                slot.tps = str(usage.get("tps") or "-")
                slot.last_transcript_mtime = mt
                self._slots[cid] = slot
            else:
                if not slot.model:
                    slot.model = chosen_model
            self._active_key = cid
        _save_last_session(cid)
        self._broadcast_state()
        return True, (
            f"Loaded {cid[:8]} | messages={len(msgs)} | model={chosen_model or usage.get('model') or 'default'} | "
            f"last_input={usage['last_input_tokens']} tokens"
        )

    def delete_conversation(self, cid: str) -> Tuple[bool, str]:
        if not cid or "/" in cid or "\\" in cid or ".." in cid:
            return False, "invalid conversation_id"
        target_dir = (BRAIN_DIR / cid).resolve()
        if target_dir.parent != BRAIN_DIR.resolve():
            return False, "forbidden path"
        proc_to_stop: Optional[subprocess.Popen[str]] = None
        with self._lock:
            slot = self._slots.pop(cid, None)
            if slot is not None:
                slot.queue.clear()
                proc_to_stop = slot.proc
            if self._active_key == cid:
                self._draft_counter += 1
                new_key = f"draft-{self._draft_counter}"
                self._slots[new_key] = ConvSlot(new_key, None)
                self._active_key = new_key
        _terminate_proc(proc_to_stop, timeout=3.0)
        if target_dir.exists():
            try:
                shutil.rmtree(target_dir)
            except OSError as exc:
                return False, f"Failed to delete: {exc}"
        _save_session_name(cid, "")
        _save_session_model(cid, "")
        self._broadcast_state()
        return True, f"Deleted {cid[:8]}"

    def stop(self) -> None:
        with self._lock:
            slot = self._slots[self._active_key]
            slot.stop_requested = True
            slot.queue.clear()
            if slot.messages and slot.messages[-1].get("role") == "assistant":
                slot.messages[-1]["cancelled"] = True
                if not slot.messages[-1].get("text"):
                    slot.messages[-1]["text"] = "[Cancelled]"
            proc = slot.proc
        self._broadcast_state()
        _terminate_proc(proc, timeout=3.0)

    def start_turn(self, prompt: str, immediate: bool = False) -> Tuple[bool, str]:
        old_proc: Optional[subprocess.Popen[str]] = None
        with self._lock:
            slot = self._slots[self._active_key]
            slot.stop_requested = False
            now_str = time.strftime("%H:%M:%S")
            if slot.busy:
                if not immediate:
                    slot.queue.append(prompt)
                    slot.messages.append({"role": "user", "text": prompt, "time": f"{now_str} · Queued"})
                    self._broadcast_unlocked()
                    return True, "queued"

                old_proc = slot.proc
                slot.proc = None
                slot.turn_gen += 1
                my_gen = slot.turn_gen
                for m in reversed(slot.messages):
                    if m.get("role") == "assistant":
                        m["cancelled"] = True
                        break
                slot.messages.append({"role": "user", "text": prompt, "time": now_str})
                slot.messages.append({"role": "assistant", "text": "", "steps": [], "images": [], "time": now_str})
                msg_idx = len(slot.messages) - 1
                mode = slot.mode
                model = slot.model
                self._broadcast_unlocked()
                t = threading.Thread(
                    target=self._run_agy_turn,
                    args=(slot, prompt, mode, model, msg_idx, my_gen, old_proc),
                    daemon=True,
                )
                t.start()
                return True, "interrupted_and_started"

            slot.busy = True
            slot.turn_gen += 1
            my_gen = slot.turn_gen
            slot.messages.append({"role": "user", "text": prompt, "time": now_str})
            slot.messages.append({"role": "assistant", "text": "", "steps": [], "images": [], "time": now_str})
            msg_idx = len(slot.messages) - 1
            mode = slot.mode
            model = slot.model

        self._broadcast_state()
        t = threading.Thread(
            target=self._run_agy_turn,
            args=(slot, prompt, mode, model, msg_idx, my_gen, None),
            daemon=True,
        )
        t.start()
        return True, "started"

    def _broadcast_unlocked(self) -> None:
        payload = json.dumps({"type": "state", "state": self.snapshot()}, ensure_ascii=False)
        for q in list(self._subscribers):
            try:
                q.put_nowait(payload)
            except queue.Full:
                pass

    def _run_agy_turn(
        self,
        slot: ConvSlot,
        prompt: str,
        mode: str,
        model: str,
        msg_idx: int,
        turn_gen: int = 0,
        old_proc: Optional[subprocess.Popen[str]] = None,
    ) -> None:
        _terminate_proc(old_proc, timeout=1.5)
        with self._lock:
            if slot.turn_gen != turn_gen:
                return
            cid = slot.cid
        cmd = [self.agy_bin, "--output-format", "stream-json", "--mode", mode]
        if model:
            cmd.extend(["--model", model])
        if cid:
            cmd.extend(["--conversation", cid])
        cmd.extend(["-p", prompt])

        proc: Optional[subprocess.Popen[str]] = None
        stderr_lines: List[str] = []
        turn_t0 = time.monotonic()
        try:
            proc_env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
            proc = subprocess.Popen(
                cmd,
                cwd=str(self.cwd),
                env=proc_env,
                start_new_session=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
            with self._lock:
                slot.proc = proc

            def _drain_stderr() -> None:
                assert proc.stderr is not None
                for line in proc.stderr:
                    s = line.strip()
                    if s:
                        stderr_lines.append(s)

            t_err = threading.Thread(target=_drain_stderr, daemon=True)
            t_err.start()

            assert proc.stdout is not None
            last_broadcast = 0.0
            for raw_line in proc.stdout:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue

                ev_type = ev.get("event")
                changed = False
                with self._lock:
                    new_cid = ev.get("conversation_id") or (ev.get("result", {}).get("conversation_id") if ev_type == "result" else None)
                    if new_cid and not slot.cid:
                        old_key = slot.key
                        slot.cid = new_cid
                        slot.key = new_cid
                        self._slots[new_cid] = slot
                        if old_key != new_cid:
                            self._slots.pop(old_key, None)
                        if self._active_key == old_key:
                            self._active_key = new_cid
                        if slot.model:
                            _save_session_model(new_cid, slot.model)
                        _save_last_session(new_cid)
                        changed = True

                    if ev_type == "step_update":
                        su = ev.get("step_update", {})
                        st = su.get("step_type", "")
                        if st == "agent_response" and su.get("text_delta"):
                            slot.messages[msg_idx]["text"] += su["text_delta"]
                            changed = True
                        elif st and st not in ("user_input", "agent_response"):
                            raw_name = str(su.get("tool_name") or su.get("name") or st)
                            short_name = _short_tool_name(raw_name)
                            detail = ""
                            if su.get("path"):
                                detail = Path(str(su["path"])).name
                            elif su.get("command"):
                                cmd_s = str(su["command"]).strip()
                                detail = cmd_s[:60] + ("..." if len(cmd_s) > 60 else "")
                            state_str = str(su.get("state") or "").upper()
                            err_suffix = f" ({state_str})" if state_str in ("ERROR", "FAILED") else ""
                            label = f"● {short_name}({detail}){err_suffix}" if detail else f"● {short_name}{err_suffix}"
                            steps_list = slot.messages[msg_idx].setdefault("steps", [])
                            if not steps_list or steps_list[-1] != label:
                                steps_list.append(label)
                                changed = True
                    elif ev_type == "result":
                        res = ev.get("result", {})
                        if res.get("response") and not slot.messages[msg_idx]["text"].strip():
                            slot.messages[msg_idx]["text"] = res["response"]
                        if res.get("model"):
                            slot.last_usage = slot.last_usage or {}
                            slot.last_usage["model"] = res["model"]
                            if not slot.model:
                                slot.model = res["model"]
                                if slot.cid:
                                    _save_session_model(slot.cid, slot.model)
                        if isinstance(res.get("usage"), dict):
                            ru = res["usage"]
                            prev_u = slot.last_usage or {}
                            in_tok = int(ru.get("input_tokens") or 0)
                            cr_tok = int(ru.get("cache_read_tokens") or 0)
                            out_tok = int(
                                ru.get("output_tokens")
                                or ru.get("total_output_tokens")
                                or ru.get("last_output_tokens")
                                or 0
                            )
                            tot_in = int(prev_u.get("total_input_tokens") or 0) + in_tok
                            tot_cr = int(prev_u.get("total_cache_read_tokens") or 0) + cr_tok
                            tot_out = int(prev_u.get("total_output_tokens") or 0) + out_tok
                            in_sum = tot_in + tot_cr
                            slot.last_usage = {
                                **ru,
                                "last_input_tokens": in_tok,
                                "last_cache_read_tokens": cr_tok,
                                "last_output_tokens": out_tok,
                                "total_input_tokens": tot_in,
                                "total_cache_read_tokens": tot_cr,
                                "total_output_tokens": tot_out,
                                "total_tokens": in_sum + tot_out,
                                "cache_pct": (tot_cr / in_sum * 100.0) if in_sum > 0 else 0.0,
                            }
                            dur = float(
                                res.get("duration_seconds")
                                or (float(res.get("duration_ms") or 0.0) / 1000.0)
                                or (time.monotonic() - turn_t0)
                            )
                            if dur > 0 and out_tok > 0:
                                slot.tps = f"{out_tok / dur:.1f}"
                        changed = True

                now = time.monotonic()
                if changed and (now - last_broadcast > 0.12 or ev_type == "result"):
                    self._broadcast_state()
                    last_broadcast = now

            rc = proc.wait()
            t_err.join(timeout=1)

            with self._lock:
                msg = slot.messages[msg_idx]
                if slot.stop_requested:
                    msg["cancelled"] = True
                    if not msg["text"]:
                        msg["text"] = "[Cancelled]"
                elif rc != 0 and not msg["text"]:
                    err_txt = "\n".join(stderr_lines[-10:]) or f"agy exit code: {rc}"
                    msg["text"] = f"[Error]\n{err_txt}"
                msg["images"] = extract_images_from_text(msg["text"], self.cwd, self.allowed_roots)
                msg["time"] = time.strftime("%H:%M:%S")
        except Exception as exc:
            with self._lock:
                slot.messages[msg_idx]["text"] = f"[Launch Error] {exc}"
        finally:
            next_prompt: Optional[str] = None
            next_idx = -1
            next_gen = turn_gen
            next_mode = slot.mode
            next_model = slot.model
            with self._lock:
                if slot.turn_gen != turn_gen:
                    return
                slot.proc = None
                if slot.queue:
                    next_prompt = slot.queue.pop(0)
                    slot.turn_gen += 1
                    next_gen = slot.turn_gen
                    now_str = time.strftime("%H:%M:%S")
                    slot.messages.append({"role": "assistant", "text": "", "steps": [], "images": [], "time": now_str})
                    next_idx = len(slot.messages) - 1
                    next_mode = slot.mode
                    next_model = slot.model
                else:
                    slot.busy = False
            self._broadcast_state()
            if next_prompt is not None:
                threading.Thread(
                    target=self._run_agy_turn,
                    args=(slot, next_prompt, next_mode, next_model, next_idx, next_gen, None),
                    daemon=True,
                ).start()

