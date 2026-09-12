from workbench.harness import HarnessManager, parse_ready_url


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
