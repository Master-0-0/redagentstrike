from __future__ import annotations

import socket
import time
from dataclasses import dataclass
from typing import Optional

import httpx

from .proxypool import ProxyEntry

DEFAULT_CHECK_URL_HTTP = "http://api.ipify.org"
DEFAULT_CHECK_URL_TLS = "https://api.ipify.org"
CHECK_TIMEOUT_S = 8.0


@dataclass
class CheckResult:
    ok: bool
    latency_ms: Optional[int]
    egress_ip: Optional[str]
    error: Optional[str]
    url: str


def check_entry(
    entry: ProxyEntry,
    url: Optional[str] = None,
    timeout: Optional[float] = None,
) -> CheckResult:
    wait = CHECK_TIMEOUT_S if timeout is None else timeout
    target = (url or "").strip() or _default_url(entry.scheme)
    if entry.scheme == "socks5" and not url:
        return _check_socks_port(entry, wait)
    return _check_http_proxy(entry.url(), target, wait)


def _default_url(scheme: str) -> str:
    if scheme == "http":
        return DEFAULT_CHECK_URL_HTTP
    return DEFAULT_CHECK_URL_TLS


def _check_http_proxy(proxy_url: str, target: str, timeout: float = CHECK_TIMEOUT_S) -> CheckResult:
    started = time.perf_counter()
    try:
        with httpx.Client(
            proxy=proxy_url,
            timeout=timeout,
            follow_redirects=True,
            verify=True,
        ) as client:
            response = client.get(target)
    except httpx.TimeoutException:
        return CheckResult(
            ok=False,
            latency_ms=_elapsed_ms(started),
            egress_ip=None,
            error="timeout",
            url=target,
        )
    except httpx.RequestError:
        return CheckResult(
            ok=False,
            latency_ms=_elapsed_ms(started),
            egress_ip=None,
            error="connect",
            url=target,
        )
    latency = _elapsed_ms(started)
    if response.status_code >= 400:
        return CheckResult(
            ok=False,
            latency_ms=latency,
            egress_ip=None,
            error="http_{}".format(response.status_code),
            url=target,
        )
    return CheckResult(
        ok=True,
        latency_ms=latency,
        egress_ip=_parse_ip(response.text),
        error=None,
        url=target,
    )


def _check_socks_port(entry: ProxyEntry, timeout: float = CHECK_TIMEOUT_S) -> CheckResult:
    started = time.perf_counter()
    try:
        sock = socket.create_connection((entry.host, entry.port), timeout=timeout)
        sock.close()
    except OSError:
        return CheckResult(
            ok=False,
            latency_ms=_elapsed_ms(started),
            egress_ip=None,
            error="connect",
            url="tcp://{}:{}".format(entry.host, entry.port),
        )
    return CheckResult(
        ok=True,
        latency_ms=_elapsed_ms(started),
        egress_ip=None,
        error=None,
        url="tcp://{}:{}".format(entry.host, entry.port),
    )


def _elapsed_ms(started: float) -> int:
    return max(0, int((time.perf_counter() - started) * 1000))


def _parse_ip(body: str) -> Optional[str]:
    text = (body or "").strip().split()[0] if body else ""
    if not text or len(text) > 64:
        return None
    if all(part.isdigit() and 0 <= int(part) <= 255 for part in text.split(".")) and text.count(".") == 3:
        return text
    if ":" in text and all(chunk for chunk in text.replace(".", "").split(":")):
        return text
    return None
