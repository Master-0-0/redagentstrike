"""mitmproxy addon: HTTP capture, optional intercept, then ingest.

Idle traffic is dropped by the API when capture is off (no current session).
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, Optional
from urllib.error import URLError
from urllib.request import Request, urlopen

ADDON_DIR = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.abspath(os.path.join(ADDON_DIR, "..", "src"))
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

try:
    from workbench.redact import decode_body, header_map, host_from_url  # type: ignore
except Exception:  # pragma: no cover
    header_map = None  # type: ignore
    host_from_url = None  # type: ignore
    decode_body = None  # type: ignore


INGEST = os.environ.get("WORKBENCH_INGEST_URL", "http://127.0.0.1:8787/internal/net/http")
HOLD = os.environ.get("WORKBENCH_HOLD_URL", "http://127.0.0.1:8787/internal/net/hold")
STATUS = os.environ.get(
    "WORKBENCH_CAPTURE_URL",
    INGEST.split("/internal/", 1)[0] + "/capture" if "/internal/" in INGEST else "http://127.0.0.1:8787/capture",
)
RUN_ID = os.environ.get("WORKBENCH_RUN_ID") or None


def _headers(flow_headers) -> Dict[str, str]:
    items = []
    try:
        items = list(flow_headers.items(multi=True))
    except TypeError:
        items = [(k, v) for k, v in flow_headers.items()]
    if header_map is not None:
        return header_map(items)
    return {str(k): str(v) for k, v in items}


def _body_text(raw: Optional[bytes]) -> str:
    if decode_body is not None:
        return decode_body(raw)
    if not raw:
        return ""
    return raw.decode("utf-8", errors="replace")


def _json_get(url: str, timeout: float) -> Optional[Dict[str, Any]]:
    req = Request(url, method="GET")
    try:
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except (URLError, TimeoutError, OSError, ValueError):
        return None
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _json_post(url: str, payload: Dict[str, Any], timeout: float) -> Optional[Dict[str, Any]]:
    data = json.dumps(payload).encode("utf-8")
    req = Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except (URLError, TimeoutError, OSError):
        return None
    if not raw:
        return {}
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _ingest(flow, failed: bool) -> None:
    request = flow.request
    method = (request.method or "").upper()
    if method == "CONNECT" and flow.response is not None and flow.response.status_code == 200:
        return
    url = request.pretty_url or request.url or ""
    stored_url = url
    host = request.host or (host_from_url(url) if host_from_url else "")
    status = None
    resp_headers: Dict[str, str] = {}
    resp_body = ""
    if flow.response is not None:
        status = int(flow.response.status_code)
        resp_headers = _headers(flow.response.headers)
        resp_body = _body_text(flow.response.content)
    req_headers = _headers(request.headers)
    _json_post(
        INGEST,
        {
            "run_id": RUN_ID,
            "ts": None,
            "method": method,
            "url": stored_url,
            "host": host,
            "status": status,
            "failed": failed or status is None,
            "req_headers": req_headers,
            "req_body": _body_text(request.content),
            "resp_headers": resp_headers,
            "resp_body": resp_body,
            "already_redacted": False,
        },
        timeout=60,
    )


def _apply_decision(flow, decision: Dict[str, Any]) -> None:
    action = decision.get("action") or "forward"
    if action == "drop":
        flow.kill()
        return
    if action != "forward":
        return
    method = (decision.get("method") or flow.request.method or "GET").upper()
    url = decision.get("url") or flow.request.pretty_url
    headers = decision.get("headers") or {}
    body = decision.get("body") or ""
    flow.request.method = method
    try:
        flow.request.url = url
    except Exception:
        pass
    try:
        flow.request.headers.clear()
    except Exception:
        flow.request.headers = {}
    for name, value in headers.items():
        flow.request.headers[str(name)] = str(value)
    flow.request.set_content(body.encode("utf-8") if isinstance(body, str) else body)


class HttpCapture:
    def request(self, flow) -> None:
        request = flow.request
        method = (request.method or "").upper()
        if method == "CONNECT":
            return
        host = (request.host or "").lower()
        if host in {"127.0.0.1", "localhost"} and request.port in {8787, 5173}:
            return
        status = _json_get(STATUS, timeout=0.4)
        if not status or not status.get("intercept"):
            return
        decision = _json_post(
            HOLD,
            {
                "method": method,
                "url": request.pretty_url or request.url or "",
                "host": request.host or "",
                "headers": _headers(request.headers),
                "body": _body_text(request.content),
            },
            timeout=310,
        )
        if not decision:
            return
        _apply_decision(flow, decision)

    def response(self, flow) -> None:
        _ingest(flow, failed=False)

    def error(self, flow) -> None:
        _ingest(flow, failed=True)


addons = [HttpCapture()]
