from __future__ import annotations

import subprocess
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import httpx

from .config import Settings, load_settings
from .control import ControlPlane, new_id, utcnow
from .intercept import HoldBoard, ReplayCache
from .harness import HarnessManager
from .join import align_tool_call
from .mitm import MitmManager
from .netstore import HttpEvent, NetStore
from .redact import decode_body, host_from_url, plain_headers, summarize
from .spawn import proxy_env, which_curl


class CreateRunBody(BaseModel):
    title: Optional[str] = None
    start_capture: bool = True


class ToolCallBody(BaseModel):
    kind: str = "tool_call"
    name: str = ""
    ts: Optional[str] = None
    payload: Dict[str, Any] = Field(default_factory=dict)


class IngestBody(BaseModel):
    run_id: Optional[str] = None
    ts: Optional[str] = None
    method: str = ""
    url: str = ""
    host: Optional[str] = None
    status: Optional[int] = None
    failed: bool = False
    req_headers: Dict[str, Any] = Field(default_factory=dict)
    req_body: str = ""
    resp_headers: Dict[str, Any] = Field(default_factory=dict)
    resp_body: str = ""
    evidence_id: Optional[str] = None
    already_redacted: bool = False


class ProbeBody(BaseModel):
    url: str = "http://example.com/"


class CaptureToggle(BaseModel):
    enabled: bool


class InterceptToggle(BaseModel):
    enabled: bool


class RequestDraft(BaseModel):
    method: str = "GET"
    url: str = ""
    host: Optional[str] = None
    headers: Dict[str, Any] = Field(default_factory=dict)
    body: str = ""


