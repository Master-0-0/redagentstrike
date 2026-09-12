from workbench.egress import AttemptResult, rotate_http
from workbench.proxypool import ProxyPool


def test_empty_pool_sends_direct_once(tmp_path):
    pool = ProxyPool(tmp_path / "control.sqlite")
    calls = []

    def send(lease):
        calls.append(lease)
        return AttemptResult(status=200)

    result = rotate_http(pool, send)
    assert result.status == 200
    assert result.egress_proxy_id is None
    assert result.rotated is False
    assert len(calls) == 1
    assert calls[0] is None
    pool.close()


def test_timeout_rotates_to_next_proxy(tmp_path):
    pool = ProxyPool(tmp_path / "control.sqlite")
    first = pool.add("http", "1.1.1.1", 8001)
    second = pool.add("http", "2.2.2.2", 8002)
    seen = []

    def send(lease):
        seen.append(lease.proxy_id if lease else None)
        if lease and lease.proxy_id == first.id:
            return AttemptResult(error="timeout")
        return AttemptResult(status=200)

    result = rotate_http(pool, send)
    assert result.status == 200
    assert result.rotated is True
    assert result.egress_proxy_id == second.id
    assert first.id in seen and second.id in seen
    assert pool.list_entries()[0].id in {first.id, second.id}
    cooled = [item for item in pool.list_entries() if item.id == first.id][0]
    assert cooled.fail_streak == 1
    pool.close()


def test_exhausted_rotations_do_not_fall_back_to_direct(tmp_path):
    pool = ProxyPool(tmp_path / "control.sqlite")
    pool.add("http", "1.1.1.1", 8001)
    pool.add("http", "2.2.2.2", 8002)

    def send(lease):
        assert lease is not None
        return AttemptResult(error="connect")

    result = rotate_http(pool, send)
    assert result.error == "connect"
    assert result.status is None
    assert result.rotated is True
    assert all(item.proxy_id for item in result.attempts)
    pool.close()


def test_407_rotates_403_does_not(tmp_path):
    pool = ProxyPool(tmp_path / "control.sqlite")
    entry = pool.add("http", "3.3.3.3", 8003)
    calls = []

    def send_407(lease):
        calls.append("407")
        return AttemptResult(status=407, error="http_407")

    failed = rotate_http(pool, send_407)
    assert failed.error == "http_407"

    def send_403(lease):
        return AttemptResult(status=403)

    ok = rotate_http(pool, send_403)
    assert ok.status == 403
    assert ok.error is None
    assert ok.egress_proxy_id == entry.id
    pool.close()
