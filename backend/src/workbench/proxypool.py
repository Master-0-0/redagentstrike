from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import quote

from .control import new_id, utcnow

SCHEMES = ("http", "https", "socks5")
FAIL_THRESHOLD = 2
COOLDOWN_BASE_S = 60
COOLDOWN_CAP_S = 3600


class PoolEmpty(RuntimeError):
    def __init__(self) -> None:
        super().__init__("pool_empty")


class LeaseError(KeyError):
    pass


@dataclass
class ProxyEntry:
    id: str
    scheme: str
    host: str
    port: int
    username: str
    password: str
    enabled: bool
    source: str
    note: str
    fail_streak: int
    cooldown_until: Optional[str]
    last_ok_at: Optional[str]
    last_fail_at: Optional[str]
    last_check_at: Optional[str] = None
    last_check_ok: Optional[bool] = None
    last_latency_ms: Optional[int] = None
    last_egress_ip: Optional[str] = None
    last_check_error: Optional[str] = None

    @property
    def cooling(self) -> bool:
        return _is_cooling(self.cooldown_until)

    @property
    def leasable(self) -> bool:
        return self.enabled and not self.cooling

    def url(self) -> str:
        return proxy_url(self.scheme, self.host, self.port, self.username, self.password)

    def as_api(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "scheme": self.scheme,
            "host": self.host,
            "port": self.port,
            "username": self.username,
            "has_password": bool(self.password),
            "enabled": self.enabled,
            "source": self.source,
            "note": self.note,
            "fail_streak": self.fail_streak,
            "cooling": self.cooling,
            "cooldown_until": self.cooldown_until,
            "last_ok_at": self.last_ok_at,
            "last_fail_at": self.last_fail_at,
            "alive": self.last_check_ok,
            "latency_ms": self.last_latency_ms,
            "egress_ip": self.last_egress_ip,
            "checked_at": self.last_check_at,
            "check_error": self.last_check_error,
        }


@dataclass
class Lease:
    lease_id: str
    proxy_id: str
    url: str

    def as_api(self) -> Dict[str, Any]:
        return {
            "lease_id": self.lease_id,
            "proxy_id": self.proxy_id,
            "url": self.url,
        }


