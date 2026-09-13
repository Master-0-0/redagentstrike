"""Capture-gated observation of PoC HTTP requests, without changing their route."""
import threading
import time

from .control import new_id, utcnow
from .netstore import HttpEvent
from .redact import decode_body, host_from_url, plain_headers, summarize


class PocRecorder:
    def __init__(self, state):
        self.state = state
        self.lock = threading.RLock()
        self.epoch = 0
        self.paused = False

    def invalidate(self):
        with self.lock:
            self.epoch += 1

    def begin(self):
        with self.lock:
            if self.paused or not self.state.mitm.listening:
                return None
            run_id = self.state.control.current_run_id()
            return (self.epoch, run_id) if run_id else None

    def finish(self, ticket, request, response, error, started_at, elapsed, metadata, proxy_id):
        if ticket is None:
            return None
        with self.lock:
            if (ticket[0] != self.epoch or self.paused or not self.state.mitm.listening
                    or self.state.control.current_run_id() != ticket[1]):
                return None
            # Proxy credentials are transport-only and must not enter the timeline/replay cache.
            headers = {key: value for key, value in request.headers.items()
                       if key.lower() not in {'proxy-authorization', 'x-workbench-egress', 'x-workbench-egress-id'}}
            url = str(request.url)
            status = response.status_code if response is not None else None
            event = HttpEvent(
                id=new_id('http'), run_id=ticket[1], ts=started_at,
                host=host_from_url(url), method=request.method, url=url, status=status,
                summary=summarize(request.method, url, status, bool(error)),
                req_headers=plain_headers(headers), req_body=decode_body(request.content),
                resp_headers=plain_headers(dict(response.headers)) if response is not None else {},
                resp_body=decode_body(response.content) if response is not None else '',
                evidence_id=None, failed=bool(error) or status is None, egress_proxy_id=proxy_id,
                metadata={**metadata, 'source': 'poc', 'duration_ms': elapsed, 'error': error},
            )
            self.state.store_http_event(event)
            return event.id


class ScanRecording:
    def __init__(self, recorder):
        self.recorder = recorder
        self.scan_id = new_id('poc')
        self.warnings = []
        self.lock = threading.Lock()

    def warn(self):
        with self.lock:
            message = '部分 PoC 请求未能写入网络时间线，请检查网络仓库状态。'
            if message not in self.warnings:
                self.warnings.append(message)

    def template(self, template_id):
        return TemplateRecording(self, template_id)


class TemplateRecording:
    def __init__(self, scan, template_id):
        self.scan = scan
        self.template_id = template_id
        self.sequence = 0

    def hooks(self, proxy_id, proxy_address):
        return RequestRecording(self, proxy_id, proxy_address)


class RequestRecording:
    def __init__(self, template, proxy_id, proxy_address):
        self.template = template
        self.proxy_id = proxy_id
        self.proxy_address = proxy_address
        self.pending = None
        self.events = []

    def on_request(self, request):
        self.template.sequence += 1
        # Materialize the request body, including streams constructed by HTTPX redirects.
        request.read()
        try:
            ticket = self.template.scan.recorder.begin()
        except Exception:
            self.template.scan.warn()
            ticket = None
        self.pending = (ticket, request, utcnow(), time.perf_counter(), self.template.sequence)

    def on_response(self, response):
        # HTTPX calls this before consuming the body. Read once, leaving bytes cached for matchers.
        response.read()
        self.finish(response, 'http_407' if response.status_code == 407 else None)

    def finish(self, response=None, error=None):
        pending, self.pending = self.pending, None
        if pending is None:
            return
        ticket, request, timestamp, start, sequence = pending
        event_id = None
        try:
            event_id = self.template.scan.recorder.finish(
                ticket, request, response, error, timestamp, round((time.perf_counter() - start) * 1000),
                {'scan_id': self.template.scan.scan_id, 'template_id': self.template.template_id,
                 'attempt_index': sequence, 'proxy_address': self.proxy_address}, self.proxy_id,
            )
        except Exception:
            self.template.scan.warn()
        self.events.append({'network_event_id': event_id, 'url': str(request.url),
                            'method': request.method, 'attempt_index': sequence})
