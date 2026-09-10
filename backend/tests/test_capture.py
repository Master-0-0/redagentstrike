def test_capture_toggle_does_not_require_manual_run(client):
    empty = client.get("/network").json()
    assert empty["run_id"] is None
    assert empty["empty"] in {"idle", "proxy_off"}

    toggled = client.post("/capture", json={"enabled": True}).json()
    assert toggled["run"] is not None
    assert toggled["capture"]["harness"]["managed"] is False
    # mitmproxy may be missing; session still exists for the timeline.
    assert client.get("/network").json()["run_id"] == toggled["run"]["id"]

    client.post("/internal/net/http", json={"method": "GET", "url": "https://a.test/", "status": 204})
    body = client.get("/network").json()
    assert body["counts"]["total"] == 1

    client.post("/capture", json={"enabled": False})
    still = client.get("/network").json()
    assert still["counts"]["total"] == 1
    assert still["capture"]["listening"] is False


def test_clear_removes_all_captured_http(client):
    client.post("/capture", json={"enabled": True})
    client.post("/internal/net/http", json={"method": "GET", "url": "https://a.test/", "status": 204})
    client.post("/internal/net/http", json={"method": "POST", "url": "https://b.test/x", "status": 200})
    event_id = client.get("/network").json()["events"][0]["id"]
    assert client.get("/network").json()["counts"]["total"] == 2
    assert client.get("/network/drafts/{}".format(event_id)).json()["stale"] is False

    cleared = client.post("/network/clear").json()
    assert cleared["ok"] is True
    assert cleared["deleted"] == 2

    empty = client.get("/network").json()
    assert empty["events"] == []
    assert empty["counts"]["total"] == 0
    assert client.get("/network/drafts/{}".format(event_id)).json()["stale"] is True
    assert client.get("/network/events/{}".format(event_id)).status_code == 404


def test_replay_draft_keeps_original_authorization(client):
    client.post("/runs", json={"start_capture": False})
    ingested = client.post(
        "/internal/net/http",
        json={
            "method": "GET",
            "url": "https://a.test/x",
            "status": 200,
            "req_headers": {"Authorization": "Bearer secret"},
        },
    ).json()
    event_id = ingested["id"]
    public = client.get("/network").json()["events"][0]
    assert public["truncated"]["req_headers"]["Authorization"] == "Bearer secret"
    draft = client.get("/network/drafts/{}".format(event_id)).json()
    assert draft["stale"] is False
    assert draft["draft"]["headers"]["Authorization"] == "Bearer secret"
