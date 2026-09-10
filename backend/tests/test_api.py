def test_idle_empty_without_run_events(client):
    created = client.post("/runs", json={"title": "idle", "start_capture": False})
    assert created.status_code == 200
    run_id = created.json()["run"]["id"]
    body = client.get("/runs/{}/network".format(run_id)).json()
    assert body["empty"] in {"idle", "proxy_off"}
    assert body["events"] == []
    assert body["capture"]["scope"] == "http_only"
    assert body["capture"]["mode"] == "proxy_inject"


def test_ingest_dropped_without_current_run(client):
    client.post("/runs", json={"start_capture": False})
    run_id = client.get("/runs/current").json()["run"]["id"]
    client.post("/runs/{}/stop".format(run_id))
    dropped = client.post(
        "/internal/net/http",
        json={"method": "GET", "url": "https://evil.example/", "status": 200},
    ).json()
    assert dropped["accepted"] is False
    assert dropped["reason"] == "no_current_run"


def test_ingest_and_network_timeline(client):
    created = client.post("/runs", json={"title": "http-run", "start_capture": False})
    run_id = created.json()["run"]["id"]
    client.post(
        "/runs/{}/events".format(run_id),
        json={
            "kind": "tool_call",
            "name": "http_probe",
            "ts": "2026-09-08T12:00:00.000Z",
            "payload": {"url": "https://example.com/login"},
        },
    )
    ingested = client.post(
        "/internal/net/http",
        json={
            "method": "GET",
            "url": "https://example.com/login?token=sekrit",
            "status": 200,
            "ts": "2026-09-08T12:00:01.000Z",
            "req_headers": {"Authorization": "Bearer abc", "Accept": "application/json"},
            "req_body": "unused",
            "resp_headers": {"Set-Cookie": "sid=1", "Content-Type": "text/html"},
            "resp_body": "<html>ok</html>",
        },
    ).json()
    assert ingested["accepted"] is True
    body = client.get("/runs/{}/network".format(run_id)).json()
    assert body["empty"] is None
    assert body["counts"]["total"] == 1
    assert body["counts"]["status_2xx"] == 1
    event = body["events"][0]
    assert event["host"] == "example.com"
    assert event["join"]["method"] == "GET"
    assert event["join"]["status"] == 200
    assert "sekrit" in event["join"]["url"]
    assert event["truncated"]["req_headers"]["Authorization"] == "Bearer abc"
    assert event["truncated"]["resp_headers"]["Set-Cookie"] == "sid=1"
    assert event["tool_call"]["name"] == "http_probe"
    detail = client.get("/network/events/{}".format(event["id"])).json()
    assert detail["truncated"]["req_headers"]["Authorization"] == "Bearer abc"
    assert detail["truncated"]["resp_headers"]["Set-Cookie"] == "sid=1"
    assert detail["truncated"]["req_body"] == "unused"
    assert detail["truncated"]["resp_body"] == "<html>ok</html>"
    filtered = client.get("/runs/{}/network".format(run_id), params={"host": "nope"}).json()
    assert filtered["events"] == []


def test_host_and_status_filters(client):
    run_id = client.post("/runs", json={"start_capture": False}).json()["run"]["id"]
    client.post("/internal/net/http", json={"method": "GET", "url": "https://a.test/", "status": 201})
    client.post("/internal/net/http", json={"method": "POST", "url": "https://b.test/x", "status": 500})
    client.post("/internal/net/http", json={"method": "GET", "url": "https://b.test/y", "failed": True})
    body = client.get("/runs/{}/network".format(run_id), params={"host": "b.test"}).json()
    assert len(body["events"]) == 2
    counts = client.get("/runs/{}/network".format(run_id)).json()["counts"]
    assert counts["status_2xx"] == 1
    assert counts["status_5xx"] == 1
    assert counts["failed"] == 1


def test_detail_keeps_long_headers_and_bodies(client):
    client.post("/runs", json={"start_capture": False})
    long_header = "v" * 4000
    long_body = "body-" + ("x" * 20_000)
    ingested = client.post(
        "/internal/net/http",
        json={
            "method": "POST",
            "url": "https://api.example/data",
            "status": 200,
            "req_headers": {"X-Trace": long_header, "Authorization": "Bearer secret"},
            "req_body": long_body,
            "resp_headers": {"Content-Type": "application/json", "X-Long": long_header},
            "resp_body": long_body,
        },
    ).json()
    listed = client.get("/network").json()["events"][0]
    assert listed["truncated"]["req_body"] == ""
    assert listed["truncated"]["resp_body"] == ""
    assert listed["truncated"]["req_headers"]["Authorization"] == "Bearer secret"
    detail = client.get("/network/events/{}".format(ingested["id"])).json()
    assert detail["truncated"]["req_headers"]["Authorization"] == "Bearer secret"
    assert detail["truncated"]["req_headers"]["X-Trace"] == long_header
    assert detail["truncated"]["resp_headers"]["X-Long"] == long_header
    assert detail["truncated"]["req_body"] == long_body
    assert detail["truncated"]["resp_body"] == long_body
    assert "truncated" not in detail["truncated"]["req_body"]
