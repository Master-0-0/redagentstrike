from workbench.control import RunEvent
from workbench.join import align_tool_call
from workbench.netstore import HttpEvent


def _http(ts: str, host: str) -> HttpEvent:
    return HttpEvent(
        id="http-1",
        run_id="run-1",
        ts=ts,
        host=host,
        method="GET",
        url="https://{}/login".format(host),
        status=200,
        summary="GET {} → 200".format(host),
        req_headers={},
        req_body="",
        resp_headers={},
        resp_body="",
        evidence_id=None,
        failed=False,
    )


def test_aligns_nearest_host_overlap():
    event = _http("2026-09-08T10:00:04.000Z", "target.example")
    calls = [
        RunEvent("e1", "run-1", "2026-09-08T10:00:01.000Z", "tool_call", "http_probe", {"url": "https://target.example/login"}),
        RunEvent("e2", "run-1", "2026-09-08T10:00:03.000Z", "tool_call", "other", {"url": "https://unrelated.test/"}),
    ]
    matched = align_tool_call(event, calls, window_s=8)
    assert matched is not None
    assert matched["id"] == "e1"
    assert matched["name"] == "http_probe"


def test_outside_window_is_none():
    event = _http("2026-09-08T10:01:00.000Z", "target.example")
    calls = [
        RunEvent("e1", "run-1", "2026-09-08T10:00:00.000Z", "tool_call", "http_probe", {"url": "https://target.example/"}),
    ]
    assert align_tool_call(event, calls, window_s=8) is None
