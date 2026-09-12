from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

from .proxypool import Lease, PoolEmpty, ProxyPool

MAX_ROTATIONS = 3
ROTATE_REASONS = frozenset({"timeout", "connect", "http_407"})
EGRESS_URL_HEADER = "X-Workbench-Egress"
EGRESS_ID_HEADER = "X-Workbench-Egress-Id"

SendFn = Callable[[Optional[Lease]], "AttemptResult"]


@dataclass
class AttemptResult:
    status: Optional[int] = None
    error: Optional[str] = None
    headers: Dict[str, str] = field(default_factory=dict)
    body: str = ""


@dataclass
class RotateAttempt:
    lease_id: Optional[str]
    proxy_id: Optional[str]
    status: Optional[int]
    error: Optional[str]


@dataclass
class RotateResult:
    status: Optional[int]
    error: Optional[str]
    headers: Dict[str, str]
    body: str
    egress_proxy_id: Optional[str]
    lease_id: Optional[str]
    attempts: List[RotateAttempt]
    rotated: bool


def rotate_http(pool: ProxyPool, send: SendFn) -> RotateResult:
    """Lease a new egress IP after timeout / connect / 407. No silent direct fallback."""
    exclude: List[str] = []
    attempts: List[RotateAttempt] = []
    last: Optional[AttemptResult] = None
    last_lease: Optional[Lease] = None

    for _ in range(MAX_ROTATIONS):
        lease: Optional[Lease]
        try:
            lease = pool.lease(exclude)
        except PoolEmpty:
            lease = None
        if lease is None and exclude:
            break
        result = send(lease)
        last = result
        last_lease = lease
        attempts.append(
            RotateAttempt(
                lease_id=lease.lease_id if lease else None,
                proxy_id=lease.proxy_id if lease else None,
                status=result.status,
                error=result.error,
            )
        )
        should_rotate = bool(lease) and result.error in ROTATE_REASONS
        if should_rotate and lease is not None:
            pool.fail(lease.lease_id, reason=result.error or "")
            exclude.append(lease.proxy_id)
            continue
        if lease is not None and result.error not in ROTATE_REASONS:
            pool.ok(lease.lease_id)
        return _finish(result, lease, attempts)

    if last is None:
        return RotateResult(
            status=None,
            error="pool_empty",
            headers={},
            body="",
            egress_proxy_id=None,
            lease_id=None,
            attempts=attempts,
            rotated=bool(exclude),
        )
    return _finish(last, last_lease, attempts)


def _finish(
    result: AttemptResult,
    lease: Optional[Lease],
    attempts: List[RotateAttempt],
) -> RotateResult:
    return RotateResult(
        status=result.status,
        error=result.error,
        headers=result.headers,
        body=result.body,
        egress_proxy_id=lease.proxy_id if lease else None,
        lease_id=lease.lease_id if lease else None,
        attempts=attempts,
        rotated=len(attempts) > 1,
    )
