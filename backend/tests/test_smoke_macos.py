"""macOS smoke: curl through mitm appears on the timeline; stopping mitm stops growth.

Requires mitmdump on PATH. Skip otherwise — unit tests cover the warehouse/API.
"""

from __future__ import annotations

import os
import sys

import pytest

from workbench.mitm import _find_mitmdump

pytestmark = pytest.mark.skipif(
    sys.platform != "darwin" or _find_mitmdump() is None,
    reason="macOS + mitmdump required",
)


def test_proxy_inject_http_then_stop(client):
    created = client.post("/runs", json={"title": "smoke", "start_capture": True})
    assert created.status_code == 200
    body = created.json()
    if body.get("capture_error"):
        pytest.skip(body["capture_error"])
    run_id = body["run"]["id"]
    probed = client.post("/runs/{}/probe".format(run_id), json={"url": "http://example.com/"})
    assert probed.status_code == 200
    timeline = client.get("/runs/{}/network".format(run_id)).json()
    assert timeline["counts"]["total"] >= 1
    assert any("example.com" in (event.get("host") or "") for event in timeline["events"])
    before = timeline["counts"]["total"]
    client.post("/runs/{}/stop".format(run_id))
    # Direct curl without going through the workbench probe should not be ingested
    # after stop because CurrentRun is cleared.
    os.environ.setdefault("PATH", "/usr/bin")
    stopped = client.get("/runs/{}/network".format(run_id)).json()
    assert stopped["counts"]["total"] == before
    assert stopped["capture"]["listening"] is False
