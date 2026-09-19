from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any, Dict, List, Literal, Optional, Tuple
from urllib.parse import urlsplit

import httpx
from websockets.asyncio.client import connect

from .config import Settings
from .harness import HarnessManager


RuleKind = Literal["command", "regex"]
Decision = Literal["allowed-once", "rejected"]


@dataclass(frozen=True)
class ApprovalRule:
    id: str
    label: str
    kind: RuleKind
    value: str
    enabled: bool = True


@dataclass
class HookCorrelation:
    session_id: str
    call_id: str
    tool_name: str
    command: str
    matched_rules: List[str]
    reason: str
    expires_at: float


@dataclass
class PendingApproval:
    event_id: str
    session_id: str
    tool_name: str
    command: str
    matched_rules: List[str]
    reason: Optional[str]
    created_at: str
    call_id: Optional[str] = None

    def as_api(self) -> Dict[str, Any]:
        return asdict(self)


DEFAULT_RULES = [
    ApprovalRule(id="default-rm", label="删除文件（rm）", kind="command", value="rm"),
    ApprovalRule(id="default-del", label="删除文件（del）", kind="command", value="del"),
    ApprovalRule(id="default-drop", label="删除对象（drop）", kind="command", value="drop"),
]


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _compile_rule(rule: ApprovalRule) -> re.Pattern[str]:
    value = rule.value.strip()
    if not value:
        raise ValueError("rule value must not be empty")
    if rule.kind == "command":
        return re.compile(r"(?<![\w-]){}(?![\w-])".format(re.escape(value)), re.IGNORECASE)
    if rule.kind == "regex":
        try:
            return re.compile(value, re.IGNORECASE)
        except re.error as exc:
            raise ValueError("invalid regex for rule {!r}: {}".format(rule.label, exc)) from exc
    raise ValueError("unsupported rule kind: {}".format(rule.kind))


def validate_rules(raw_rules: List[Dict[str, Any]]) -> List[ApprovalRule]:
    rules: List[ApprovalRule] = []
    seen: set[str] = set()
    for index, raw in enumerate(raw_rules):
        rule_id = str(raw.get("id") or "").strip()
        label = str(raw.get("label") or "").strip()
        kind = str(raw.get("kind") or "").strip()
        value = str(raw.get("value") or "").strip()
        enabled = raw.get("enabled", True)
        if not rule_id:
            raise ValueError("rule {} is missing id".format(index + 1))
        if rule_id in seen:
            raise ValueError("duplicate rule id: {}".format(rule_id))
        if not label:
            raise ValueError("rule {} is missing label".format(rule_id))
        if kind not in {"command", "regex"}:
            raise ValueError("rule {} has unsupported kind".format(rule_id))
        if not isinstance(enabled, bool):
            raise ValueError("rule {} enabled must be boolean".format(rule_id))
        rule = ApprovalRule(
            id=rule_id,
            label=label,
            kind=kind,  # type: ignore[arg-type]
            value=value,
            enabled=enabled,
        )
        _compile_rule(rule)
        seen.add(rule_id)
        rules.append(rule)
    return rules


