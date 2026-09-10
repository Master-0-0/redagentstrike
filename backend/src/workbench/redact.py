from __future__ import annotations

import json
from typing import Any, Dict, Iterable, Mapping, Optional, Tuple, Union
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

SENSITIVE_HEADERS = {
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
    "x-access-token",
    "api-key",
    "token",
    "authentication",
    "x-csrf-token",
}

SENSITIVE_QUERY = {
    "token",
    "access_token",
    "api_key",
    "apikey",
    "password",
    "auth",
    "authorization",
    "secret",
    "key",
}

REDACTED = "[redacted]"
DEFAULT_BODY_LIMIT = 1_000_000
DEFAULT_HEADER_LIMIT = None
DEFAULT_URL_LIMIT = 2048


def _header_name(name: str) -> str:
    return name.strip().lower()


def plain_headers(headers: Optional[Mapping[str, Any]]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not headers:
        return out
    for raw_name, raw_value in headers.items():
        name = str(raw_name)
        value = raw_value if isinstance(raw_value, str) else str(raw_value)
        out[name] = value
    return out


def redact_headers(
    headers: Optional[Mapping[str, Any]],
    value_limit: Optional[int] = DEFAULT_HEADER_LIMIT,
) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not headers:
        return out
    for raw_name, raw_value in headers.items():
        name = str(raw_name)
        value = raw_value if isinstance(raw_value, str) else str(raw_value)
        if _header_name(name) in SENSITIVE_HEADERS:
            out[name] = REDACTED
            continue
        out[name] = _truncate(value, value_limit) if value_limit else value
    return out


def redact_url(url: str, url_limit: int = DEFAULT_URL_LIMIT) -> str:
    if not url:
        return ""
    try:
        parts = urlsplit(url)
        query = []
        for key, value in parse_qsl(parts.query, keep_blank_values=True):
            if key.lower() in SENSITIVE_QUERY:
                query.append((key, REDACTED))
            else:
                query.append((key, value))
        rebuilt = urlunsplit(
            (parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)
        )
    except ValueError:
        rebuilt = url
    return _truncate(rebuilt, url_limit)


def decode_body(body: Optional[Union[bytes, str]]) -> str:
    """Keep the full body. Binary bytes are round-tripped via latin-1."""
    if body is None:
        return ""
    if isinstance(body, str):
        return body
    if _looks_binary(body):
        return body.decode("latin-1")
    return body.decode("utf-8", errors="replace")


def truncate_body(body: Optional[Union[bytes, str]], limit: int = DEFAULT_BODY_LIMIT) -> str:
    if body is None:
        return ""
    if isinstance(body, bytes):
        if _looks_binary(body):
            return "[binary {} bytes]".format(len(body))
        text = body.decode("utf-8", errors="replace")
    else:
        text = body
    return _truncate(text, limit)


def _looks_binary(body: bytes) -> bool:
    if not body:
        return False
    sample = body[:512]
    if b"\x00" in sample:
        return True
    # High ratio of non-text bytes.
    textish = sum(1 for b in sample if 32 <= b <= 126 or b in (9, 10, 13))
    return textish / max(len(sample), 1) < 0.75


def _truncate(text: str, limit: int) -> str:
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    return text[:limit] + "…[truncated {} chars]".format(len(text) - limit)


def host_from_url(url: str) -> str:
    if not url:
        return ""
    try:
        return urlsplit(url).hostname or ""
    except ValueError:
        return ""


def summarize(method: str, url: str, status: Optional[int], failed: bool) -> str:
    path = urlsplit(url).path or "/"
    host = host_from_url(url)
    target = "{}{}".format(host, path) if host else path
    if failed or status is None:
        return "{} {} → failed".format(method or "?", target)
    return "{} {} → {}".format(method or "?", target, status)


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def header_map(items: Iterable[Tuple[str, str]]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for name, value in items:
        if name in out:
            out[name] = out[name] + ", " + value
        else:
            out[name] = value
    return out