class ProxyPool:
    """SQLite-backed egress proxy entries and leases."""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = self._connect()
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path), check_same_thread=False, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _init_schema(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS proxy_entries (
              id TEXT PRIMARY KEY,
              scheme TEXT NOT NULL,
              host TEXT NOT NULL,
              port INTEGER NOT NULL,
              username TEXT NOT NULL DEFAULT '',
              password TEXT NOT NULL DEFAULT '',
              enabled INTEGER NOT NULL DEFAULT 1,
              source TEXT NOT NULL DEFAULT 'manual',
              note TEXT NOT NULL DEFAULT '',
              fail_streak INTEGER NOT NULL DEFAULT 0,
              cooldown_until TEXT,
              last_ok_at TEXT,
              last_fail_at TEXT,
              last_check_at TEXT,
              last_check_ok INTEGER,
              last_latency_ms INTEGER,
              last_egress_ip TEXT,
              last_check_error TEXT,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS proxy_leases (
              id TEXT PRIMARY KEY,
              proxy_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              closed_at TEXT,
              result TEXT,
              reason TEXT NOT NULL DEFAULT '',
              FOREIGN KEY (proxy_id) REFERENCES proxy_entries(id)
            );
            CREATE TABLE IF NOT EXISTS proxy_meta (
              key TEXT PRIMARY KEY,
              value TEXT
            );
            """
        )
        self._conn.commit()
        self._migrate_check_columns()

    def _migrate_check_columns(self) -> None:
        rows = self._conn.execute("PRAGMA table_info(proxy_entries)").fetchall()
        have = {row[1] for row in rows}
        columns = {
            "last_check_at": "TEXT",
            "last_check_ok": "INTEGER",
            "last_latency_ms": "INTEGER",
            "last_egress_ip": "TEXT",
            "last_check_error": "TEXT",
        }
        for name, decl in columns.items():
            if name not in have:
                self._conn.execute(
                    "ALTER TABLE proxy_entries ADD COLUMN {} {}".format(name, decl)
                )
        self._conn.commit()

    def list_entries(self) -> List[ProxyEntry]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM proxy_entries ORDER BY created_at DESC"
            ).fetchall()
            return [self._entry_from_row(row) for row in rows]

    def snapshot(self) -> Dict[str, Any]:
        entries = self.list_entries()
        enabled = [item for item in entries if item.enabled]
        cooling = [item for item in enabled if item.cooling]
        leasable = [item for item in enabled if item.leasable]
        alive = [item for item in entries if item.last_check_ok is True]
        dead = [item for item in entries if item.last_check_ok is False]
        unknown = [item for item in entries if item.last_check_ok is None]
        latencies = [item.last_latency_ms for item in alive if item.last_latency_ms is not None]
        if not entries:
            empty = "no_entries"
        elif not enabled:
            empty = "all_disabled"
        elif not leasable:
            empty = "all_cooling"
        else:
            empty = "ok"
        return {
            "entries": [item.as_api() for item in entries],
            "counts": {
                "total": len(entries),
                "nodes": len(entries),
                "enabled": len(enabled),
                "cooling": len(cooling),
                "alive": len(alive),
                "dead": len(dead),
                "unknown": len(unknown),
                "latency_ms": int(sum(latencies) / len(latencies)) if latencies else None,
            },
            "empty": empty,
        }

    def add(
        self,
        scheme: str,
        host: str,
        port: int,
        username: str = "",
        password: str = "",
        note: str = "",
        source: str = "manual",
    ) -> ProxyEntry:
        scheme, host, port = _validate(scheme, host, port)
        existing = self.find(scheme, host, port)
        if existing is not None:
            return existing
        entry_id = new_id("proxy")
        created = utcnow()
        with self._lock:
            self._conn.execute(
                "INSERT INTO proxy_entries("
                "id, scheme, host, port, username, password, enabled, source, note, "
                "fail_streak, cooldown_until, last_ok_at, last_fail_at, created_at"
                ") VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 0, NULL, NULL, NULL, ?)",
                (entry_id, scheme, host, port, username or "", password or "", source, note or "", created),
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM proxy_entries WHERE id = ?", (entry_id,)
            ).fetchone()
            assert row is not None
            return self._entry_from_row(row)

    def find(self, scheme: str, host: str, port: int) -> Optional[ProxyEntry]:
        scheme, host, port = _validate(scheme, host, port)
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM proxy_entries WHERE scheme = ? AND host = ? AND port = ?",
                (scheme, host, port),
            ).fetchone()
            return self._entry_from_row(row) if row else None

    def get(self, entry_id: str) -> Optional[ProxyEntry]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM proxy_entries WHERE id = ?", (entry_id,)
            ).fetchone()
            return self._entry_from_row(row) if row else None

    def record_check(
        self,
        entry_id: str,
        ok: bool,
        latency_ms: Optional[int] = None,
        egress_ip: Optional[str] = None,
        error: Optional[str] = None,
    ) -> ProxyEntry:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM proxy_entries WHERE id = ?", (entry_id,)
            ).fetchone()
            if row is None:
                raise KeyError(entry_id)
            self._conn.execute(
                "UPDATE proxy_entries SET last_check_at = ?, last_check_ok = ?, "
                "last_latency_ms = ?, last_egress_ip = ?, last_check_error = ? "
                "WHERE id = ?",
                (
                    utcnow(),
                    1 if ok else 0,
                    latency_ms,
                    egress_ip,
                    error or "",
                    entry_id,
                ),
            )
            self._conn.commit()
            updated = self._conn.execute(
                "SELECT * FROM proxy_entries WHERE id = ?", (entry_id,)
            ).fetchone()
            assert updated is not None
            return self._entry_from_row(updated)

    def patch(
        self,
        entry_id: str,
        enabled: Optional[bool] = None,
        note: Optional[str] = None,
        username: Optional[str] = None,
        password: Optional[str] = None,
    ) -> ProxyEntry:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM proxy_entries WHERE id = ?", (entry_id,)
            ).fetchone()
            if row is None:
                raise KeyError(entry_id)
            fields: List[str] = []
            values: List[Any] = []
            if enabled is not None:
                fields.append("enabled = ?")
                values.append(1 if enabled else 0)
            if note is not None:
                fields.append("note = ?")
                values.append(note)
            if username is not None:
                fields.append("username = ?")
                values.append(username)
            if password is not None:
                fields.append("password = ?")
                values.append(password)
            if fields:
                values.append(entry_id)
                self._conn.execute(
                    "UPDATE proxy_entries SET {} WHERE id = ?".format(", ".join(fields)),
                    values,
                )
                self._conn.commit()
            updated = self._conn.execute(
                "SELECT * FROM proxy_entries WHERE id = ?", (entry_id,)
            ).fetchone()
            assert updated is not None
            return self._entry_from_row(updated)

    def delete(self, entry_id: str) -> None:
        with self._lock:
            row = self._conn.execute(
                "SELECT id FROM proxy_entries WHERE id = ?", (entry_id,)
            ).fetchone()
            if row is None:
                raise KeyError(entry_id)
            self._conn.execute("DELETE FROM proxy_leases WHERE proxy_id = ?", (entry_id,))
            self._conn.execute("DELETE FROM proxy_entries WHERE id = ?", (entry_id,))
            self._conn.commit()

    def lease(self, exclude_ids: Optional[Iterable[str]] = None) -> Lease:
        blocked = {item for item in (exclude_ids or []) if item}
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM proxy_entries ORDER BY created_at ASC, id ASC"
            ).fetchall()
            candidates: List[ProxyEntry] = []
            for row in rows:
                entry = self._entry_from_row(row)
                if entry.leasable and entry.id not in blocked:
                    candidates.append(entry)
            if not candidates:
                raise PoolEmpty()
            last = self._meta("last_proxy_id")
            ids = [item.id for item in candidates]
            if last in ids:
                index = (ids.index(last) + 1) % len(ids)
            else:
                index = 0
            chosen = candidates[index]
            lease_id = new_id("lease")
            self._conn.execute(
                "INSERT INTO proxy_leases(id, proxy_id, created_at, closed_at, result, reason) "
                "VALUES (?, ?, ?, NULL, NULL, '')",
                (lease_id, chosen.id, utcnow()),
            )
            self._set_meta("last_proxy_id", chosen.id)
            self._conn.commit()
            return Lease(lease_id=lease_id, proxy_id=chosen.id, url=chosen.url())

    def ok(self, lease_id: str) -> ProxyEntry:
        with self._lock:
            lease, entry = self._open_lease(lease_id)
            self._conn.execute(
                "UPDATE proxy_entries SET fail_streak = 0, cooldown_until = NULL, last_ok_at = ? "
                "WHERE id = ?",
                (utcnow(), entry.id),
            )
            self._close_lease(lease, "ok", "")
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM proxy_entries WHERE id = ?", (entry.id,)
            ).fetchone()
            assert row is not None
            return self._entry_from_row(row)

    def fail(self, lease_id: str, reason: str = "") -> ProxyEntry:
        with self._lock:
            lease, entry = self._open_lease(lease_id)
            streak = entry.fail_streak + 1
            cooldown = None
            if streak >= FAIL_THRESHOLD:
                overshoot = streak - FAIL_THRESHOLD
                seconds = min(COOLDOWN_CAP_S, COOLDOWN_BASE_S * (2 ** overshoot))
                cooldown = (_now() + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
            self._conn.execute(
                "UPDATE proxy_entries SET fail_streak = ?, cooldown_until = ?, last_fail_at = ? "
                "WHERE id = ?",
                (streak, cooldown, utcnow(), entry.id),
            )
            self._close_lease(lease, "fail", reason or "")
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM proxy_entries WHERE id = ?", (entry.id,)
            ).fetchone()
            assert row is not None
            return self._entry_from_row(row)

    def _open_lease(self, lease_id: str):
        row = self._conn.execute(
            "SELECT * FROM proxy_leases WHERE id = ?", (lease_id,)
        ).fetchone()
        if row is None:
            raise LeaseError(lease_id)
        entry_row = self._conn.execute(
            "SELECT * FROM proxy_entries WHERE id = ?", (row["proxy_id"],)
        ).fetchone()
        if entry_row is None:
            raise LeaseError(lease_id)
        return row, self._entry_from_row(entry_row)

    def _close_lease(self, lease: sqlite3.Row, result: str, reason: str) -> None:
        if lease["closed_at"]:
            return
        self._conn.execute(
            "UPDATE proxy_leases SET closed_at = ?, result = ?, reason = ? WHERE id = ?",
            (utcnow(), result, reason, lease["id"]),
        )

    def _meta(self, key: str) -> Optional[str]:
        row = self._conn.execute(
            "SELECT value FROM proxy_meta WHERE key = ?", (key,)
        ).fetchone()
        return row["value"] if row and row["value"] else None

    def _set_meta(self, key: str, value: str) -> None:
        self._conn.execute(
            "INSERT INTO proxy_meta(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    @staticmethod
    def _entry_from_row(row: sqlite3.Row) -> ProxyEntry:
        return ProxyEntry(
            id=row["id"],
            scheme=row["scheme"],
            host=row["host"],
            port=int(row["port"]),
            username=row["username"] or "",
            password=row["password"] or "",
            enabled=bool(row["enabled"]),
            source=row["source"] or "manual",
            note=row["note"] or "",
            fail_streak=int(row["fail_streak"] or 0),
            cooldown_until=row["cooldown_until"],
            last_ok_at=row["last_ok_at"],
            last_fail_at=row["last_fail_at"],
            last_check_at=_row_get(row, "last_check_at"),
            last_check_ok=_bool_or_none(_row_get(row, "last_check_ok")),
            last_latency_ms=_int_or_none(_row_get(row, "last_latency_ms")),
            last_egress_ip=_row_get(row, "last_egress_ip") or None,
            last_check_error=_row_get(row, "last_check_error") or None,
        )


def proxy_url(scheme: str, host: str, port: int, username: str = "", password: str = "") -> str:
    auth = ""
    if username:
        auth = "{}:{}@".format(quote(username, safe=""), quote(password or "", safe=""))
    return "{}://{}{}:{}".format(scheme, auth, host, port)


def _validate(scheme: str, host: str, port: int) -> tuple:
    cleaned = (scheme or "").strip().lower()
    if cleaned not in SCHEMES:
        raise ValueError("scheme_invalid")
    name = (host or "").strip()
    if not name:
        raise ValueError("host_required")
    if not isinstance(port, int):
        try:
            port = int(port)
        except (TypeError, ValueError) as exc:
            raise ValueError("port_invalid") from exc
    if port < 1 or port > 65535:
        raise ValueError("port_invalid")
    return cleaned, name, port


def _row_get(row: sqlite3.Row, key: str) -> Any:
    try:
        return row[key]
    except (IndexError, KeyError):
        return None


def _bool_or_none(value: Any) -> Optional[bool]:
    if value is None:
        return None
    return bool(value)


def _int_or_none(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    return int(value)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _is_cooling(until: Optional[str]) -> bool:
    if not until:
        return False
    text = until.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        stamp = datetime.fromisoformat(text)
    except ValueError:
        return False
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp > _now()
