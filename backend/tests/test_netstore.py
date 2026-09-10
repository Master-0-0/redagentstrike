from workbench.control import new_id, utcnow
from workbench.netstore import HttpEvent, NetStore


def _event(run_id: str, host: str, status: int, ts: str, failed: bool = False) -> HttpEvent:
    return HttpEvent(
        id=new_id("http"),
        run_id=run_id,
        ts=ts,
        host=host,
        method="GET",
        url="https://{}/".format(host),
        status=None if failed else status,
        summary="GET {} → {}".format(host, "failed" if failed else status),
        req_headers={},
        req_body="",
        resp_headers={},
        resp_body="",
        evidence_id=None,
        failed=failed,
    )


def test_query_filters_and_counts(tmp_path):
    store = NetStore(tmp_path / "net.duckdb")
    run_id = "run-1"
    store.insert(_event(run_id, "example.com", 200, "2026-09-08T01:00:00.000Z"))
    store.insert(_event(run_id, "api.internal", 404, "2026-09-08T01:01:00.000Z"))
    store.insert(_event(run_id, "example.com", 500, "2026-09-08T01:02:00.000Z"))
    store.insert(_event(run_id, "down.example", 0, "2026-09-08T01:03:00.000Z", failed=True))
    rows = store.query(run_id, host="example.com")
    assert [row.host for row in rows] == ["example.com", "example.com"]
    window = store.query(
        run_id,
        from_ts="2026-09-08T01:01:00.000Z",
        to_ts="2026-09-08T01:02:00.000Z",
    )
    assert [row.status for row in window] == [404, 500]
    counts = store.counts(run_id)
    assert counts["total"] == 4
    assert counts["status_2xx"] == 1
    assert counts["status_4xx"] == 1
    assert counts["status_5xx"] == 1
    assert counts["failed"] == 1
    store.close()
