from workbench.proxypool import FAIL_THRESHOLD, PoolEmpty, ProxyPool


def test_add_list_and_empty_states(tmp_path):
    pool = ProxyPool(tmp_path / "control.sqlite")
    assert pool.snapshot()["empty"] == "no_entries"
    entry = pool.add("http", "10.0.0.1", 8080, username="u", password="p")
    assert entry.as_api()["has_password"] is True
    assert "password" not in entry.as_api()
    assert entry.url().startswith("http://u:")
    snap = pool.snapshot()
    assert snap["empty"] == "ok"
    assert snap["counts"]["total"] == 1
    pool.patch(entry.id, enabled=False)
    assert pool.snapshot()["empty"] == "all_disabled"
    pool.close()


def test_lease_round_robin_and_exclude(tmp_path):
    pool = ProxyPool(tmp_path / "control.sqlite")
    first = pool.add("http", "1.1.1.1", 8001)
    second = pool.add("http", "2.2.2.2", 8002)
    a = pool.lease()
    b = pool.lease()
    c = pool.lease()
    assert {a.proxy_id, b.proxy_id} == {first.id, second.id}
    assert a.proxy_id != b.proxy_id
    assert c.proxy_id == a.proxy_id
    only = pool.lease(exclude_ids=[first.id])
    assert only.proxy_id == second.id
    try:
        pool.lease(exclude_ids=[first.id, second.id])
        assert False, "expected pool_empty"
    except PoolEmpty:
        pass
    pool.close()


def test_fail_cools_after_threshold(tmp_path):
    pool = ProxyPool(tmp_path / "control.sqlite")
    entry = pool.add("http", "9.9.9.9", 9000)
    first = pool.lease()
    updated = pool.fail(first.lease_id, reason="timeout")
    assert updated.fail_streak == 1
    assert not updated.cooling
    second = pool.lease()
    cooled = pool.fail(second.lease_id, reason="timeout")
    assert cooled.fail_streak == FAIL_THRESHOLD
    assert cooled.cooling
    try:
        pool.lease()
        assert False, "expected pool_empty while cooling"
    except PoolEmpty:
        pass
    assert pool.snapshot()["empty"] == "all_cooling"
    pool.close()


def test_ok_resets_streak(tmp_path):
    pool = ProxyPool(tmp_path / "control.sqlite")
    entry = pool.add("socks5", "8.8.8.8", 1080)
    lease = pool.lease()
    pool.fail(lease.lease_id, reason="connect")
    again = pool.lease()
    reset = pool.ok(again.lease_id)
    assert reset.fail_streak == 0
    assert not reset.cooling
    pool.close()


def test_add_same_endpoint_is_idempotent(tmp_path):
    pool = ProxyPool(tmp_path / "control.sqlite")
    first = pool.add("http", "198.51.100.8", 8080, source="manual")
    again = pool.add("http", "198.51.100.8", 8080, source="public")
    assert again.id == first.id
    assert len(pool.list_entries()) == 1
    pool.close()


def test_delete_and_patch(tmp_path):
    pool = ProxyPool(tmp_path / "control.sqlite")
    entry = pool.add("https", "proxy.local", 443, note="lab")
    pool.patch(entry.id, note="updated", username="n")
    listed = pool.list_entries()[0]
    assert listed.note == "updated"
    assert listed.username == "n"
    pool.delete(entry.id)
    assert pool.list_entries() == []
    pool.close()
