"""Drive one live dsh-web session per Agent preset through the proxy pool.

Creates a real session for standard / ptc / minimal / cordis / cairn with
capture on, prompts that mode's Agent to get/next then hit a marked
example.com path (no extra -x), and checks the network timeline for the
egress tag.
"""

from __future__ import annotations

import json
import re
import time
import uuid
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any

import httpx

WORKBENCH = "http://127.0.0.1:8787"
MODES = ("standard", "ptc", "minimal", "cordis", "cairn")
WAIT_S = 180


def health() -> dict[str, Any]:
    return httpx.get(f"{WORKBENCH}/health", timeout=5).json()


def token_url() -> str:
    url = health()["harness"]["url"]
    if not url:
        raise SystemExit("dsh web is not ready")
    return url


def dsh_client(token_url: str) -> httpx.Client:
    client = httpx.Client(
        base_url="http://127.0.0.1:3081",
        timeout=30,
        follow_redirects=True,
        headers={"Origin": "http://127.0.0.1:3081"},
    )
    response = client.get(token_url)
    if response.status_code >= 400:
        client.close()
        raise RuntimeError("dsh auth HTTP {} for {}".format(response.status_code, token_url))
    return client


def rpc(client: httpx.Client, method: str, args: dict[str, Any], timeout: float = 30) -> dict[str, Any]:
    rpc_id = str(uuid.uuid4())
    response = client.post(
        "/api/{}".format(method),
        json={
            "type": "client-request",
            "rpcId": rpc_id,
            "method": method,
            "payload": {"args": args},
        },
        timeout=timeout,
    )
    if response.status_code >= 400:
        raise RuntimeError("{} HTTP {}: {}".format(method, response.status_code, response.text[:400]))
    payload = response.json()
    result = payload.get("result") or {}
    if not result.get("ok"):
        raise RuntimeError("{} failed: {}".format(method, result.get("error") or payload))
    return result.get("value") or {}


def export_session(client: httpx.Client, session_id: str) -> bytes:
    response = client.get("/api/session.export", params={"sessionId": session_id}, timeout=30)
    if response.status_code >= 400:
        raise RuntimeError("export HTTP {}: {}".format(response.status_code, response.text[:400]))
    return response.content


def zip_text(blob: bytes) -> str:
    with zipfile.ZipFile(BytesIO(blob)) as archive:
        parts = []
        for name in archive.namelist():
            if name.endswith("/"):
                continue
            try:
                parts.append(archive.read(name).decode("utf-8", errors="replace"))
            except Exception:
                continue
        return "\n".join(parts)


def set_capture(enabled: bool) -> dict[str, Any]:
    return httpx.post(
        f"{WORKBENCH}/capture",
        json={"enabled": enabled},
        timeout=90,
    ).json()


def wait_capture(enabled: bool, previous_url: str | None = None, timeout: float = 90) -> dict[str, Any]:
    deadline = time.time() + timeout
    last: dict[str, Any] = {}
    while time.time() < deadline:
        last = health()
        cap = last.get("capture") or {}
        harness = last.get("harness") or {}
        listening = bool(cap.get("listening"))
        proxied = bool(harness.get("proxied"))
        url = harness.get("url")
        rotated = bool(url) and url != previous_url
        if enabled and listening and proxied and rotated:
            try:
                probe = httpx.get(url, timeout=8, follow_redirects=True)
            except httpx.HTTPError:
                time.sleep(1)
                continue
            if probe.status_code < 400:
                return last
        if not enabled and not listening and not proxied and rotated:
            return last
        time.sleep(1)
    raise SystemExit("capture {} not ready: {}".format(enabled, last))


def timeline_events() -> list[dict[str, Any]]:
    return list(httpx.get(f"{WORKBENCH}/network", timeout=10).json().get("events") or [])


def event_url(event: dict[str, Any]) -> str:
    join = event.get("join") or {}
    return str(join.get("url") or event.get("url") or "")


def timeline_for(marker: str) -> list[dict[str, Any]]:
    hits = []
    for event in timeline_events():
        if marker not in event_url(event) and marker not in str(event.get("host") or ""):
            if marker not in json.dumps(event, ensure_ascii=False):
                continue
        hits.append(
            {
                "id": event.get("id"),
                "url": event_url(event),
                "host": event.get("host"),
                "status": event.get("status") or (event.get("join") or {}).get("status"),
                "failed": event.get("failed"),
                "egress_proxy_id": event.get("egress_proxy_id"),
            }
        )
    return hits


def prompt_for(mode: str, target: str) -> str:
    extra = ""
    if mode == "cairn":
        extra = "按 Cairn 协议初始化黑板，声明并领取一个 intent，把下面全部命令分配给一个 explorer，主会话审阅其原始输出和证据后完成黑板。主会话不要直接执行命令。\n"
    if mode == "minimal":
        extra = "没有 skill 工具，直接 bash。\n"
    return (
        extra
        + "捕获已开，环境里已有 HTTP_PROXY=http://127.0.0.1:8088。不要再加 -x 指向池节点，也不要用 -x 指向 8088。\n"
        + ("让 explorer 用 bash 按顺序执行下面命令并返回完整 stdout；主会话完成证据审阅后报告结果：\n" if mode == "cairn" else "不要解释。立刻用 bash 按顺序只执行下面命令，把完整 stdout 原样贴回，然后停止：\n")
        + "echo SMOKE_MODE={}\n".format(mode)
        + "curl -sS -X POST http://127.0.0.1:8787/proxy-pool/agent "
        + "-H 'Content-Type: application/json' -d '{\"op\":\"get\"}'\n"
        + "curl -sS -X POST http://127.0.0.1:8787/proxy-pool/agent "
        + "-H 'Content-Type: application/json' -d '{\"op\":\"next\",\"reason\":\"timeout\"}'\n"
        + "curl -sS -D - -o /dev/null --max-time 20 {}\n".format(target)
    )


