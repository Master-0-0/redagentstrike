from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import httpx

from .config import Settings, load_settings
from .control import ControlPlane, new_id, utcnow
from .egress import EGRESS_ID_HEADER, EGRESS_URL_HEADER, AttemptResult, rotate_http
from .intercept import HoldBoard, ReplayCache
from .harness import HarnessManager
from .join import align_tool_call
from .mitm import MitmManager
from .netstore import HttpEvent, NetStore
from .proxycheck import check_entry
from .proxyfetch import ingest_public
from .proxypool import Lease, LeaseError, PoolEmpty, ProxyEntry, ProxyPool
from .poc import TemplateError, list_templates, read_template, scan_templates
from .redact import decode_body, host_from_url, plain_headers, summarize


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
    egress_proxy_id: Optional[str] = None


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


class ProxyCreate(BaseModel):
    scheme: str = "http"
    host: str
    port: int
    username: str = ""
    password: str = ""
    note: str = ""
    source: str = "manual"


class ProxyPatch(BaseModel):
    enabled: Optional[bool] = None
    note: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None


class LeaseFailBody(BaseModel):
    reason: str = ""


class ProxyCheckBody(BaseModel):
    url: Optional[str] = None


class ProxyFetchBody(BaseModel):
    limit: int = 8
    check: bool = True


class ProxyAgentBody(BaseModel):
    op: str = "get"
    reason: str = "timeout"


