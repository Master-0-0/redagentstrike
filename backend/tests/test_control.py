from workbench.control import ControlPlane


def test_create_and_current_run(tmp_path):
    plane = ControlPlane(tmp_path / "control.sqlite")
    assert plane.current_run() is None
    run = plane.create_run("alpha")
    assert plane.current_run_id() == run.id
    assert run.open
    ended = plane.end_run(run.id)
    assert not ended.open
    assert plane.current_run() is None
    plane.close()


def test_rejects_concurrent_open_run(tmp_path):
    plane = ControlPlane(tmp_path / "control.sqlite")
    plane.create_run("one")
    try:
        plane.create_run("two")
        assert False, "expected concurrent_run"
    except RuntimeError as exc:
        assert str(exc) == "concurrent_run"
    plane.close()


def test_ensure_open_run_reuses_current(tmp_path):
    plane = ControlPlane(tmp_path / "control.sqlite")
    first = plane.ensure_open_run()
    second = plane.ensure_open_run()
    assert first.id == second.id
    plane.close()


def test_tool_call_event(tmp_path):
    plane = ControlPlane(tmp_path / "control.sqlite")
    run = plane.create_run()
    event = plane.add_event(run.id, name="http_probe", payload={"url": "https://example.com/"})
    events = plane.list_events(run.id)
    assert len(events) == 1
    assert events[0].kind == "tool_call"
    assert events[0].name == "http_probe"
    assert event.payload["url"] == "https://example.com/"
    plane.close()
