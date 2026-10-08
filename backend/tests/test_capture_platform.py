from unittest.mock import Mock

import pytest

from workbench.mitm import MitmManager


@pytest.mark.parametrize('platform,supported', [('darwin', True), ('linux', True), ('win32', False)])
def test_capture_platform_and_health(settings, client, monkeypatch, platform, supported):
    monkeypatch.setattr('workbench.config.sys.platform', platform)
    assert settings.capture_supported is supported
    assert client.get('/health').json()['capture_supported'] is supported
    assert client.get('/capture').json()['supported'] is supported


def test_unsupported_capture_does_not_spawn(settings, monkeypatch):
    monkeypatch.setattr('workbench.config.sys.platform', 'win32')
    spawn = Mock()
    monkeypatch.setattr('workbench.mitm.subprocess.Popen', spawn)
    manager = MitmManager(settings, 'http://127.0.0.1:8787/internal/net/http')
    with pytest.raises(RuntimeError, match='capture_platform_unsupported'):
        manager.start()
    assert manager.status()['error'] == 'capture_platform_unsupported'
    spawn.assert_not_called()
