"""Drive one live dsh-web session per Agent preset and make that Agent call the pool.

This is not the TestClient composition check. It creates a real session for
standard / ptc / minimal / cordis / cairn, prompts that mode's Agent to curl
get then next, and records the tool output.
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
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener

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


def opener_from(token_url: str):
    opener = build_opener(HTTPCookieProcessor())
    opener.open(token_url, timeout=10)
    return opener


def rpc(opener, method: str, args: dict[str, Any], timeout: float = 30) -> dict[str, Any]:
    rpc_id = str(uuid.uuid4())
    body = json.dumps(
        {
            "type": "client-request",
            "rpcId": rpc_id,
            "method": method,
            "payload": {"args": args},
        }
    ).encode()
    req = Request(
        f"http://127.0.0.1:3081/api/{method}",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Origin": "http://127.0.0.1:3081",
            "Host": "127.0.0.1:3081",
        },
    )
    try:
        with opener.open(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode())
    except HTTPError as exc:
        raise RuntimeError("{} HTTP {}: {}".format(method, exc.code, exc.read()[:400])) from exc
    result = payload.get("result") or {}
    if not result.get("ok"):
        raise RuntimeError("{} failed: {}".format(method, result.get("error") or payload))
    return result.get("value") or {}


def export_session(opener, session_id: str) -> bytes:
    req = Request(
        "http://127.0.0.1:3081/api/session.export?sessionId={}".format(session_id),
        method="GET",
        headers={"Host": "127.0.0.1:3081", "Origin": "http://127.0.0.1:3081"},
    )
    with opener.open(req, timeout=30) as resp:
        return resp.read()


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


def prompt_for(mode: str) -> str:
    extra = ""
    if mode == "cairn":
        extra = "不要开 explorer，不要 blackboard。主会话自己执行。\n"
    if mode == "minimal":
        extra = "没有 skill 工具，直接 bash。\n"
    return (
        extra
        + "不要解释。立刻用 bash 只执行下面两条命令，把完整 stdout 原样贴回，然后停止：\n"
        + "echo SMOKE_MODE={}\n".format(mode)
        + "curl -sS -X POST http://127.0.0.1:8787/proxy-pool/agent "
        + "-H 'Content-Type: application/json' -d '{\"op\":\"get\"}'\n"
        + "curl -sS -X POST http://127.0.0.1:8787/proxy-pool/agent "
        + "-H 'Content-Type: application/json' -d '{\"op\":\"next\",\"reason\":\"timeout\"}'\n"
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

    url = token_url()
    opener = opener_from(url)
    listed = rpc(opener, "session/list", {"_request": {}})
    print("dsh_ok sessions={}".format(len(listed.get("items") or [])))

    stamp = time.strftime("%H%M%S")
    rows = []
    for mode in MODES:
        session_id = "smoke-{}-{}".format(mode, stamp)
        created = rpc(
            opener,
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
            opener,
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
            opener,
            "session/prompt",
            {
                "request": {
                    "requestId": str(uuid.uuid4()),
                    "sessionId": session_id,
                    "mode": "queue",
                    "content": [{"type": "text", "text": prompt_for(mode)}],
                }
            },
        )
        deadline = time.time() + WAIT_S
        running = True
        while time.time() < deadline:
            items = rpc(opener, "session/list", {"_request": {}}).get("items") or []
            row = find_session(items, session_id) or {}
            running = bool(row.get("running"))
            if not running and not row.get("blank", True):
                break
            time.sleep(3)
        blob = b""
        text = ""
        try:
            blob = export_session(opener, session_id)
            text = zip_text(blob)
            Path("/tmp/dsh-mode-smoke-{}.txt".format(mode)).write_text(text[:20000], encoding="utf-8")
        except Exception as exc:
            text = "export_failed {}".format(exc)
        found = evidence(text, mode)
        lease = httpx.get(f"{WORKBENCH}/proxy-pool/agent", timeout=5).json()
        row = {
            "mode": mode,
            "session_id": session_id,
            "preset": created.get("agentPreset"),
            "running_at_end": running,
            "export_bytes": len(blob),
            **found,
            "lease_id": lease.get("lease_id"),
            "proxy_id": lease.get("proxy_id"),
        }
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False))

    out = Path("/tmp/dsh-mode-smoke.json")
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    failed = [r["mode"] for r in rows if not r["got_url"] or not r["smoke_marker"]]
    if failed:
        raise SystemExit("failed modes: {}".format(",".join(failed)))
    print("all_modes_ok")


if __name__ == "__main__":
    main()
