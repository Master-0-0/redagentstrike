from dataclasses import replace

from workbench.harness import HarnessManager, _dsh_cmd, parse_ready_url


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
