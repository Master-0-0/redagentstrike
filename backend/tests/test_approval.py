from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List

from workbench.approval import ApprovalManager
from workbench.config import Settings


class FakeHarness:
    def status(self) -> Dict[str, Any]:
        return {"url": None}


def manager(tmp_path: Path, *, ttl: float = 120.0) -> ApprovalManager:
    value = ApprovalManager(
        Settings(data_dir=tmp_path, api_port=18787, proxy_port=18080),
        FakeHarness(),  # type: ignore[arg-type]
        correlation_ttl_s=ttl,
    )
    value._connected = True
    return value


def hook_payload(command: str, call_id: str = "call-1") -> Dict[str, Any]:
    return {
        "session_id": "session-1",
        "tool_name": "bash",
        "tool_use_id": call_id,
        "tool_input": {"command": command},
    }


def test_default_rules_match_rm_del_and_drop(tmp_path: Path):
    approvals = manager(tmp_path)

    assert approvals.check_hook(hook_payload("rm /tmp/example"))["decision"] == "ask"
    assert approvals.check_hook(hook_payload("DEL important.txt", "call-2"))["decision"] == "ask"
    assert approvals.check_hook(hook_payload("psql -c 'DROP TABLE users'", "call-3"))["decision"] == "ask"
    assert approvals.check_hook(hook_payload("echo safe", "call-4")) == {"decision": "allow"}


def test_rule_update_validates_and_persists(tmp_path: Path):
    approvals = manager(tmp_path)
    saved = approvals.replace_rules([
        {
            "id": "shutdown",
            "label": "关闭系统",
            "kind": "regex",
            "value": r"\bshutdown\b",
            "enabled": True,
        }
    ])

    assert saved["rules"][0]["id"] == "shutdown"
    restored = manager(tmp_path)
    assert restored.rules_snapshot() == saved
    assert restored.check_hook(hook_payload("sudo shutdown -h now"))["decision"] == "ask"


def test_hook_matching_does_not_depend_on_remote_bridge(tmp_path: Path):
    approvals = manager(tmp_path)
    approvals._connected = False

    result = approvals.check_hook(hook_payload("rm /tmp/example"))

    assert result["decision"] == "ask"


def test_direct_hook_request_waits_for_workbench_decision(tmp_path: Path):
    approvals = manager(tmp_path)

    async def exercise() -> None:
        request = asyncio.create_task(
            approvals.request_hook(hook_payload("rm /tmp/marker"))
        )
        await asyncio.sleep(0)
        pending = approvals.snapshot()["pending"]
        assert len(pending) == 1
        assert pending[0]["session_id"] == "session-1"
        assert pending[0]["command"] == "rm /tmp/marker"

        assert await approvals.decide(pending[0]["event_id"], "allowed-once") is True
        assert await request == {"decision": "allow"}
        assert approvals.snapshot()["pending_count"] == 0

    asyncio.run(exercise())


def test_hook_approval_is_queued_and_decided(tmp_path: Path):
    approvals = manager(tmp_path)
    sent: List[tuple[str, Dict[str, Any]]] = []

    async def fake_send(event_id: str, outcome: Dict[str, Any]) -> None:
        sent.append((event_id, outcome))

    approvals._send_result = fake_send  # type: ignore[method-assign]
    assert approvals.check_hook(hook_payload("rm /tmp/marker"))["decision"] == "ask"

    asyncio.run(approvals._handle_event({
        "type": "waterfall",
        "event": "approval/request",
        "eventId": "event-1",
        "agentId": "session-1",
        "request": {
            "toolName": "bash",
            "callId": "call-1",
            "reason": "manual approval required",
        },
    }))

    pending = approvals.snapshot()["pending"]
    assert pending[0]["session_id"] == "session-1"
    assert pending[0]["command"] == "rm /tmp/marker"
    assert asyncio.run(approvals.decide("event-1", "allowed-once")) is True
    assert sent == [("event-1", {"kind": "result", "value": "allowed-once"})]
    assert approvals.snapshot()["pending_count"] == 0


def test_non_hook_approval_delegates_immediately(tmp_path: Path):
    approvals = manager(tmp_path)
    sent: List[tuple[str, Dict[str, Any]]] = []

    async def fake_send(event_id: str, outcome: Dict[str, Any]) -> None:
        sent.append((event_id, outcome))

    approvals._send_result = fake_send  # type: ignore[method-assign]
    asyncio.run(approvals._handle_event({
        "type": "waterfall",
        "event": "approval/request",
        "eventId": "sandbox-event",
        "agentId": "session-1",
        "request": {"toolName": "bash", "callId": "other-call"},
    }))

    assert sent == [("sandbox-event", {"kind": "next"})]
    assert approvals.snapshot()["pending"] == []


