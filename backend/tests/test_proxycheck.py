from workbench.proxycheck import CheckResult, check_entry
from workbench.proxypool import ProxyPool


def test_record_check_shows_up_in_resource_counts(tmp_path):
    pool = ProxyPool(tmp_path / "control.sqlite")
    live = pool.add("http", "1.1.1.1", 8001)
    dead = pool.add("http", "2.2.2.2", 8002)
    pool.add("http", "3.3.3.3", 8003)
    pool.record_check(live.id, ok=True, latency_ms=120, egress_ip="203.0.113.8")
    pool.record_check(dead.id, ok=False, latency_ms=8000, error="timeout")
    snap = pool.snapshot()
    assert snap["counts"]["nodes"] == 3
    assert snap["counts"]["alive"] == 1
    assert snap["counts"]["dead"] == 1
    assert snap["counts"]["unknown"] == 1
    assert snap["counts"]["latency_ms"] == 120
    listed = {item["host"]: item for item in snap["entries"]}
    assert listed["1.1.1.1"]["alive"] is True
    assert listed["1.1.1.1"]["egress_ip"] == "203.0.113.8"
    assert listed["2.2.2.2"]["alive"] is False
    assert listed["3.3.3.3"]["alive"] is None
    pool.close()


def test_check_entry_http_success(monkeypatch, tmp_path):
    pool = ProxyPool(tmp_path / "control.sqlite")
    entry = pool.add("http", "10.0.0.8", 8080)

    class FakeResponse:
        status_code = 200
        text = "198.51.100.4"

    class FakeClient:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def get(self, url):
            assert url.startswith("http://")
            return FakeResponse()

    monkeypatch.setattr("workbench.proxycheck.httpx.Client", FakeClient)
    result = check_entry(entry)
    assert result.ok is True
    assert result.egress_ip == "198.51.100.4"
    assert result.latency_ms is not None
    pool.close()


def test_check_entry_timeout(monkeypatch, tmp_path):
    import httpx

    pool = ProxyPool(tmp_path / "control.sqlite")
    entry = pool.add("https", "10.0.0.8", 8080)

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def get(self, url):
            raise httpx.TimeoutException("slow")

    monkeypatch.setattr("workbench.proxycheck.httpx.Client", FakeClient)
    result = check_entry(entry)
    assert result == CheckResult(
        ok=False,
        latency_ms=result.latency_ms,
        egress_ip=None,
        error="timeout",
        url=result.url,
    )
    pool.close()