def find_session(items: list[dict[str, Any]], session_id: str) -> dict[str, Any] | None:
    for item in items:
        if item.get("sessionId") == session_id:
            return item
    return None


def evidence(text: str, mode: str) -> dict[str, Any]:
    leases = sorted(set(re.findall(r"lease-[0-9a-f]{16,}", text)))
    return {
        "smoke_marker": "SMOKE_MODE={}".format(mode) in text,
        "called_get": "proxy-pool/agent" in text,
        "got_url": len(leases) >= 1,
        "called_next": len(leases) >= 2,
        "leases": leases,
    }


def main() -> None:
    pool = httpx.get(f"{WORKBENCH}/proxy-pool", timeout=5).json()
    nodes = len(pool.get("entries") or [])
    if nodes < 2:
        counts = pool.get("counts") or {}
        nodes = int(counts.get("nodes") or counts.get("total") or nodes)
    if nodes < 2:
        raise SystemExit("proxy pool needs at least 2 nodes, got {}".format(nodes))

    before = health()
    cap = set_capture(True)
    if cap.get("error"):
        raise SystemExit("capture on failed: {}".format(cap.get("error")))
    ready = wait_capture(True, previous_url=before.get("harness", {}).get("url"))
    print(
        "capture_on listening={} proxied={} url={}".format(
            ready["capture"]["listening"],
            ready["harness"]["proxied"],
            ready["harness"]["url"],
        )
    )
    rows: list[dict[str, Any]] = []
    try:
        client = dsh_client(token_url())
        listed = rpc(client, "session/list", {"_request": {}})
        print("dsh_ok sessions={}".format(len(listed.get("items") or [])))

        stamp = time.strftime("%H%M%S")
        for mode in MODES:
            marker = "mode-tl-{}-{}".format(mode, stamp)
            target = "http://example.com/{}".format(marker)
            session_id = "smoke-{}-{}".format(mode, stamp)
            created = rpc(
                client,
                "session/create",
                {
                    "request": {
                        "sessionId": session_id,
                        "agentPreset": mode,
                        "cwd": "/Users/hoonek/Desktop/ct-st3",
                    }
                },
            )
            if created.get("agentPreset") != mode:
                raise SystemExit("create {} returned {}".format(mode, created))
            perm = rpc(
                client,
                "commands/execute",
                {
                    "agentId": session_id,
                    "line": "/permission danger-full-access",
                    "submittedAttachments": [],
                },
            )
            if (perm.get("result") or {}).get("kind") != "success":
                raise SystemExit("{} permission failed: {}".format(mode, perm))
            rpc(
                client,
                "session/prompt",
                {
                    "request": {
                        "requestId": str(uuid.uuid4()),
                        "sessionId": session_id,
                        "mode": "queue",
                        "content": [{"type": "text", "text": prompt_for(mode, target)}],
                    }
                },
            )
            deadline = time.time() + WAIT_S
            running = True
            while time.time() < deadline:
                items = rpc(client, "session/list", {"_request": {}}).get("items") or []
                row = find_session(items, session_id) or {}
                running = bool(row.get("running"))
                if not running and not row.get("blank", True):
                    break
                time.sleep(3)
            time.sleep(2)
            blob = b""
            text = ""
            try:
                blob = export_session(client, session_id)
                text = zip_text(blob)
                Path("/tmp/dsh-mode-smoke-{}.txt".format(mode)).write_text(
                    text[:20000], encoding="utf-8"
                )
            except Exception as exc:
                text = "export_failed {}".format(exc)
            found = evidence(text, mode)
            hits = timeline_for(marker)
            lease = httpx.get(f"{WORKBENCH}/proxy-pool/agent", timeout=5).json()
            row = {
                "mode": mode,
                "session_id": session_id,
                "preset": created.get("agentPreset"),
                "target": target,
                "running_at_end": running,
                "export_bytes": len(blob),
                **found,
                "lease_id": lease.get("lease_id"),
                "proxy_id": lease.get("proxy_id"),
                "timeline_hits": len(hits),
                "timeline_egress": [h.get("egress_proxy_id") for h in hits],
                "timeline_captured": any(h.get("egress_proxy_id") for h in hits),
                "timeline": hits,
            }
            rows.append(row)
            print(json.dumps(row, ensure_ascii=False))
    finally:
        off = set_capture(False)
        print("capture_off error={}".format(off.get("error")))

    out = Path("/tmp/dsh-mode-smoke.json")
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    failed = [
        r["mode"]
        for r in rows
        if not r["got_url"] or not r["smoke_marker"] or not r["timeline_captured"]
    ]
    if failed:
        raise SystemExit("failed modes: {}".format(",".join(failed)))
    print("all_modes_ok")


if __name__ == "__main__":
    main()