def test_pending_replay_is_kept_until_cancelled(tmp_path: Path):
    approvals = manager(tmp_path)
    sent: List[tuple[str, Dict[str, Any]]] = []

    async def fake_send(event_id: str, outcome: Dict[str, Any]) -> None:
        sent.append((event_id, outcome))

    approvals._send_result = fake_send  # type: ignore[method-assign]
    assert approvals.check_hook(hook_payload("rm /tmp/marker"))["decision"] == "ask"
    frame = {
        "type": "waterfall",
        "event": "approval/request",
        "eventId": "event-1",
        "agentId": "session-1",
        "request": {"toolName": "bash", "callId": "call-1"},
    }
    asyncio.run(approvals._handle_event(frame))
    asyncio.run(approvals._handle_event(frame))

    assert sent == []
    assert approvals.snapshot()["pending_count"] == 1
    asyncio.run(approvals._handle_event({"type": "cancel", "eventId": "event-1"}))
    assert approvals.snapshot()["pending_count"] == 0


def test_expired_hook_correlation_does_not_queue(tmp_path: Path):
    approvals = manager(tmp_path, ttl=-1)
    sent: List[tuple[str, Dict[str, Any]]] = []

    async def fake_send(event_id: str, outcome: Dict[str, Any]) -> None:
        sent.append((event_id, outcome))

    approvals._send_result = fake_send  # type: ignore[method-assign]
    assert approvals.check_hook(hook_payload("rm /tmp/marker"))["decision"] == "ask"
    asyncio.run(approvals._handle_event({
        "type": "waterfall",
        "event": "approval/request",
        "eventId": "late-event",
        "agentId": "session-1",
        "request": {"toolName": "bash", "callId": "call-1"},
    }))

    assert sent == [("late-event", {"kind": "next"})]
    assert approvals.snapshot()["pending"] == []


def test_remote_mux_frames_queue_correlated_hook(monkeypatch, tmp_path: Path):
    approvals = manager(tmp_path)
    assert approvals.check_hook(hook_payload("rm /tmp/marker"))["decision"] == "ask"
    approvals._connected = False
    sent_frames: List[Dict[str, Any]] = []

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

    class FakeHttp:
        def __init__(self, *args, **kwargs) -> None:
            self.cookies = SimpleNamespace(
                jar=[SimpleNamespace(name="dsh", value="cookie")]
            )

        async def get(self, _url: str) -> FakeResponse:
            return FakeResponse()

        async def aclose(self) -> None:
            return None

    class FakeSocket:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

        async def send(self, raw: str) -> None:
            sent_frames.append(json.loads(raw))

        def __aiter__(self):
            async def frames():
                yield json.dumps({
                    "type": "item",
                    "streamId": "workbench-approval",
                    "value": {"type": "ready", "clientId": "client-1"},
                })
                yield json.dumps({
                    "type": "item",
                    "streamId": "workbench-approval",
                    "value": {
                        "type": "waterfall",
                        "event": "approval/request",
                        "eventId": "event-1",
                        "agentId": "session-1",
                        "request": {"toolName": "bash", "callId": "call-1"},
                    },
                })
            return frames()

    monkeypatch.setattr("workbench.approval.httpx.AsyncClient", FakeHttp)
    monkeypatch.setattr(
        "workbench.approval.connect",
        lambda *_args, **_kwargs: FakeSocket(),
    )

    asyncio.run(approvals._connect_once("http://127.0.0.1:3081/?token=test"))

    assert sent_frames == [{
        "type": "open",
        "streamId": "workbench-approval",
        "endpoint": "$events",
        "payload": {"args": {}},
    }]
    assert approvals.snapshot()["pending"][0]["command"] == "rm /tmp/marker"


def test_approval_rule_api(client):
    initial = client.get("/approvals/rules")
    assert initial.status_code == 200
    assert {rule["value"] for rule in initial.json()["rules"]} >= {"rm", "del", "drop"}

    updated = client.put("/approvals/rules", json={
        "rules": [{
            "id": "custom",
            "label": "自定义命令",
            "kind": "command",
            "value": "destroy",
            "enabled": True,
        }]
    })
    assert updated.status_code == 200
    assert client.get("/approvals/rules").json() == updated.json()

    invalid = client.put("/approvals/rules", json={
        "rules": [{
            "id": "bad",
            "label": "错误正则",
            "kind": "regex",
            "value": "(",
            "enabled": True,
        }]
    })
    assert invalid.status_code == 422


def test_hook_check_api_allows_safe_command(client):
    result = client.post("/internal/dsh/hook/check", json=hook_payload("echo safe"))
    assert result.status_code == 200
    assert result.json() == {"decision": "allow"}
