from dataclasses import replace
from unittest.mock import Mock, PropertyMock

import pytest

from workbench.mitm import MitmManager


@pytest.mark.parametrize("managed,listening,error", [
    (False, True, "dsh_unmanaged"),
    (True, False, "capture_not_running"),
])
def test_attach_harness_requires_managed_workbench_and_capture(client, monkeypatch, managed, listening, error):
    st = client.app.state.wb
    st.settings = replace(st.settings, manage_dsh=managed)
    monkeypatch.setattr(MitmManager, "listening", PropertyMock(return_value=listening))
    apply = Mock()
    monkeypatch.setattr(st.harness, "apply", apply)
    assert client.post("/capture/harness").json()["error"] == error
    apply.assert_not_called()


@pytest.mark.parametrize("failure,proxied,error", [
    (None, True, None),
    (None, False, "dsh_proxy_not_ready"),
    ("dsh_start_timeout", False, "dsh_start_timeout"),
])
def test_attach_harness_preserves_capture_and_reports_actual_status(client, monkeypatch, failure, proxied, error):
    st = client.app.state.wb
    st.settings = replace(st.settings, manage_dsh=True)
    monkeypatch.setattr(MitmManager, "listening", PropertyMock(return_value=True))
    apply = Mock(side_effect=RuntimeError(failure) if failure else None)
    monkeypatch.setattr(st.harness, "apply", apply)
    monkeypatch.setattr(st.harness, "status", lambda: {"managed": True, "proxied": proxied, "url": "http://ready"})
    start, stop = Mock(), Mock()
    monkeypatch.setattr(st.mitm, "start", start)
    monkeypatch.setattr(st.mitm, "stop", stop)
    st.holds.set_enabled(True)
    run_id = client.post("/runs", json={"start_capture": False}).json()["run"]["id"]
    result = client.post("/capture/harness").json()
    apply.assert_called_once_with(True)
    assert result["error"] == error
    assert result["capture"]["harness"]["proxied"] is proxied
    assert result["capture"]["intercept"] is True
    assert client.get("/runs/current").json()["run"]["id"] == run_id
    start.assert_not_called()
    stop.assert_not_called()


@pytest.mark.parametrize("proxy_failure,harness_failure", [(False, False), (True, False), (False, True)])
def test_run_capture_attaches_harness_and_stop_detaches(client, monkeypatch, proxy_failure, harness_failure):
    st = client.app.state.wb
    monkeypatch.setattr(st.mitm, "start", Mock(side_effect=RuntimeError("proxy_failed") if proxy_failure else None))
    apply = Mock(side_effect=RuntimeError("dsh_start_timeout") if harness_failure else None)
    monkeypatch.setattr(st.harness, "apply", apply)
    result = client.post("/runs", json={"start_capture": True}).json()
    if proxy_failure:
        assert result["capture_error"] == "proxy_failed"
        apply.assert_not_called()
    else:
        apply.assert_called_once_with(True)
        assert result["capture_error"] == ("dsh_start_timeout" if harness_failure else None)
    apply.reset_mock(side_effect=True)
    client.post("/runs/{}/stop".format(result["run"]["id"]))
    apply.assert_called_once_with(False)


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
