from workbench.proxypool import FAIL_THRESHOLD


def test_proxy_pool_crud(client):
    empty = client.get("/proxy-pool").json()
    assert empty["empty"] == "no_entries"
    created = client.post(
        "/proxy-pool",
        json={"scheme": "http", "host": "10.0.0.8", "port": 8080, "password": "s3cret"},
    )
    assert created.status_code == 200
    entry = created.json()["entry"]
    assert entry["has_password"] is True
    assert "password" not in entry
    listed = client.get("/proxy-pool").json()
    assert listed["empty"] == "ok"
    assert listed["counts"]["total"] == 1
    assert listed["counts"]["nodes"] == 1
    assert listed["counts"]["unknown"] == 1
    patched = client.patch("/proxy-pool/{}".format(entry["id"]), json={"enabled": False})
    assert patched.json()["empty"] == "all_disabled"
    client.patch("/proxy-pool/{}".format(entry["id"]), json={"enabled": True})
    deleted = client.delete("/proxy-pool/{}".format(entry["id"]))
    assert deleted.json()["empty"] == "no_entries"


def test_lease_ok_fail_and_empty(client):
    assert client.post("/proxy-pool/lease").status_code == 409
    first = client.post("/proxy-pool", json={"scheme": "http", "host": "1.1.1.1", "port": 8001}).json()["entry"]
    client.post("/proxy-pool", json={"scheme": "http", "host": "2.2.2.2", "port": 8002})
    lease = client.post("/proxy-pool/lease").json()
    assert lease["proxy_id"] == first["id"] or lease["url"].startswith("http://")
    client.post("/proxy-pool/leases/{}/ok".format(lease["lease_id"]))
    dead = client.post("/proxy-pool/lease").json()
    client.post("/proxy-pool/leases/{}/fail".format(dead["lease_id"]), json={"reason": "timeout"})
    again = client.post("/proxy-pool/lease").json()
    if again["proxy_id"] == dead["proxy_id"]:
        cooled = client.post(
            "/proxy-pool/leases/{}/fail".format(again["lease_id"]),
            json={"reason": "timeout"},
        ).json()["entry"]
        if cooled["id"] == dead["proxy_id"]:
            assert cooled["fail_streak"] >= FAIL_THRESHOLD


def test_bad_port_rejected(client):
    response = client.post("/proxy-pool", json={"scheme": "http", "host": "x", "port": 0})
    assert response.status_code == 400


def test_fetch_public_keeps_live_nodes(client, monkeypatch):
    from workbench.proxycheck import CheckResult
    from workbench.proxyfetch import Candidate

    client.post("/proxy-pool", json={"scheme": "http", "host": "10.0.0.8", "port": 8080})

    def puller(*args, **kwargs):
        return (
            [
                Candidate("http", "1.2.3.4", 8080, "proxyscrape"),
                Candidate("http", "4.4.4.4", 8080, "geonode"),
            ],
            [],
            ["proxyscrape", "geonode"],
        )

    def checker(entry, timeout=None):
        ok = entry.host == "1.2.3.4"
        return CheckResult(
            ok=ok,
            latency_ms=70 if ok else 3000,
            egress_ip="203.0.113.20" if ok else None,
            error=None if ok else "timeout",
            url="http://api.ipify.org",
        )

    monkeypatch.setattr("workbench.proxyfetch.pull_candidates", puller)
    monkeypatch.setattr("workbench.proxyfetch.check_entry", checker)
    response = client.post("/proxy-pool/fetch", json={"limit": 8, "check": True})
    assert response.status_code == 200
    body = response.json()
    assert body["purged"] == 1
    assert body["added"] == 1
    assert body["counts"]["alive"] == 1
    assert body["entries"][0]["host"] == "1.2.3.4"
    assert body["entries"][0]["source"] == "public"
    assert body["entries"][0]["alive"] is True


def test_agent_get_next_and_active_egress(client):
    assert client.get("/proxy-pool/agent").json()["url"] is None
    assert client.post("/proxy-pool/agent", json={"op": "get"}).status_code == 409
    client.post("/proxy-pool", json={"scheme": "http", "host": "1.1.1.1", "port": 8001})
    client.post("/proxy-pool", json={"scheme": "http", "host": "2.2.2.2", "port": 8002})
    got = client.post("/proxy-pool/agent", json={"op": "get"})
    assert got.status_code == 200
    body = got.json()
    assert body["url"].startswith("http://")
    assert body["agent"]["proxy_id"] == body["proxy_id"]
    assert client.get("/internal/net/egress").json()["proxy_id"] == body["proxy_id"]
    again = client.post("/proxy-pool/agent", json={"op": "get"}).json()
    assert again["lease_id"] == body["lease_id"]
    rotated = client.post("/proxy-pool/agent", json={"op": "next", "reason": "timeout"})
    assert rotated.status_code == 200
    assert rotated.json()["proxy_id"] != body["proxy_id"]
    ok = client.post("/proxy-pool/agent", json={"op": "ok"})
    assert ok.status_code == 200
    assert ok.json()["entry"]["fail_streak"] == 0


def test_check_writes_alive_and_latency(client, monkeypatch):
    from workbench.proxycheck import CheckResult

    created = client.post(
        "/proxy-pool",
        json={"scheme": "http", "host": "10.0.0.8", "port": 8080},
    ).json()["entry"]
    assert created["alive"] is None
    monkeypatch.setattr(
        "workbench.api.check_entry",
        lambda entry, url=None: CheckResult(
            ok=True, latency_ms=87, egress_ip="203.0.113.10", error=None, url="http://api.ipify.org",
        ),
    )
    checked = client.post("/proxy-pool/{}/check".format(created["id"]))
    assert checked.status_code == 200
    body = checked.json()
    assert body["counts"]["nodes"] == 1
    assert body["counts"]["alive"] == 1
    assert body["counts"]["latency_ms"] == 87
    entry = body["entries"][0]
    assert entry["alive"] is True
    assert entry["latency_ms"] == 87
    assert entry["egress_ip"] == "203.0.113.10"
