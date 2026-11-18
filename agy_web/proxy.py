"""HTTP & SSE reverse proxy for controlling multiple AGY Mobile Web nodes."""

from __future__ import annotations

import http.client
import json
import ssl
import threading
import urllib.parse
from http.cookies import SimpleCookie
from typing import Any, Dict, List, Optional, Tuple


class NodeProxyManager:
    """Manages remote AGY Mobile Web nodes and proxies HTTP/SSE requests."""

    def __init__(self, nodes: List[Dict[str, Any]]) -> None:
        self._lock = threading.Lock()
        self._nodes: Dict[str, Dict[str, str]] = {}
        self._order: List[str] = []
        self._cookies: Dict[str, str] = {}

        for idx, raw in enumerate(nodes):
            if not isinstance(raw, dict):
                continue
            name = str(raw.get("name") or f"node-{idx + 1}").strip()
            url = str(raw.get("url") or "").strip().rstrip("/")
            if not url:
                continue
            nid = str(raw.get("id") or ("local" if url == "local" else f"node-{idx + 1}")).strip()
            if nid in self._nodes:
                nid = f"{nid}-{idx + 1}"
            self._nodes[nid] = {
                "id": nid,
                "name": name,
                "url": url,
                "password": str(raw.get("password") or ""),
            }
            self._order.append(nid)

        if not any(self._nodes[k]["url"] == "local" for k in self._order):
            self._nodes["local"] = {"id": "local", "name": "Local", "url": "local", "password": ""}
            self._order.insert(0, "local")

    def list_public_nodes(self) -> List[Dict[str, Any]]:
        return [
            {
                "id": self._nodes[k]["id"],
                "name": self._nodes[k]["name"],
                "is_local": self._nodes[k]["url"] == "local",
            }
            for k in self._order
        ]

    def is_remote(self, node_id: str) -> bool:
        n = self._nodes.get(node_id)
        return bool(n and n["url"] != "local")

    def _open_conn(self, target_url: str, timeout: float = 20.0) -> Tuple[http.client.HTTPConnection, str]:
        p = urllib.parse.urlparse(target_url)
        host = p.hostname or "127.0.0.1"
        base_path = p.path.rstrip("/")
        if p.scheme == "https":
            port = p.port or 443
            ctx = ssl.create_default_context()
            return http.client.HTTPSConnection(host, port, timeout=timeout, context=ctx), base_path
        port = p.port or 80
        return http.client.HTTPConnection(host, port, timeout=timeout), base_path

    def _login_node(self, node_id: str) -> Optional[str]:
        node = self._nodes.get(node_id)
        if not node or not node["password"]:
            return None
        conn, base_path = self._open_conn(node["url"], timeout=10.0)
        try:
            payload = json.dumps({"password": node["password"]}).encode("utf-8")
            conn.request(
                "POST",
                f"{base_path}/api/login",
                body=payload,
                headers={"Content-Type": "application/json", "Content-Length": str(len(payload))},
            )
            resp = conn.getresponse()
            resp.read()
            if resp.status != 200:
                return None
            for hdr_val in resp.headers.get_all("Set-Cookie") or []:
                c = SimpleCookie()
                c.load(hdr_val)
                if "agy_auth" in c:
                    cookie_val = f"agy_auth={c['agy_auth'].value}"
                    with self._lock:
                        self._cookies[node_id] = cookie_val
                    return cookie_val
            return None
        finally:
            conn.close()

    def _get_cookie(self, node_id: str) -> str:
        with self._lock:
            return self._cookies.get(node_id, "")

    def proxy_http(
        self,
        node_id: str,
        method: str,
        path_with_query: str,
        body: Optional[bytes] = None,
        content_type: str = "",
    ) -> Tuple[int, List[Tuple[str, str]], bytes]:
        node = self._nodes.get(node_id)
        if not node or node["url"] == "local":
            return 404, [("Content-Type", "application/json; charset=utf-8")], b'{"error":"unknown node"}'

        for attempt in range(2):
            conn, base_path = self._open_conn(node["url"], timeout=25.0)
            try:
                headers: Dict[str, str] = {}
                cookie = self._get_cookie(node_id)
                if cookie:
                    headers["Cookie"] = cookie
                if body is not None:
                    headers["Content-Length"] = str(len(body))
                    if content_type:
                        headers["Content-Type"] = content_type
                conn.request(method, f"{base_path}{path_with_query}", body=body, headers=headers)
                resp = conn.getresponse()
                resp_body = resp.read()
                if resp.status == 401 and attempt == 0 and node["password"]:
                    if self._login_node(node_id):
                        continue
                out_headers: List[Tuple[str, str]] = []
                for k in ("Content-Type", "Cache-Control"):
                    v = resp.getheader(k)
                    if v:
                        out_headers.append((k, v))
                return resp.status, out_headers, resp_body
            except Exception as exc:
                return (
                    502,
                    [("Content-Type", "application/json; charset=utf-8")],
                    json.dumps({"error": f"Node unreachable: {exc}"}).encode("utf-8"),
                )
            finally:
                conn.close()
        return 502, [("Content-Type", "application/json; charset=utf-8")], b'{"error":"proxy failed"}'

    def open_sse(self, node_id: str, path_with_query: str) -> Tuple[Optional[http.client.HTTPConnection], Optional[http.client.HTTPResponse]]:
        node = self._nodes.get(node_id)
        if not node or node["url"] == "local":
            return None, None

        for attempt in range(2):
            conn, base_path = self._open_conn(node["url"], timeout=30.0)
            try:
                headers: Dict[str, str] = {"Accept": "text/event-stream"}
                cookie = self._get_cookie(node_id)
                if cookie:
                    headers["Cookie"] = cookie
                conn.request("GET", f"{base_path}{path_with_query}", headers=headers)
                resp = conn.getresponse()
                if resp.status == 401 and attempt == 0 and node["password"]:
                    resp.read()
                    conn.close()
                    if self._login_node(node_id):
                        continue
                    return None, None
                if resp.status != 200:
                    resp.read()
                    conn.close()
                    return None, None
                return conn, resp
            except Exception:
                try:
                    conn.close()
                except Exception:
                    pass
                return None, None
        return None, None