class PocScanBody(BaseModel):
    target: str
    templates: List[str] = Field(default_factory=list)
    timeout: float = Field(default=10.0, ge=1, le=30, allow_inf_nan=False)
    concurrency: int = Field(default=4, ge=1, le=10)


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
        self.pool = ProxyPool(settings.control_db)
        self.agent_lease: Optional[Lease] = None
        _install_agent_skill()

    def pool_view(self) -> Dict[str, Any]:
        return {**self.pool.snapshot(), "agent": self.agent_as_api()}

    def agent_as_api(self) -> Dict[str, Any]:
        if self.agent_lease is None:
            return {"lease_id": None, "proxy_id": None, "url": None}
        return self.agent_lease.as_api()

    def agent_get(self) -> Lease:
        if self.agent_lease is not None:
            return self.agent_lease
        lease = self.pool.lease()
        self.agent_lease = lease
        return lease

    def agent_next(self, reason: str = "timeout") -> Lease:
        current = self.agent_lease
        self.agent_lease = None
        exclude: List[str] = []
        if current is not None:
            exclude.append(current.proxy_id)
            try:
                self.pool.fail(current.lease_id, reason=reason or "timeout")
            except LeaseError:
                pass
        try:
            lease = self.pool.lease(exclude_ids=exclude)
        except PoolEmpty:
            lease = self.pool.lease()
        self.agent_lease = lease
        return lease

    def agent_ok(self) -> Optional[ProxyEntry]:
        if self.agent_lease is None:
            return None
        entry = self.pool.ok(self.agent_lease.lease_id)
        return entry

    def close(self) -> None:
        self.holds.release_all("drop")
        self.mitm.close()
        self.harness.close()
        self.pool.close()
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
            egress_proxy_id=body.egress_proxy_id,
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

    @app.get("/internal/net/egress")
    def active_egress() -> Dict[str, Any]:
        return state().agent_as_api()

    @app.get("/proxy-pool")
    def list_proxy_pool() -> Dict[str, Any]:
        return state().pool_view()

    @app.post("/proxy-pool")
    def add_proxy(body: ProxyCreate) -> Dict[str, Any]:
        try:
            entry = state().pool.add(
                scheme=body.scheme,
                host=body.host,
                port=body.port,
                username=body.username,
                password=body.password,
                note=body.note,
                source=body.source or "manual",
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"entry": entry.as_api(), **state().pool_view()}

    @app.post("/proxy-pool/fetch")
    def fetch_public_proxies(body: Optional[ProxyFetchBody] = None) -> Dict[str, Any]:
        st = state()
        report = ingest_public(
            st.pool,
            limit=body.limit if body else 8,
            validate=body.check if body else True,
        )
        return {**report.as_api(), **st.pool_view()}

    @app.get("/proxy-pool/agent")
    def get_agent_egress() -> Dict[str, Any]:
        return state().agent_as_api()

    @app.post("/proxy-pool/agent")
    def agent_egress(body: Optional[ProxyAgentBody] = None) -> Dict[str, Any]:
        st = state()
        op = (body.op if body else "get").strip().lower()
        if op == "get":
            try:
                lease = st.agent_get()
            except PoolEmpty as exc:
                raise HTTPException(status_code=409, detail="pool_empty") from exc
            return {**lease.as_api(), **st.pool_view()}
        if op == "next":
            try:
                lease = st.agent_next(reason=body.reason if body else "timeout")
            except PoolEmpty as exc:
                st.agent_lease = None
                raise HTTPException(status_code=409, detail="pool_empty") from exc
            return {**lease.as_api(), **st.pool_view()}
        if op == "ok":
            entry = st.agent_ok()
            if entry is None:
                raise HTTPException(status_code=409, detail="no_agent_lease")
            return {"entry": entry.as_api(), **st.pool_view()}
        raise HTTPException(status_code=400, detail="op_invalid")

    @app.patch("/proxy-pool/{entry_id}")
    def patch_proxy(entry_id: str, body: ProxyPatch) -> Dict[str, Any]:
        try:
            entry = state().pool.patch(
                entry_id,
                enabled=body.enabled,
                note=body.note,
                username=body.username,
                password=body.password,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="proxy_not_found") from exc
        return {"entry": entry.as_api(), **state().pool_view()}

    @app.delete("/proxy-pool/{entry_id}")
    def delete_proxy(entry_id: str) -> Dict[str, Any]:
        try:
            state().pool.delete(entry_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="proxy_not_found") from exc
        return {"ok": True, **state().pool_view()}

    @app.post("/proxy-pool/check")
    def check_all_proxies(body: Optional[ProxyCheckBody] = None) -> Dict[str, Any]:
        st = state()
        results = []
        for entry in st.pool.list_entries():
            checked = _check_and_store(st, entry, body.url if body else None)
            results.append(checked)
        return {"results": results, **st.pool_view()}

    @app.post("/proxy-pool/{entry_id}/check")
    def check_one_proxy(entry_id: str, body: Optional[ProxyCheckBody] = None) -> Dict[str, Any]:
        st = state()
        entry = st.pool.get(entry_id)
        if entry is None:
            raise HTTPException(status_code=404, detail="proxy_not_found")
        checked = _check_and_store(st, entry, body.url if body else None)
        return {"result": checked, **st.pool_view()}

    @app.post("/proxy-pool/lease")
    def lease_proxy() -> Dict[str, Any]:
        try:
            lease = state().pool.lease()
        except PoolEmpty as exc:
            raise HTTPException(status_code=409, detail="pool_empty") from exc
        return lease.as_api()

    @app.post("/proxy-pool/leases/{lease_id}/ok")
    def lease_ok(lease_id: str) -> Dict[str, Any]:
        try:
            entry = state().pool.ok(lease_id)
        except LeaseError as exc:
            raise HTTPException(status_code=404, detail="lease_not_found") from exc
        return {"entry": entry.as_api()}

    @app.post("/proxy-pool/leases/{lease_id}/fail")
    def lease_fail(lease_id: str, body: Optional[LeaseFailBody] = None) -> Dict[str, Any]:
        try:
            entry = state().pool.fail(lease_id, reason=body.reason if body else "")
        except LeaseError as exc:
            raise HTTPException(status_code=404, detail="lease_not_found") from exc
        return {"entry": entry.as_api()}

    @app.post("/runs/{run_id}/probe")
    def probe(run_id: str, body: ProbeBody) -> Dict[str, Any]:
        st = state()
        run = st.control.get_run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run_not_found")
        if not st.mitm.listening:
            raise HTTPException(status_code=409, detail="proxy_off")
        result = rotate_http(st.pool, lambda lease: _send_probe(st, body.url, lease))
        if result.error and result.status is None:
            raise HTTPException(
                status_code=502,
                detail=result.error,
            )
        return {
            "url": body.url,
            "http_code": "" if result.status is None else str(result.status),
            "egress_proxy_id": result.egress_proxy_id,
            "rotated": result.rotated,
            "attempts": [
                {
                    "lease_id": item.lease_id,
                    "proxy_id": item.proxy_id,
                    "status": item.status,
                    "error": item.error,
                }
                for item in result.attempts
            ],
            "error": result.error,
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

    @app.get("/poc/templates")
    def poc_templates() -> Dict[str, Any]:
        templates = list_templates(state().settings.poc_templates_dir)
        categories = sorted({item["category"] for item in templates})
        return {"categories": categories, "templates": templates}

    @app.get("/poc/templates/{template_id:path}")
    def poc_template(template_id: str) -> Dict[str, Any]:
        try:
            return read_template(state().settings.poc_templates_dir, template_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="template_not_found") from exc
        except TemplateError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/poc/scan")
    def poc_scan(body: PocScanBody) -> Dict[str, Any]:
        try:
            return scan_templates(
                state().settings.poc_templates_dir,
                body.target,
                body.templates,
                timeout=body.timeout,
                concurrency=body.concurrency,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="template_not_found") from exc
        except TemplateError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

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


def _check_and_store(st: AppState, entry: ProxyEntry, url: Optional[str]) -> Dict[str, Any]:
    result = check_entry(entry, url)
    stored = st.pool.record_check(
        entry.id,
        ok=result.ok,
        latency_ms=result.latency_ms,
        egress_ip=result.egress_ip,
        error=result.error,
    )
    payload = stored.as_api()
    payload["check"] = {
        "ok": result.ok,
        "latency_ms": result.latency_ms,
        "egress_ip": result.egress_ip,
        "error": result.error,
        "url": result.url,
    }
    return payload


def _send_probe(st: AppState, url: str, lease: Optional[Lease]) -> AttemptResult:
    proxy = "http://{}:{}".format(st.settings.proxy_host, st.settings.proxy_port)
    ca = st.settings.combined_ca if st.settings.combined_ca.exists() else None
    verify: Any = str(ca) if ca is not None else False
    headers: Dict[str, str] = {}
    proxy_headers: Dict[str, str] = {}
    if lease is not None:
        headers[EGRESS_URL_HEADER] = lease.url
        headers[EGRESS_ID_HEADER] = lease.proxy_id
        proxy_headers[EGRESS_URL_HEADER] = lease.url
        proxy_headers[EGRESS_ID_HEADER] = lease.proxy_id
    try:
        transport = httpx.HTTPTransport(
            proxy=httpx.Proxy(proxy, headers=proxy_headers or None),
        )
        with httpx.Client(
            verify=verify,
            follow_redirects=True,
            timeout=20.0,
            transport=transport,
        ) as client:
            response = client.get(url, headers=headers)
    except httpx.TimeoutException:
        return AttemptResult(error="timeout")
    except (httpx.ConnectError, httpx.ProxyError, httpx.NetworkError):
        return AttemptResult(error="connect")
    except httpx.RequestError:
        return AttemptResult(error="connect")
    if response.status_code == 407:
        return AttemptResult(
            status=407,
            error="http_407",
            headers=plain_headers({k: v for k, v in response.headers.items()}),
            body=decode_body(response.content),
        )
    return AttemptResult(
        status=response.status_code,
        headers=plain_headers({k: v for k, v in response.headers.items()}),
        body=decode_body(response.content),
    )


def _install_agent_skill() -> None:
    src = Path(__file__).resolve().parents[3] / ".dsh" / "skills" / "proxy-pool" / "SKILL.md"
    if not src.is_file():
        return
    dest = Path.home() / ".dsh" / "skills" / "proxy-pool" / "SKILL.md"
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        text = src.read_text(encoding="utf-8")
        if dest.is_file() and dest.read_text(encoding="utf-8") == text:
            return
        dest.write_text(text, encoding="utf-8")
    except OSError:
        return



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
