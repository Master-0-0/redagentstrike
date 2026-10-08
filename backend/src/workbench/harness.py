"""Attach local DeepSeek Harness (Agent 工作台) to the workbench proxy.

DSH reads HTTP_PROXY only at launch. Capture therefore restarts the local
`dsh web` on WORKBENCH_DSH_PORT with proxy env + mitm CA, and strips it again
when capture stops so model calls do not hang on a dead proxy.
"""

from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import time
from pathlib import Path
from typing import List, Optional

from .config import Settings
from .spawn import direct_env, proxy_env, proxy_url

READY_RE = re.compile(
    r"dsh web: (https?://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_-]+)"
)


def parse_ready_url(text: str) -> Optional[str]:
    matches = READY_RE.findall(text)
    return matches[-1] if matches else None


class HarnessManager:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.proc: Optional[subprocess.Popen] = None
        self.url: Optional[str] = None
        self.last_error: Optional[str] = None
        self._injected = False
        self._log_handle = None
        self._log_start = 0

    def status(self) -> dict:
        pid = self._listen_pid()
        proxied = self._pid_is_proxied(pid) if pid else False
        if pid:
            found = self._url_from_log()
            if found:
                self.url = found
        return {
            "managed": self.settings.manage_dsh,
            "proxied": proxied,
            "pid": pid,
            "url": self.url,
            "error": self.last_error,
        }

    def apply(self, proxied: bool) -> None:
        if not self.settings.manage_dsh:
            self.last_error = None
            return
        root = self.settings.dsh_root
        if root is None or not root.is_dir():
            self.last_error = "dsh_root_missing"
            raise RuntimeError(self.last_error)
        pid = self._listen_pid()
        already = bool(pid) and self._pid_is_proxied(pid)
        if proxied == already and pid:
            self._injected = proxied
            self.last_error = None
            if not self.url:
                self.url = self._url_from_log()
            return
        self._restart(proxied)
        self._injected = proxied
        self.last_error = None

    def close(self) -> None:
        if self._injected:
            try:
                self.apply(False)
            except RuntimeError:
                pass
        self._injected = False
        self._close_log()

    def _restart(self, proxied: bool) -> None:
        self._stop_listener()
        cmd = _dsh_cmd(self.settings)
        env = proxy_env(self.settings) if proxied else direct_env(self.settings)
        env["PATH"] = os.environ.get("PATH", "")
        env["WORKBENCH_DSH_HOOK_CONFIG"] = str(self.settings.dsh_hook_config)
        env["WORKBENCH_DSH_HOOK_ROOT"] = str(self.settings.dsh_hook_root)
        env["WORKBENCH_HOOK_URL"] = self.settings.hook_api_url
        log_path = self.settings.data_dir / "dsh-web.log"
        self.settings.data_dir.mkdir(parents=True, exist_ok=True)
        self._close_log()
        self._log_handle = open(log_path, "ab")
        self._log_start = self._log_handle.tell()
        try:
            self.proc = subprocess.Popen(
                cmd,
                cwd=str(self.settings.dsh_root),
                env=env,
                stdout=self._log_handle,
                stderr=self._log_handle,
                start_new_session=True,
            )
        except OSError as exc:
            self.last_error = "dsh_spawn_failed"
            self._close_log()
            raise RuntimeError("{}: {}".format(self.last_error, exc)) from exc
        url = self._wait_ready(log_path, timeout=45.0)
        if not url:
            err = _tail(log_path)
            self.last_error = "dsh_start_timeout"
            raise RuntimeError((err or self.last_error)[:500])
        self.url = url

    def _wait_ready(self, log_path: Path, timeout: float) -> Optional[str]:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc is not None and self.proc.poll() is not None:
                return None
            found = parse_ready_url(_tail(log_path, 8000, start=self._log_start))
            if found and _port_open(self.settings.dsh_host, self.settings.dsh_port):
                return found
            time.sleep(0.2)
        return None

    def _url_from_log(self) -> Optional[str]:
        return parse_ready_url(_tail(self.settings.data_dir / "dsh-web.log", 8000))

    def _stop_listener(self) -> None:
        ours = self.proc
        self.proc = None
        if ours is not None and ours.poll() is None:
            _kill_tree(ours.pid, use_group=True)
        else:
            pid = self._listen_pid()
            if pid:
                _kill_tree(pid, use_group=False)
        deadline = time.time() + 8.0
        while time.time() < deadline:
            if self._listen_pid() is None:
                break
            time.sleep(0.15)
        leftover = self._listen_pid()
        if leftover:
            _kill_tree(leftover, force=True, use_group=False)
        self._close_log()

    def _listen_pid(self) -> Optional[int]:
        return _listen_pid(self.settings.dsh_port)

    def _pid_is_proxied(self, pid: int) -> bool:
        blob = _process_command_env(pid)
        marker = "HTTP_PROXY=" + proxy_url(self.settings)
        return marker in blob

    def _close_log(self) -> None:
        handle = self._log_handle
        self._log_handle = None
        if handle is not None:
            try:
                handle.close()
            except OSError:
                pass


def _dsh_cmd(settings: Settings) -> List[str]:
    root = settings.dsh_root
    assert root is not None
    port = str(settings.dsh_port)
    bin_ts = root / "apps" / "cli" / "src" / "bin.ts"
    node = shutil.which("node")
    if node and bin_ts.is_file():
        return [
            node,
            "--import",
            "tsx/esm",
            "apps/cli/src/bin.ts",
            "web",
            "--patch",
            str(settings.dsh_approval_patch),
            "--no-open",
            "--host",
            settings.dsh_host,
            "--port",
            port,
        ]
    pnpm = shutil.which("pnpm")
    if pnpm:
        return [
            pnpm,
            "dsh",
            "web",
            "--patch",
            str(settings.dsh_approval_patch),
            "--no-open",
            "--host",
            settings.dsh_host,
            "--port",
            port,
        ]
    raise RuntimeError("dsh_runtime_missing")


def _listen_pid(port: int) -> Optional[int]:
    try:
        out = subprocess.check_output(
            ["lsof", "-nP", "-iTCP:{}".format(port), "-sTCP:LISTEN"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and parts[1].isdigit():
            return int(parts[1])
    return None


def _process_command_env(pid: int) -> str:
    try:
        return subprocess.check_output(
            ["ps", "eww", "-ww", "-p", str(pid), "-o", "command="],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        return ""


def _kill_tree(pid: int, force: bool = False, use_group: bool = False) -> None:
    sig = signal.SIGKILL if force else signal.SIGTERM
    if use_group:
        try:
            os.killpg(pid, sig)
        except OSError:
            try:
                os.kill(pid, sig)
            except OSError:
                return
    else:
        try:
            os.kill(pid, sig)
        except OSError:
            return
    if force:
        return
    deadline = time.time() + 4.0
    while time.time() < deadline:
        try:
            os.kill(pid, 0)
        except OSError:
            return
        time.sleep(0.1)
    try:
        if use_group:
            os.killpg(pid, signal.SIGKILL)
        else:
            os.kill(pid, signal.SIGKILL)
    except OSError:
        return


def _port_open(host: str, port: int) -> bool:
    import socket

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.25)
    try:
        sock.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def _tail(path: Path, limit: int = 4000, start: int = 0) -> str:
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(start, handle.tell() - limit))
            data = handle.read()
    except OSError:
        return ""
    return data.decode("utf-8", errors="replace")
