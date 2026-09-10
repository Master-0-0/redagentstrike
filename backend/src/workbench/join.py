from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

from .control import RunEvent
from .netstore import HttpEvent


def parse_ts(value: str) -> Optional[datetime]:
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def align_tool_call(
    event: HttpEvent,
    tool_calls: List[RunEvent],
    window_s: float = 8.0,
) -> Optional[Dict[str, Any]]:
    """Pick the nearest tool_call in a time window, preferring host/url overlap."""
    event_ts = parse_ts(event.ts)
    if event_ts is None or not tool_calls:
        return None
    best: Optional[RunEvent] = None
    best_score = -1.0
    for call in tool_calls:
        if call.kind != "tool_call":
            continue
        call_ts = parse_ts(call.ts)
        if call_ts is None:
            continue
        delta = abs((event_ts - call_ts).total_seconds())
        if delta > window_s:
            continue
        haystack = " ".join(
            [
                call.name,
                str(call.payload.get("url", "")),
                str(call.payload.get("host", "")),
                str(call.payload.get("target", "")),
                str(call.payload.get("name", "")),
            ]
        ).lower()
        overlap = 0.0
        host = (event.host or "").lower()
        path = (urlsplit(event.url).path or "").lower()
        if host and host in haystack:
            overlap += 3.0
        if path and path != "/" and path in haystack:
            overlap += 1.5
        score = overlap + max(0.0, (window_s - delta) / window_s)
        if score > best_score:
            best_score = score
            best = call
    if best is None:
        return None
    return {
        "id": best.id,
        "ts": best.ts,
        "name": best.name,
        "payload": best.payload,
    }
