from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest


RUNNER = Path(__file__).resolve().parents[1] / "dsh" / "approval-hook.mjs"


class HookHandler(BaseHTTPRequestHandler):
    response = {"decision": "ask", "reason": "matched rm"}

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length", "0"))
        self.server.payload = json.loads(self.rfile.read(length))  # type: ignore[attr-defined]
        body = json.dumps(self.response).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args) -> None:
        return None


def run_hook(url: str):
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is unavailable")
    payload = {
        "session_id": "session-1",
        "tool_name": "bash",
        "tool_use_id": "call-1",
        "tool_input": {"command": "rm /tmp/marker"},
    }
    return subprocess.run(
        [node, str(RUNNER)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        env={**os.environ, "WORKBENCH_HOOK_URL": url},
        timeout=10,
        check=False,
    ), payload


def test_hook_runner_emits_claude_ask_payload():
    server = ThreadingHTTPServer(("127.0.0.1", 0), HookHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        result, payload = run_hook(
            "http://127.0.0.1:{}".format(server.server_address[1])
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert result.returncode == 0
    output = json.loads(result.stdout)
    specific = output["hookSpecificOutput"]
    assert specific["hookEventName"] == "PreToolUse"
    assert specific["permissionDecision"] == "ask"
    assert specific["permissionDecisionReason"] == "matched rm"
    assert server.payload == payload  # type: ignore[attr-defined]


def test_hook_runner_fails_closed_when_service_is_unavailable():
    server = ThreadingHTTPServer(("127.0.0.1", 0), HookHandler)
    url = "http://127.0.0.1:{}".format(server.server_address[1])
    server.server_close()

    result, _payload = run_hook(url)

    assert result.returncode == 2
    assert "approval hook:" in result.stderr