class ApprovalManager:
    def __init__(
        self,
        settings: Settings,
        harness: HarnessManager,
        *,
        correlation_ttl_s: float = 120.0,
    ) -> None:
        self.settings = settings
        self.harness = harness
        self.correlation_ttl_s = correlation_ttl_s
        self._rules = self._load_rules()
        self._compiled: Dict[str, re.Pattern[str]] = {
            rule.id: _compile_rule(rule) for rule in self._rules
        }
        self._lock = RLock()
        self._correlations: Dict[Tuple[str, str], HookCorrelation] = {}
        self._pending: Dict[str, PendingApproval] = {}
        self._hook_waiters: Dict[str, asyncio.Future[Decision]] = {}
        self._task: Optional[asyncio.Task[None]] = None
        self._stop: Optional[asyncio.Event] = None
        self._connected = False
        self._error: Optional[str] = None
        self._client_id: Optional[str] = None
        self._origin: Optional[str] = None
        self._cookie: Optional[str] = None
        self._http: Optional[httpx.AsyncClient] = None

    async def start(self) -> None:
        if self._task is not None:
            return
        self._stop = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name="workbench-dsh-approvals")

    async def close(self) -> None:
        if self._stop is not None:
            self._stop.set()
        task = self._task
        self._task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        await self._close_transport()
        self._stop = None

    def status(self) -> Dict[str, Any]:
        with self._lock:
            self._prune_correlations_locked()
            return {
                "connected": self._connected,
                "error": self._error,
                "pending_count": len(self._pending),
            }

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "pending": [item.as_api() for item in self._pending.values()],
                "pending_count": len(self._pending),
                "bridge": {
                    "connected": self._connected,
                    "error": self._error,
                },
            }

    def rules_snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {"rules": [asdict(rule) for rule in self._rules]}

    def replace_rules(self, raw_rules: List[Dict[str, Any]]) -> Dict[str, Any]:
        rules = validate_rules(raw_rules)
        compiled = {rule.id: _compile_rule(rule) for rule in rules}
        payload = {"rules": [asdict(rule) for rule in rules]}
        path = self.settings.approval_rules_path
        with self._lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            temp = path.with_suffix(path.suffix + ".tmp")
            temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            temp.replace(path)
            self._rules = rules
            self._compiled = compiled
        return payload

    def check_hook(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        correlation = self._match_hook(payload)
        if correlation is None:
            return {"decision": "allow"}
        with self._lock:
            self._prune_correlations_locked()
            self._correlations[(correlation.session_id, correlation.call_id)] = correlation
        return {"decision": "ask", "reason": correlation.reason}

    async def request_hook(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        correlation = self._match_hook(payload)
        if correlation is None:
            return {"decision": "allow"}
        event_id = "hook-{}".format(uuid.uuid4())
        waiter = asyncio.get_running_loop().create_future()
        pending = PendingApproval(
            event_id=event_id,
            session_id=correlation.session_id,
            tool_name=correlation.tool_name,
            call_id=correlation.call_id,
            command=correlation.command,
            matched_rules=correlation.matched_rules,
            reason=correlation.reason,
            created_at=_utcnow(),
        )
        with self._lock:
            self._pending[event_id] = pending
            self._hook_waiters[event_id] = waiter
        try:
            outcome = await waiter
        finally:
            with self._lock:
                self._pending.pop(event_id, None)
                self._hook_waiters.pop(event_id, None)
        if outcome == "allowed-once":
            return {"decision": "allow"}
        return {"decision": "deny", "reason": "用户拒绝了高危命令"}

    def _match_hook(self, payload: Dict[str, Any]) -> Optional[HookCorrelation]:
        session_id = str(payload.get("session_id") or "").strip()
        tool_name = str(payload.get("tool_name") or "").strip()
        call_id = str(payload.get("tool_use_id") or "").strip()
        tool_input = payload.get("tool_input")
        command = ""
        if isinstance(tool_input, dict):
            raw_command = tool_input.get("command")
            if isinstance(raw_command, str):
                command = raw_command
        if not session_id or not call_id or not tool_name or not command:
            return None

        with self._lock:
            matched = [
                rule.label
                for rule in self._rules
                if rule.enabled and self._compiled[rule.id].search(command) is not None
            ]
            if not matched:
                return None
            reason = "高危命令命中规则：" + "、".join(matched)
        return HookCorrelation(
            session_id=session_id,
            call_id=call_id,
            tool_name=tool_name,
            command=command,
            matched_rules=matched,
            reason=reason,
            expires_at=time.monotonic() + self.correlation_ttl_s,
        )

    async def decide(self, event_id: str, outcome: Decision) -> bool:
        if outcome not in {"allowed-once", "rejected"}:
            raise ValueError("unsupported approval outcome")
        with self._lock:
            if event_id not in self._pending:
                return False
            waiter = self._hook_waiters.get(event_id)
            if waiter is not None:
                self._pending.pop(event_id, None)
                if not waiter.done():
                    waiter.set_result(outcome)
                return True
        await self._send_result(
            event_id,
            {"kind": "result", "value": outcome},
        )
        with self._lock:
            self._pending.pop(event_id, None)
        return True

    def _load_rules(self) -> List[ApprovalRule]:
        path = self.settings.approval_rules_path
        if not path.is_file():
            return list(DEFAULT_RULES)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            rows = raw.get("rules") if isinstance(raw, dict) else None
            if not isinstance(rows, list):
                raise ValueError("rules must be a list")
            return validate_rules([row for row in rows if isinstance(row, dict)])
        except (OSError, ValueError, json.JSONDecodeError):
            return list(DEFAULT_RULES)

    def _prune_correlations_locked(self) -> None:
        now = time.monotonic()
        expired = [key for key, item in self._correlations.items() if item.expires_at <= now]
        for key in expired:
            self._correlations.pop(key, None)

    async def _run(self) -> None:
        stop = self._stop
        if stop is None:
            return
        while not stop.is_set():
            url = self.harness.status().get("url")
            if not isinstance(url, str) or not url:
                with self._lock:
                    self._connected = False
                    self._error = "Harness 未连接"
                await self._sleep(0.8)
                continue
            try:
                await self._connect_once(url)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                with self._lock:
                    self._connected = False
                    self._error = str(exc)[:300]
                await self._close_transport()
                await self._sleep(1.0)

    async def _sleep(self, seconds: float) -> None:
        stop = self._stop
        if stop is None:
            return
        try:
            await asyncio.wait_for(stop.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    async def _connect_once(self, token_url: str) -> None:
        await self._close_transport()
        parsed = urlsplit(token_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise RuntimeError("invalid Harness URL")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        origin = "{}://{}:{}".format(parsed.scheme, parsed.hostname, port)
        http = httpx.AsyncClient(follow_redirects=True, timeout=10.0, trust_env=False)
        response = await http.get(token_url)
        response.raise_for_status()
        cookie = "; ".join("{}={}".format(item.name, item.value) for item in http.cookies.jar)
        if not cookie:
            await http.aclose()
            raise RuntimeError("Harness authentication cookie was not issued")

        ws_scheme = "wss" if parsed.scheme == "https" else "ws"
        ws_url = "{}://{}:{}/api/remote.mux".format(ws_scheme, parsed.hostname, port)
        with self._lock:
            self._http = http
            self._origin = origin
            self._cookie = cookie
        stream_id = "workbench-approval"
        async with connect(
            ws_url,
            additional_headers={"Cookie": cookie},
            proxy=None,
            ping_interval=20,
            ping_timeout=20,
        ) as socket:
            await socket.send(json.dumps({
                "type": "open",
                "streamId": stream_id,
                "endpoint": "$events",
                "payload": {"args": {}},
            }))
            async for raw in socket:
                frame = json.loads(raw)
                if not isinstance(frame, dict) or frame.get("streamId") != stream_id:
                    continue
                if frame.get("type") == "error":
                    raise RuntimeError("Harness event stream failed: {}".format(frame.get("error")))
                if frame.get("type") == "end":
                    raise RuntimeError("Harness event stream ended")
                if frame.get("type") != "item":
                    continue
                value = frame.get("value")
                if not isinstance(value, dict):
                    continue
                await self._handle_event(value)

    async def _handle_event(self, value: Dict[str, Any]) -> None:
        kind = value.get("type")
        if kind == "ready":
            client_id = value.get("clientId")
            if isinstance(client_id, str) and client_id:
                with self._lock:
                    self._client_id = client_id
                    self._connected = True
                    self._error = None
            return
        if kind == "cancel":
            event_id = value.get("eventId")
            if isinstance(event_id, str):
                with self._lock:
                    self._pending.pop(event_id, None)
            return
        if kind != "waterfall" or value.get("event") != "approval/request":
            return

        event_id = value.get("eventId")
        session_id = value.get("agentId")
        request = value.get("request")
        if not isinstance(event_id, str) or not isinstance(session_id, str) or not isinstance(request, dict):
            return
        call_id_raw = request.get("callId")
        call_id = call_id_raw if isinstance(call_id_raw, str) else ""
        with self._lock:
            if event_id in self._pending:
                return
            self._prune_correlations_locked()
            correlation = self._correlations.pop((session_id, call_id), None)
        if correlation is None:
            await self._send_result(event_id, {"kind": "next"})
            return

        reason_raw = request.get("reason")
        tool_raw = request.get("toolName")
        with self._lock:
            self._pending[event_id] = PendingApproval(
                event_id=event_id,
                session_id=session_id,
                tool_name=tool_raw if isinstance(tool_raw, str) else correlation.tool_name,
                call_id=call_id or None,
                command=correlation.command,
                matched_rules=correlation.matched_rules,
                reason=reason_raw if isinstance(reason_raw, str) else correlation.reason,
                created_at=_utcnow(),
            )

    async def _send_result(self, event_id: str, outcome: Dict[str, Any]) -> None:
        with self._lock:
            if (
                not self._connected
                or self._client_id is None
                or self._origin is None
                or self._cookie is None
                or self._http is None
            ):
                raise RuntimeError("Harness approval bridge is disconnected")
            client_id = self._client_id
            origin = self._origin
            cookie = self._cookie
            http = self._http
        payload = {
            "type": "client-request",
            "rpcId": "workbench-approval-{}".format(uuid.uuid4()),
            "method": "$events/result",
            "payload": {
                "args": {
                    "clientId": client_id,
                    "eventId": event_id,
                    "outcome": outcome,
                }
            },
        }
        response = await http.post(
            origin + "/api/$events/result",
            headers={"Content-Type": "application/json", "Cookie": cookie},
            json=payload,
        )
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict) or not isinstance(body.get("result"), dict):
            raise RuntimeError("invalid Harness approval response")
        result = body["result"]
        if result.get("ok") is not True:
            error = result.get("error")
            if isinstance(error, dict) and isinstance(error.get("message"), str):
                raise RuntimeError(error["message"])
            raise RuntimeError("Harness rejected approval response")

    async def _close_transport(self) -> None:
        with self._lock:
            self._connected = False
            self._client_id = None
            self._origin = None
            self._cookie = None
            http = self._http
            self._http = None
        if http is not None:
            await http.aclose()
