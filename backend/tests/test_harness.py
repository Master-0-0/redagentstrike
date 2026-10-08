from dataclasses import replace
from unittest.mock import Mock

import pytest

from workbench.harness import HarnessManager, _dsh_cmd, parse_ready_url


@pytest.mark.parametrize("managed,stop_on_exit", [(True, True), (True, False), (False, True)])
def test_close_stops_managed_harness_only_when_requested(settings, monkeypatch, managed, stop_on_exit):
    manager = HarnessManager(replace(settings, manage_dsh=managed))
    manager._injected = True
    stop = Mock()
    apply = Mock()
    monkeypatch.setattr(manager, "_stop_listener", stop)
    monkeypatch.setattr(manager, "apply", apply)
    monkeypatch.setenv("WORKBENCH_STOP_DSH_ON_EXIT", "1" if stop_on_exit else "0")

    manager.close()

    if managed and stop_on_exit:
        stop.assert_called_once_with()
        apply.assert_not_called()
    else:
        stop.assert_not_called()
        apply.assert_called_once_with(False)
    assert manager._injected is False


@pytest.mark.parametrize("new_line,running,port_open,expected", [
    (False, True, True, None),
    (True, False, True, None),
    (True, True, False, None),
    (True, True, True, "http://127.0.0.1:3081/?token=new"),
])
def test_wait_ready_requires_current_launch_url_and_live_process(settings, tmp_path, monkeypatch, new_line, running, port_open, expected):
    manager = HarnessManager(settings)
    log = tmp_path / "dsh.log"
    log.write_text("dsh web: http://127.0.0.1:3081/?token=old\n")
    manager._log_start = log.stat().st_size
    if new_line:
        with log.open("a") as handle:
            handle.write("dsh web: http://127.0.0.1:3081/?token=new\n")
    manager.proc = Mock()
    manager.proc.poll.return_value = None if running else 1
    monkeypatch.setattr("workbench.harness._port_open", lambda *_: port_open)
    monkeypatch.setattr("workbench.harness.time.sleep", lambda _: None)
    ticks = iter([0, 0, 2])
    monkeypatch.setattr("workbench.harness.time.time", lambda: next(ticks))
    assert manager._wait_ready(log, timeout=1) == expected


def test_parse_ready_url_strips_lan_suffix():
    text = "dsh web: http://127.0.0.1:3081/?token=abc_DEF-123 (LAN: http://192.168.1.5:3081/?token=abc_DEF-123)\n"
    assert parse_ready_url(text) == "http://127.0.0.1:3081/?token=abc_DEF-123"


def test_parse_ready_url_uses_latest_printed_line():
    text = (
        "dsh web: http://127.0.0.1:3081/?token=oldToken_123\n"
        "dsh web: http://127.0.0.1:3081/?token=newToken_456\n"
    )
    assert parse_ready_url(text) == "http://127.0.0.1:3081/?token=newToken_456"


def test_harness_apply_is_noop_when_unmanaged(settings):
    manager = HarnessManager(settings)
    manager.apply(True)
    blob = manager.status()
    assert blob["managed"] is False
    assert blob["proxied"] is False
    assert blob["error"] is None


def test_dsh_cmd_adds_approval_patch_before_no_open(settings, tmp_path, monkeypatch):
    bin_ts = tmp_path / "apps" / "cli" / "src" / "bin.ts"
    bin_ts.parent.mkdir(parents=True)
    bin_ts.touch()
    configured = replace(settings, dsh_root=tmp_path)
    monkeypatch.setattr(
        "workbench.harness.shutil.which",
        lambda name: "/usr/bin/node" if name == "node" else None,
    )

    cmd = _dsh_cmd(configured)

    patch_index = cmd.index("--patch")
    assert cmd[patch_index + 1] == str(configured.dsh_approval_patch)
    assert patch_index < cmd.index("--no-open")


def test_restart_injects_hook_environment(settings, tmp_path, monkeypatch):
    configured = replace(settings, dsh_root=tmp_path)
    manager = HarnessManager(configured)
    captured = {}

    class FakeProcess:
        pid = 123

        def __init__(self, _cmd, **kwargs):
            captured.update(kwargs["env"])

        def poll(self):
            return None

    monkeypatch.setattr(manager, "_stop_listener", lambda: None)
    monkeypatch.setattr(manager, "_wait_ready", lambda _path, timeout: "http://ready")
    monkeypatch.setattr("workbench.harness._dsh_cmd", lambda _settings: ["dsh"])
    monkeypatch.setattr("workbench.harness.subprocess.Popen", FakeProcess)

    manager._restart(False)
    manager._close_log()

    assert captured["WORKBENCH_DSH_HOOK_CONFIG"] == str(configured.dsh_hook_config)
    assert captured["WORKBENCH_DSH_HOOK_ROOT"] == str(configured.dsh_hook_root)
    assert captured["WORKBENCH_HOOK_URL"] == configured.hook_api_url
