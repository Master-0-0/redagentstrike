from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import duckdb

from .redact import dumps


def _ts_sql(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return text


@dataclass
class HttpEvent:
    id: str
    run_id: str
    ts: str
    host: str
    method: str
    url: str
    status: Optional[int]
    summary: str
    req_headers: Dict[str, str]
    req_body: str
    resp_headers: Dict[str, str]
    resp_body: str
    evidence_id: Optional[str]
    failed: bool
    egress_proxy_id: Optional[str] = None

    def as_api(self, include_bodies: bool = True) -> Dict[str, Any]:
        return {
            "id": self.id,
            "ts": self.ts,
            "host": self.host,
            "summary": self.summary,
            "join": {
                "method": self.method,
                "url": self.url,
                "status": self.status,
            },
            "truncated": {
                "req_headers": self.req_headers,
                "req_body": self.req_body if include_bodies else "",
                "resp_headers": self.resp_headers,
                "resp_body": self.resp_body if include_bodies else "",
            },
            "evidence_id": self.evidence_id,
            "failed": self.failed,
            "egress_proxy_id": self.egress_proxy_id,
        }


class NetStore:
    """DuckDB HTTP timeline warehouse. Single-process writer."""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.available = True
        self.error: Optional[str] = None
        self._lock = threading.Lock()
        self._conn = None
        self._open()

    def _open(self) -> None:
        try:
            self._conn = duckdb.connect(str(self.path))
            self._init_schema()
            self.available = True
            self.error = None
        except Exception as exc:  # noqa: BLE001 — store must degrade, not crash API
            self._conn = None
            self.available = False
            self.error = str(exc)

    def reopen(self) -> bool:
        with self._lock:
            if self.available and self._conn is not None:
                return True
            self._open()
            return self.available

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()

    def _init_schema(self) -> None:
        assert self._conn is not None
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS net_http (
              id VARCHAR PRIMARY KEY,
              run_id VARCHAR NOT NULL,
              ts TIMESTAMP NOT NULL,
              host VARCHAR,
              method VARCHAR,
              url VARCHAR,
              status INTEGER,
              summary VARCHAR,
              req_headers VARCHAR,
              req_body VARCHAR,
              resp_headers VARCHAR,
              resp_body VARCHAR,
              evidence_id VARCHAR,
              failed BOOLEAN DEFAULT FALSE
            )
            """
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_net_http_run_ts ON net_http(run_id, ts)"
        )
        try:
            self._conn.execute("ALTER TABLE net_http ADD COLUMN egress_proxy_id VARCHAR")
        except Exception:
            pass

    def insert(self, event: HttpEvent) -> None:
        with self._lock:
            if not self.available or self._conn is None:
                raise RuntimeError("store_unavailable")
            self._conn.execute(
            """
            INSERT INTO net_http (
              id, run_id, ts, host, method, url, status, summary,
              req_headers, req_body, resp_headers, resp_body, evidence_id, failed,
              egress_proxy_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                event.id,
                event.run_id,
                event.ts,
                event.host,
                event.method,
                event.url,
                event.status,
                event.summary,
                dumps(event.req_headers),
                event.req_body,
                dumps(event.resp_headers),
                event.resp_body,
                event.evidence_id,
                event.failed,
                event.egress_proxy_id,
            ],
        )

    def get(self, event_id: str) -> Optional[HttpEvent]:
        with self._lock:
            if not self.available or self._conn is None:
                raise RuntimeError("store_unavailable")
            row = self._conn.execute(
                "SELECT id, run_id, ts, host, method, url, status, summary, "
                "req_headers, req_body, resp_headers, resp_body, evidence_id, failed, "
                "egress_proxy_id FROM net_http WHERE id = ?",
                [event_id],
            ).fetchone()
            if row is None:
                return None
            return self._from_row(row)

    def query(
        self,
        run_id: str,
        from_ts: Optional[str] = None,
        to_ts: Optional[str] = None,
        host: Optional[str] = None,
        limit: int = 2000,
    ) -> List[HttpEvent]:
        with self._lock:
            if not self.available or self._conn is None:
                raise RuntimeError("store_unavailable")
            clauses = ["run_id = ?"]
            params: List[Any] = [run_id]
            start = _ts_sql(from_ts)
            end = _ts_sql(to_ts)
            if start:
                clauses.append("ts >= ?")
                params.append(start)
            if end:
                clauses.append("ts <= ?")
                params.append(end)
            if host:
                clauses.append("lower(host) LIKE ?")
                params.append("%{}%".format(host.strip().lower()))
            sql = (
                "SELECT id, run_id, ts, host, method, url, status, summary, "
                "req_headers, req_body, resp_headers, resp_body, evidence_id, failed, "
                "egress_proxy_id FROM net_http WHERE {} ORDER BY ts ASC LIMIT ?"
            ).format(" AND ".join(clauses))
            params.append(limit)
            rows = self._conn.execute(sql, params).fetchall()
            return [self._from_row(row) for row in rows]

    def counts(self, run_id: str) -> Dict[str, int]:
        with self._lock:
            if not self.available or self._conn is None:
                raise RuntimeError("store_unavailable")
            row = self._conn.execute(
                """
                SELECT
                  count(*) AS total,
                  count(*) FILTER (WHERE status BETWEEN 200 AND 299) AS status_2xx,
                  count(*) FILTER (WHERE status BETWEEN 400 AND 499) AS status_4xx,
                  count(*) FILTER (WHERE status BETWEEN 500 AND 599) AS status_5xx,
                  count(*) FILTER (WHERE failed OR status IS NULL) AS failed
                FROM net_http
                WHERE run_id = ?
                """,
                [run_id],
            ).fetchone()
            return {
                "total": int(row[0] or 0),
                "status_2xx": int(row[1] or 0),
                "status_4xx": int(row[2] or 0),
                "status_5xx": int(row[3] or 0),
                "failed": int(row[4] or 0),
            }

    def count_for_run(self, run_id: str) -> int:
        return self.counts(run_id)["total"]

    def clear(self) -> int:
        with self._lock:
            if not self.available or self._conn is None:
                raise RuntimeError("store_unavailable")
            row = self._conn.execute("SELECT count(*) FROM net_http").fetchone()
            deleted = int(row[0] or 0)
            self._conn.execute("DELETE FROM net_http")
            return deleted

    @staticmethod
    def _from_row(row: Any) -> HttpEvent:
        ts = row[2]
        if isinstance(ts, datetime):
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            ts_text = ts.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        else:
            ts_text = str(ts)
        return HttpEvent(
            id=row[0],
            run_id=row[1],
            ts=ts_text,
            host=row[3] or "",
            method=row[4] or "",
            url=row[5] or "",
            status=int(row[6]) if row[6] is not None else None,
            summary=row[7] or "",
            req_headers=_loads_obj(row[8]),
            req_body=row[9] or "",
            resp_headers=_loads_obj(row[10]),
            resp_body=row[11] or "",
            evidence_id=row[12],
            failed=bool(row[13]),
            egress_proxy_id=row[14] if len(row) > 14 else None,
        )


def _loads_obj(raw: Optional[str]) -> Dict[str, str]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(value, dict):
        return {}
    return {str(k): str(v) for k, v in value.items()}
