from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any, Dict, List, Optional

from .control import new_id


class HoldItem:
    def __init__(self, draft: Dict[str, Any]) -> None:
        self.id = new_id("hold")
        self.method = (draft.get("method") or "GET").upper()
        self.url = draft.get("url") or ""
        self.host = draft.get("host") or ""
        self.headers = {
            str(k): str(v) for k, v in (draft.get("headers") or {}).items()
        }
        self.body = draft.get("body") or ""
        self.event = threading.Event()
        self.decision: Optional[Dict[str, Any]] = None

    def as_pending(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "method": self.method,
            "url": self.url,
            "host": self.host,
            "headers": self.headers,
            "body": self.body,
        }


class HoldBoard:
    """In-process intercept queue. One FIFO queue; tools block until 放行/丢弃."""

    def __init__(self, wait_s: float = 300.0) -> None:
        self.wait_s = wait_s
        self.enabled = False
        self._lock = threading.Lock()
        self._pending: "OrderedDict[str, HoldItem]" = OrderedDict()

    def status(self) -> Dict[str, Any]:
        with self._lock:
            pending = [item.as_pending() for item in self._pending.values()]
        return {
            "intercept": self.enabled,
            "pending_count": len(pending),
            "pending": pending,
        }

    def set_enabled(self, enabled: bool) -> None:
        self.enabled = bool(enabled)
        if not self.enabled:
            self.release_all("forward")

    def hold(self, draft: Dict[str, Any]) -> Dict[str, Any]:
        original = _draft(draft)
        if not self.enabled:
            return dict(original, action="forward")
        item = HoldItem(original)
        with self._lock:
            self._pending[item.id] = item
        if not item.event.wait(self.wait_s):
            with self._lock:
                self._pending.pop(item.id, None)
            return dict(original, action="timeout")
        return item.decision or dict(original, action="forward")

    def forward(self, hold_id: str, edited: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        item = self._pop_ready(hold_id)
        payload = _draft(edited or item.as_pending())
        payload["action"] = "forward"
        item.decision = payload
        item.event.set()
        return payload

    def drop(self, hold_id: str) -> Dict[str, Any]:
        item = self._pop_ready(hold_id)
        payload = dict(item.as_pending(), action="drop")
        item.decision = payload
        item.event.set()
        return payload

    def release_all(self, action: str = "forward") -> None:
        with self._lock:
            items = list(self._pending.values())
            self._pending.clear()
        for item in items:
            payload = dict(item.as_pending(), action=action)
            item.decision = payload
            item.event.set()

    def _pop_ready(self, hold_id: str) -> HoldItem:
        with self._lock:
            item = self._pending.pop(hold_id, None)
        if item is None:
            raise KeyError(hold_id)
        return item


class ReplayCache:
    def __init__(self, limit: int = 500) -> None:
        self.limit = limit
        self._lock = threading.Lock()
        self._data: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()

    def put(self, event_id: str, draft: Dict[str, Any]) -> None:
        with self._lock:
            self._data[event_id] = _draft(draft)
            self._data.move_to_end(event_id)
            while len(self._data) > self.limit:
                self._data.popitem(last=False)

    def get(self, event_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            draft = self._data.get(event_id)
            return dict(draft) if draft else None

    def clear(self) -> None:
        with self._lock:
            self._data.clear()


def _draft(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    raw = raw or {}
    headers = raw.get("headers") or {}
    return {
        "method": (raw.get("method") or "GET").upper(),
        "url": raw.get("url") or "",
        "host": raw.get("host") or "",
        "headers": {str(k): str(v) for k, v in headers.items()},
        "body": raw.get("body") or "",
    }
