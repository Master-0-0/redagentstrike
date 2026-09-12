from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import List, Optional

from .config import Settings


def addon_path() -> Path:
    return Path(__file__).resolve().parents[2] / "addons" / "http_capture.py"


class MitmManager:
    """Start/stop mitmproxy regular on loopback. macOS MVP only."""

    def __init__(self, settings: Settings, ingest_url: str) -> None:
        self.settings = settings
        self.ingest_url = ingest_url
        self.proc: Optional[subprocess.Popen] = None
        self.last_error: Optional[str] = None
        self._log_handle = None

    @property
    def listening(self) -> bool:
        if self.proc is None or self.proc.poll() is not None:
            return False
        return _port_open(self.settings.proxy_host, self.settings.proxy_port)

    def status(self) -> dict:
        return {
            "listening": self.listening,
            "pid": self.proc.pid if self.proc and self.proc.poll() is None else None,
            "supported": self.settings.capture_supported,
            "proxy": "http://{}:{}".format(
                self.settings.proxy_host, self.settings.proxy_port
            ),
            "error": self.last_error,
        }

    def start(self) -> None:
        if not self.settings.capture_supported:
            self.last_error = "capture_macos_only"
            raise RuntimeError(self.last_error)
        if self.proc is not None and self.proc.poll() is None:
            self.last_error = None
            return
        if _port_open(self.settings.proxy_host, self.settings.proxy_port):
            self.last_error = "proxy_port_busy"
            raise RuntimeError(self.last_error)
        binary = _find_mitmdump()
        if not binary:
            self.last_error = "mitmproxy_missing"
            raise RuntimeError(self.last_error)
        script = addon_path()
        if not script.exists():
            self.last_error = "addon_missing"
            raise RuntimeError(self.last_error)
        self.settings.mitm_confdir.mkdir(parents=True, exist_ok=True)
        src_root = Path(__file__).resolve().parents[1]
        env = dict(os.environ)
        env["WORKBENCH_INGEST_URL"] = self.ingest_url
        env["WORKBENCH_HOLD_URL"] = self.ingest_url.replace(
            "/internal/net/http", "/internal/net/hold"
        )
        env["WORKBENCH_EGRESS_URL"] = self.ingest_url.replace(
            "/internal/net/http", "/internal/net/egress"
        )
        existing = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = str(src_root) + (("" + os.pathsep + existing) if existing else "")
        cmd: List[str] = [
            binary,
            "--mode",
            "regular",
            "--listen-host",
            self.settings.proxy_host,
            "--listen-port",
            str(self.settings.proxy_port),
            "--set",
            "confdir={}".format(self.settings.mitm_confdir),
            "--set",
            "block_global=false",
            "-s",
            str(script),
            "--quiet",
        ]
        try:
            self._log_handle = None
            log_path = self.settings.mitm_confdir / "mitmdump.log"
            self._log_handle = open(log_path, "ab")
            self.proc = subprocess.Popen(
                cmd,
                stdout=self._log_handle,
                stderr=self._log_handle,
                env=env,
            )
        except OSError as exc:
            self.last_error = str(exc)
            raise RuntimeError(self.last_error) from exc
        if not _wait_port(self.settings.proxy_host, self.settings.proxy_port, 8.0):
            err = _tail_log(self.settings.mitm_confdir / "mitmdump.log")
            self.stop()
            self.last_error = err or "mitm_start_timeout"
            raise RuntimeError(self.last_error)
        self.last_error = None

    def stop(self) -> None:
        proc = self.proc
        self.proc = None
        handle = self._log_handle
        self._log_handle = None
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=3)
        if handle is not None:
            try:
                handle.close()
            except OSError:
                pass

    def close(self) -> None:
        self.stop()


def _find_mitmdump() -> Optional[str]:
    env_path = os.environ.get("WORKBENCH_MITMDUMP")
    backend_root = Path(__file__).resolve().parents[2]
    candidates = []
    if env_path:
        candidates.append(Path(env_path))
    candidates.extend(
        [
            backend_root / ".venv-mitm" / "bin" / "mitmdump",
            Path(sys.executable).resolve().parent / "mitmdump",
            backend_root / ".venv" / "bin" / "mitmdump",
        ]
    )
    for path in candidates:
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    return shutil.which("mitmdump")


def _port_open(host: str, port: int) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.25)
    try:
        sock.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def _tail_log(path: Path, limit: int = 2000) -> str:
    try:
        data = path.read_bytes()[-limit:]
    except OSError:
        return ""
    return data.decode("utf-8", errors="replace").strip()


def _wait_port(host: str, port: int, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _port_open(host, port):
            return True
        time.sleep(0.1)
    return False
