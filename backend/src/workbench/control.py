from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def new_id(prefix: str = "") -> str:
    token = uuid.uuid4().hex[:16]
    return "{}-{}".format(prefix, token) if prefix else token


@dataclass
class Run:
    id: str
    title: str
    created_at: str
    ended_at: Optional[str]
    capture_started: bool

    @property
    def open(self) -> bool:
        return self.ended_at is None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "created_at": self.created_at,
            "ended_at": self.ended_at,
            "capture_started": self.capture_started,
            "open": self.open,
        }


@dataclass
class RunEvent:
    id: str
    run_id: str
    ts: str
    kind: str
    name: str
    payload: Dict[str, Any]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "run_id": self.run_id,
            "ts": self.ts,
            "kind": self.kind,
            "name": self.name,
            "payload": self.payload,
        }


class ControlPlane:
    """SQLite control plane: Run lifecycle, CurrentRun, tool_call events."""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = self._connect()
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        try:
            conn = sqlite3.connect(str(self.path), check_same_thread=False, timeout=5)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA schema_version")
        except sqlite3.DatabaseError:
            self._unlink_db()
            conn = sqlite3.connect(str(self.path), check_same_thread=False, timeout=5)
            conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _unlink_db(self) -> None:
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.path) + suffix) if suffix else self.path
            try:
                candidate.unlink()
            except OSError:
                pass

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _init_schema(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS runs (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              created_at TEXT NOT NULL,
              ended_at TEXT,
              capture_started INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS run_events (
              id TEXT PRIMARY KEY,
              run_id TEXT NOT NULL,
              ts TEXT NOT NULL,
              kind TEXT NOT NULL,
              name TEXT NOT NULL DEFAULT '',
              payload TEXT NOT NULL DEFAULT '{}',
              FOREIGN KEY (run_id) REFERENCES runs(id)
            );
            CREATE INDEX IF NOT EXISTS idx_run_events_run_ts
              ON run_events(run_id, ts);
            CREATE TABLE IF NOT EXISTS meta (
              key TEXT PRIMARY KEY,
              value TEXT
            );
            """
        )
        self._conn.commit()

    def current_run_id(self) -> Optional[str]:
        with self._lock:
            return self._current_run_id()

    def _current_run_id(self) -> Optional[str]:
        row = self._conn.execute(
            "SELECT value FROM meta WHERE key = 'current_run_id'"
        ).fetchone()
        return row["value"] if row and row["value"] else None

    def current_run(self) -> Optional[Run]:
        with self._lock:
            run_id = self._current_run_id()
            if not run_id:
                return None
            return self._get_run(run_id)

    def set_current_run(self, run_id: Optional[str]) -> None:
        with self._lock:
            self._set_current_run(run_id)

    def _set_current_run(self, run_id: Optional[str]) -> None:
        self._conn.execute(
            "INSERT INTO meta(key, value) VALUES('current_run_id', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (run_id,),
        )
        self._conn.commit()

    def get_run(self, run_id: str) -> Optional[Run]:
        with self._lock:
            return self._get_run(run_id)

    def _get_run(self, run_id: str) -> Optional[Run]:
        row = self._conn.execute(
            "SELECT * FROM runs WHERE id = ?", (run_id,)
        ).fetchone()
        return self._run_from_row(row) if row else None

    def list_runs(self, limit: int = 50) -> List[Run]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM runs ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
            return [self._run_from_row(row) for row in rows]

    def create_run(self, title: Optional[str] = None) -> Run:
        with self._lock:
            current_id = self._current_run_id()
            current = self._get_run(current_id) if current_id else None
            if current and current.open:
                raise RuntimeError("concurrent_run")
            run_id = new_id("run")
            created = utcnow()
            title = (title or "").strip() or "Run {}".format(created.replace("T", " ")[:19])
            self._conn.execute(
                "INSERT INTO runs(id, title, created_at, ended_at, capture_started) "
                "VALUES (?, ?, ?, NULL, 0)",
                (run_id, title, created),
            )
            self._set_current_run(run_id)
            run = self._get_run(run_id)
            assert run is not None
            return run

    def ensure_open_run(self, title: Optional[str] = None) -> Run:
        with self._lock:
            current_id = self._current_run_id()
            current = self._get_run(current_id) if current_id else None
            if current and current.open:
                return current
            run_id = new_id("run")
            created = utcnow()
            title = (title or "").strip() or "session"
            self._conn.execute(
                "INSERT INTO runs(id, title, created_at, ended_at, capture_started) "
                "VALUES (?, ?, ?, NULL, 0)",
                (run_id, title, created),
            )
            self._set_current_run(run_id)
            run = self._get_run(run_id)
            assert run is not None
            return run

    def latest_run(self) -> Optional[Run]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM runs ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            return self._run_from_row(row) if row else None

    def mark_capture_started(self, run_id: str, started: bool = True) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE runs SET capture_started = ? WHERE id = ?",
                (1 if started else 0, run_id),
            )
            self._conn.commit()

    def end_run(self, run_id: str) -> Run:
        with self._lock:
            run = self._get_run(run_id)
            if run is None:
                raise KeyError(run_id)
            if run.open:
                self._conn.execute(
                    "UPDATE runs SET ended_at = ? WHERE id = ?",
                    (utcnow(), run_id),
                )
                self._conn.commit()
            if self._current_run_id() == run_id:
                self._set_current_run(None)
            ended = self._get_run(run_id)
            assert ended is not None
            return ended

    def add_event(
        self,
        run_id: str,
        kind: str = "tool_call",
        name: str = "",
        payload: Optional[Dict[str, Any]] = None,
        ts: Optional[str] = None,
    ) -> RunEvent:
        with self._lock:
            if self._get_run(run_id) is None:
                raise KeyError(run_id)
            event = RunEvent(
                id=new_id("evt"),
                run_id=run_id,
                ts=ts or utcnow(),
                kind=kind or "tool_call",
                name=name or "",
                payload=payload or {},
            )
            self._conn.execute(
                "INSERT INTO run_events(id, run_id, ts, kind, name, payload) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    event.id,
                    event.run_id,
                    event.ts,
                    event.kind,
                    event.name,
                    json.dumps(event.payload, ensure_ascii=False),
                ),
            )
            self._conn.commit()
            return event

    def list_events(self, run_id: str) -> List[RunEvent]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM run_events WHERE run_id = ? ORDER BY ts ASC",
                (run_id,),
            ).fetchall()
            return [self._event_from_row(row) for row in rows]

    @staticmethod
    def _run_from_row(row: sqlite3.Row) -> Run:
        return Run(
            id=row["id"],
            title=row["title"],
            created_at=row["created_at"],
            ended_at=row["ended_at"],
            capture_started=bool(row["capture_started"]),
        )

    @staticmethod
    def _event_from_row(row: sqlite3.Row) -> RunEvent:
        try:
            payload = json.loads(row["payload"] or "{}")
        except json.JSONDecodeError:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        return RunEvent(
            id=row["id"],
            run_id=row["run_id"],
            ts=row["ts"],
            kind=row["kind"],
            name=row["name"],
            payload=payload,
        )