class AppState:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.control = ControlPlane(settings.control_db)
        self.net = NetStore(settings.net_db)
        ingest = "http://{}:{}/internal/net/http".format(settings.api_host, settings.api_port)
        self.mitm = MitmManager(settings, ingest_url=ingest)
        self.holds = HoldBoard()
        self.replays = ReplayCache()
        self.harness = HarnessManager(settings)

    def close(self) -> None:
        self.holds.release_all("drop")
        self.mitm.close()
        self.harness.close()
        self.control.close()
        self.net.close()


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState(settings)
        app.state.wb = state
        try:
            yield
        finally:
            state.close()

    app = FastAPI(title="workbench", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def state() -> AppState:
        return app.state.wb

    def session_run():
        return state().control.current_run() or state().control.latest_run()

    def capture_blob() -> Dict[str, Any]:
        st = state()
        blob = {**st.settings.capture_meta, **st.mitm.status(), **st.holds.status()}
        blob["harness"] = st.harness.status()
        return blob

    def network_payload(
        run_id: Optional[str],
        from_ts: Optional[str],
        to_ts: Optional[str],
        host: Optional[str],
    ) -> Dict[str, Any]:
        st = state()
        run = st.control.get_run(run_id) if run_id else None
        capture = capture_blob()
        empty_counts = {
            "total": 0,
            "status_2xx": 0,
            "status_4xx": 0,
            "status_5xx": 0,
            "failed": 0,
        }
        if run is None:
            return {
                "run_id": None,
                "run": None,
                "capture": capture,
                "events": [],
                "counts": empty_counts,
                "empty": "proxy_off" if not st.mitm.listening else "idle",
            }
        if not st.net.available:
            st.net.reopen()
        if not st.net.available:
            return {
                "run_id": run.id,
                "run": run.as_dict(),
                "capture": capture,
                "events": [],
                "counts": empty_counts,
                "empty": "store_unavailable",
                "store_error": st.net.error,
            }
        events = st.net.query(run.id, from_ts=from_ts, to_ts=to_ts, host=host)
        tool_calls = [e for e in st.control.list_events(run.id) if e.kind == "tool_call"]
        payload_events: List[Dict[str, Any]] = []
        for event in events:
            item = event.as_api(include_bodies=False)
            item["tool_call"] = align_tool_call(event, tool_calls, st.settings.join_window_s)
            payload_events.append(item)
        counts = st.net.counts(run.id)
        empty = None
        if not payload_events:
            empty = "idle" if st.mitm.listening else "proxy_off"
        return {
            "run_id": run.id,
            "run": run.as_dict(),
            "capture": capture,
            "events": payload_events,
            "counts": counts,
            "empty": empty,
        }

    @app.get("/health")
    def health() -> Dict[str, Any]:
        st = state()
        if not st.net.available:
            st.net.reopen()
        current_run_id = None
        control_ok = True
        try:
            current_run_id = st.control.current_run_id()
        except Exception as exc:  # noqa: BLE001
            control_ok = False
            current_run_id = None
            control_error = str(exc)
        else:
            control_error = None
        return {
            "ok": control_ok and st.net.available,
            "platform": st.settings.platform,
            "capture_supported": st.settings.capture_supported,
            "store": st.net.available,
            "control_ok": control_ok,
            "control_error": control_error,
            "capture": st.mitm.status(),
            "intercept": st.holds.status(),
            "harness": st.harness.status(),
            "current_run_id": current_run_id,
        }

    @app.get("/runs")
    def list_runs() -> Dict[str, Any]:
        st = state()
        current = st.control.current_run_id()
        return {
            "current_run_id": current,
            "runs": [run.as_dict() for run in st.control.list_runs()],
        }

    @app.get("/runs/current")
    def current_run() -> Dict[str, Any]:
        run = state().control.current_run()
        if run is None:
            return {"run": None}
        return {"run": run.as_dict()}

    @app.post("/runs")
    def create_run(body: CreateRunBody) -> Dict[str, Any]:
        st = state()
        try:
            run = st.control.create_run(body.title)
        except RuntimeError as exc:
            if str(exc) == "concurrent_run":
                raise HTTPException(
                    status_code=409,
                    detail="已有进行中的 Run。MVP 并发为 1，请先结束当前 Run。",
                ) from exc
            raise
        capture_error = None
        if body.start_capture:
            try:
                st.mitm.start()
                st.control.mark_capture_started(run.id, True)
            except RuntimeError as exc:
                capture_error = str(exc)
                st.control.mark_capture_started(run.id, False)
        stored = st.control.get_run(run.id) or run
        return {
            "run": stored.as_dict(),
            "capture": st.mitm.status(),
            "capture_error": capture_error,
        }

    @app.post("/runs/{run_id}/stop")
    def stop_run(run_id: str) -> Dict[str, Any]:
        st = state()
        if st.control.get_run(run_id) is None:
            raise HTTPException(status_code=404, detail="run_not_found")
        st.mitm.stop()
        run = st.control.end_run(run_id)
        return {"run": run.as_dict(), "capture": st.mitm.status()}

    @app.post("/runs/{run_id}/events")
    def add_event(run_id: str, body: ToolCallBody) -> Dict[str, Any]:
        st = state()
        try:
            event = st.control.add_event(
                run_id,
                kind=body.kind,
                name=body.name,
                payload=body.payload,
                ts=body.ts,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run_not_found") from exc
        return {"event": event.as_dict()}

    @app.get("/runs/{run_id}/events")
    def list_events(run_id: str) -> Dict[str, Any]:
        st = state()
        if st.control.get_run(run_id) is None:
            raise HTTPException(status_code=404, detail="run_not_found")
        return {"events": [event.as_dict() for event in st.control.list_events(run_id)]}

    @app.get("/runs/{run_id}/network")
    def network(
        run_id: str,
        from_ts: Optional[str] = Query(default=None, alias="from"),
        to_ts: Optional[str] = Query(default=None, alias="to"),
        host: Optional[str] = None,
    ) -> Dict[str, Any]:
        st = state()
        run = st.control.get_run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run_not_found")
        return network_payload(run_id, from_ts, to_ts, host)

    @app.get("/network")
    def network_current(
        from_ts: Optional[str] = Query(default=None, alias="from"),
        to_ts: Optional[str] = Query(default=None, alias="to"),
        host: Optional[str] = None,
    ) -> Dict[str, Any]:
        run = session_run()
        return network_payload(run.id if run else None, from_ts, to_ts, host)

    @app.post("/internal/net/http")
    def ingest_http(body: IngestBody) -> Dict[str, Any]:
        st = state()
        run_id = body.run_id or st.control.current_run_id()
        if not run_id:
            return {"accepted": False, "reason": "no_current_run"}
        if st.control.get_run(run_id) is None:
            return {"accepted": False, "reason": "run_not_found"}
        if not st.net.available:
            st.net.reopen()
        if not st.net.available:
            return {"accepted": False, "reason": "store_unavailable"}
        host = (body.host or host_from_url(body.url) or "").lower()
        req_headers = plain_headers(body.req_headers)
        resp_headers = plain_headers(body.resp_headers)
        req_body = decode_body(body.req_body)
        resp_body = decode_body(body.resp_body)
        failed = bool(body.failed or body.status is None)
        event = HttpEvent(
            id=new_id("http"),
            run_id=run_id,
            ts=body.ts or utcnow(),
            host=host,
            method=(body.method or "").upper(),
            url=body.url or "",
            status=body.status,
            summary=summarize(body.method, body.url, body.status, failed),
            req_headers=req_headers,
            req_body=req_body,
            resp_headers=resp_headers,
            resp_body=resp_body,
            evidence_id=body.evidence_id,
            failed=failed,
        )
        st.net.insert(event)
        st.replays.put(
            event.id,
            {
                "method": event.method,
                "url": body.url,
                "host": host,
                "headers": {str(k): str(v) for k, v in (body.req_headers or {}).items()},
                "body": body.req_body or "",
            },
        )
        return {"accepted": True, "id": event.id}

    @app.post("/runs/{run_id}/probe")
    def probe(run_id: str, body: ProbeBody) -> Dict[str, Any]:
        st = state()
        run = st.control.get_run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run_not_found")
        if not st.mitm.listening:
            raise HTTPException(status_code=409, detail="proxy_off")
        curl = which_curl()
        if not curl:
            raise HTTPException(status_code=500, detail="curl_missing")
        env = proxy_env(st.settings)
        try:
            completed = subprocess.run(
                [
                    curl,
                    "-sS",
                    "-o",
                    "/dev/null",
                    "-w",
                    "%{http_code}",
                    "--max-time",
                    "20",
                    "-L",
                    body.url,
                ],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
        except OSError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        return {
            "url": body.url,
            "exit_code": completed.returncode,
            "http_code": completed.stdout.strip(),
            "stderr": (completed.stderr or "")[-500:],
        }

    @app.post("/capture")
    def set_capture(body: CaptureToggle) -> Dict[str, Any]:
        st = state()
        error = None
        if body.enabled:
            run = st.control.ensure_open_run()
            try:
                st.mitm.start()
                st.control.mark_capture_started(run.id, True)
            except RuntimeError as exc:
                error = str(exc)
                st.control.mark_capture_started(run.id, False)
            else:
                error = _apply_harness(st, True) or error
        else:
            st.holds.release_all("drop")
            st.holds.set_enabled(False)
            st.mitm.stop()
            error = _apply_harness(st, False)
        return {
            "capture": capture_blob(),
            "run": (session_run().as_dict() if session_run() else None),
            "error": error,
        }

    @app.post("/capture/intercept")
    def set_intercept(body: InterceptToggle) -> Dict[str, Any]:
        st = state()
        error = None
        if body.enabled:
            if not st.mitm.listening:
                run = st.control.ensure_open_run()
                try:
                    st.mitm.start()
                    st.control.mark_capture_started(run.id, True)
                except RuntimeError as exc:
                    error = str(exc)
                    return {"capture": capture_blob(), "error": error}
            error = _apply_harness(st, True)
        st.holds.set_enabled(body.enabled)
        return {"capture": capture_blob(), "error": error}

    @app.get("/capture/pending")
    def pending_holds() -> Dict[str, Any]:
        return state().holds.status()

    @app.post("/capture/pending/{hold_id}/forward")
    def forward_hold(hold_id: str, body: RequestDraft) -> Dict[str, Any]:
        try:
            decision = state().holds.forward(hold_id, body.model_dump())
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="hold_not_found") from exc
        return {"decision": decision}

    @app.post("/capture/pending/{hold_id}/drop")
    def drop_hold(hold_id: str) -> Dict[str, Any]:
        try:
            decision = state().holds.drop(hold_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="hold_not_found") from exc
        return {"decision": decision}

    @app.post("/internal/net/hold")
    def hold_http(body: RequestDraft) -> Dict[str, Any]:
        return state().holds.hold(body.model_dump())

    @app.post("/network/clear")
    def clear_network() -> Dict[str, Any]:
        st = state()
        if not st.net.available:
            st.net.reopen()
        try:
            deleted = st.net.clear()
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        st.replays.clear()
        return {"ok": True, "deleted": deleted}

    @app.get("/network/events/{event_id}")
    def get_network_event(event_id: str) -> Dict[str, Any]:
        st = state()
        if not st.net.available:
            st.net.reopen()
        try:
            event = st.net.get(event_id)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        if event is None:
            raise HTTPException(status_code=404, detail="event_not_found")
        item = event.as_api(include_bodies=True)
        run = st.control.get_run(event.run_id)
        if run is not None:
            tool_calls = [e for e in st.control.list_events(run.id) if e.kind == "tool_call"]
            item["tool_call"] = align_tool_call(event, tool_calls, st.settings.join_window_s)
        else:
            item["tool_call"] = None
        return item

    @app.get("/network/drafts/{event_id}")
    def replay_draft(event_id: str) -> Dict[str, Any]:
        draft = state().replays.get(event_id)
        if draft is None:
            return {"draft": None, "stale": True}
        return {"draft": draft, "stale": False}

    @app.post("/capture/replay")
    def replay(body: RequestDraft) -> Dict[str, Any]:
        st = state()
        if not body.url:
            raise HTTPException(status_code=400, detail="url_required")
        skip = {
            "host",
            "content-length",
            "transfer-encoding",
            "connection",
            "proxy-connection",
            "keep-alive",
        }
        headers = {
            str(k): str(v)
            for k, v in body.headers.items()
            if str(k).lower() not in skip
        }
        proxy = None
        verify: Any = True
        if st.mitm.listening:
            proxy = "http://{}:{}".format(st.settings.proxy_host, st.settings.proxy_port)
            ca = st.settings.combined_ca if st.settings.combined_ca.exists() else None
            verify = str(ca) if ca is not None else False
        try:
            with httpx.Client(
                proxy=proxy,
                verify=verify,
                follow_redirects=False,
                timeout=30.0,
            ) as client:
                response = client.request(
                    body.method or "GET",
                    body.url,
                    headers=headers,
                    content=body.body.encode("utf-8") if body.body else None,
                )
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        resp_headers = {k: v for k, v in response.headers.items()}
        return {
            "status": response.status_code,
            "headers": plain_headers(resp_headers),
            "body": decode_body(response.content),
            "via_proxy": bool(proxy),
        }

    @app.get("/capture")
    def capture() -> Dict[str, Any]:
        return capture_blob()

    return app


def _apply_harness(st: AppState, proxied: bool) -> Optional[str]:
    try:
        st.harness.apply(proxied)
    except RuntimeError as exc:
        return str(exc)
    return None


def main() -> None:
    import uvicorn

    settings = load_settings()
    uvicorn.run(
        "workbench.api:create_app",
        factory=True,
        host=settings.api_host,
        port=settings.api_port,
        log_level="info",
        reload=False,
    )
