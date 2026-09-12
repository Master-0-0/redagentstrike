from __future__ import annotations

import ipaddress
import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import httpx

from .proxycheck import CheckResult, check_entry
from .proxypool import ProxyEntry, ProxyPool

LINE_RE = re.compile(
    r"(?P<host>(?:\d{1,3}\.){3}\d{1,3}):(?P<port>\d{1,5})"
)
FETCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; workbench-proxy-pool/1.0)",
    "Accept": "*/*",
}
DEFAULT_LIMIT = 8
MAX_LIMIT = 20
DEFAULT_MAX_TRY = 20
FETCH_TIMEOUT_S = 10.0
VALIDATE_TIMEOUT_S = 3.5
LAB_PLACEHOLDERS = (
    ("http", "10.0.0.8", 8080),
    ("http", "10.0.0.9", 8081),
)

# Same public lists jhao104 / Germey pull from. We copy the shape, not the repos.
SOURCES: Sequence[Tuple[str, str, str]] = (
    (
        "proxyscrape",
        (
            "https://api.proxyscrape.com/v4/free-proxy-list/get"
            "?request=displayproxies&protocol=http&timeout=2000&format=text"
        ),
        "text",
    ),
    (
        "geonode",
        (
            "https://proxylist.geonode.com/api/proxy-list"
            "?limit=80&page=1&sort_by=lastChecked&sort_type=desc&protocols=http"
        ),
        "geonode",
    ),
)


@dataclass(frozen=True)
class Candidate:
    scheme: str
    host: str
    port: int
    source: str


@dataclass
class FetchReport:
    fetched: int
    tried: int
    added: int
    skipped: int
    purged: int
    sources: List[str] = field(default_factory=list)
    errors: List[Dict[str, str]] = field(default_factory=list)
    entries: List[ProxyEntry] = field(default_factory=list)

    def as_api(self) -> Dict[str, Any]:
        return {
            "fetched": self.fetched,
            "tried": self.tried,
            "added": self.added,
            "skipped": self.skipped,
            "purged": self.purged,
            "sources": list(self.sources),
            "errors": list(self.errors),
            "added_entries": [entry.as_api() for entry in self.entries],
        }


def pull_candidates(
    client: Optional[httpx.Client] = None,
    timeout: float = FETCH_TIMEOUT_S,
    sources: Sequence[Tuple[str, str, str]] = SOURCES,
) -> Tuple[List[Candidate], List[Dict[str, str]], List[str]]:
    own = client is None
    http = client or httpx.Client(
        timeout=timeout,
        follow_redirects=True,
        headers=FETCH_HEADERS,
    )
    found: List[Candidate] = []
    seen: set[Tuple[str, str, int]] = set()
    errors: List[Dict[str, str]] = []
    used: List[str] = []
    try:
        for name, url, kind in sources:
            try:
                response = http.get(url)
                response.raise_for_status()
            except httpx.HTTPError as exc:
                errors.append({"source": name, "error": str(exc)[:200]})
                continue
            used.append(name)
            batch = (
                parse_text(response.text, name)
                if kind == "text"
                else parse_geonode(response.text, name)
            )
            for item in batch:
                key = (item.scheme, item.host, item.port)
                if key in seen:
                    continue
                seen.add(key)
                found.append(item)
    finally:
        if own:
            http.close()
    return found, errors, used


def parse_text(body: str, source: str, scheme: str = "http") -> List[Candidate]:
    out: List[Candidate] = []
    for match in LINE_RE.finditer(body or ""):
        item = _candidate(scheme, match.group("host"), match.group("port"), source)
        if item is not None:
            out.append(item)
    return out


def parse_geonode(body: str, source: str) -> List[Candidate]:
    try:
        payload = json.loads(body or "{}")
    except json.JSONDecodeError:
        return []
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return []
    out: List[Candidate] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        protocols = row.get("protocols") or ["http"]
        if not isinstance(protocols, list):
            protocols = ["http"]
        scheme = "http"
        for proto in protocols:
            name = str(proto).strip().lower()
            if name in ("http", "https"):
                scheme = name
                break
            if name == "socks5":
                scheme = "socks5"
        item = _candidate(scheme, row.get("ip"), row.get("port"), source)
        if item is not None:
            out.append(item)
    return out


def ingest_public(
    pool: ProxyPool,
    *,
    limit: int = DEFAULT_LIMIT,
    validate: bool = True,
    max_try: int = DEFAULT_MAX_TRY,
    checker: Optional[Callable[..., CheckResult]] = None,
    puller: Optional[Callable[..., Tuple[List[Candidate], List[Dict[str, str]], List[str]]]] = None,
    purge_lab: bool = True,
) -> FetchReport:
    keep = max(1, min(int(limit), MAX_LIMIT))
    attempts = max(keep, min(int(max_try), 40))
    purged = purge_lab_placeholders(pool) if purge_lab else 0
    pull = puller or pull_candidates
    check = checker or check_entry
    candidates, errors, used = pull()
    added: List[ProxyEntry] = []
    tried = 0
    skipped = 0
    for item in candidates:
        if len(added) >= keep:
            break
        existing = pool.find(item.scheme, item.host, item.port)
        if existing is not None:
            skipped += 1
            continue
        if validate:
            if tried >= attempts:
                break
            result = check(_probe_entry(item), timeout=VALIDATE_TIMEOUT_S)
            tried += 1
            if not result.ok:
                continue
            entry = pool.add(
                item.scheme,
                item.host,
                item.port,
                source="public",
                note=item.source,
            )
            stored = pool.record_check(
                entry.id,
                ok=True,
                latency_ms=result.latency_ms,
                egress_ip=result.egress_ip,
                error=result.error,
            )
            added.append(stored)
            continue
        added.append(
            pool.add(
                item.scheme,
                item.host,
                item.port,
                source="public",
                note=item.source,
            )
        )
    return FetchReport(
        fetched=len(candidates),
        tried=tried,
        added=len(added),
        skipped=skipped,
        purged=purged,
        sources=used,
        errors=errors,
        entries=added,
    )


def purge_lab_placeholders(pool: ProxyPool) -> int:
    removed = 0
    for scheme, host, port in LAB_PLACEHOLDERS:
        found = pool.find(scheme, host, port)
        if found is None:
            continue
        pool.delete(found.id)
        removed += 1
    return removed


def _candidate(scheme: str, host: Any, port: Any, source: str) -> Optional[Candidate]:
    name = str(host or "").strip()
    try:
        number = int(port)
    except (TypeError, ValueError):
        return None
    if number < 1 or number > 65535:
        return None
    if not is_public_host(name):
        return None
    proto = (scheme or "http").strip().lower()
    if proto not in ("http", "https", "socks5"):
        return None
    return Candidate(proto, name, number, source)


def is_public_host(host: str) -> bool:
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    return not (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_unspecified
    )


def _probe_entry(item: Candidate) -> ProxyEntry:
    return ProxyEntry(
        id="candidate",
        scheme=item.scheme,
        host=item.host,
        port=item.port,
        username="",
        password="",
        enabled=True,
        source="public",
        note=item.source,
        fail_streak=0,
        cooldown_until=None,
        last_ok_at=None,
        last_fail_at=None,
    )
