"""Whitelist requests bypass both manual interception and capture."""
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from workbench.host_policy import save_policy


@pytest.mark.parametrize('whitelist,blacklist,host,blocked,held,recorded', [
    ('api.deepseek.com', '', 'api.deepseek.com', False, False, False),
    ('.deepseek.com', '', 'API.DEEPSEEK.COM.', False, False, False),
    ('.deepseek.com', '', 'deepseek.com', False, False, False),
    ('api.deepseek.com', 'api.deepseek.com', 'api.deepseek.com', True, False, True),
    ('.deepseek.com', '', 'evildeepseek.com', False, True, True),
    ('.deepseek.com', '', 'deepseek.com.evil.test', False, True, True),
    ('api.deepseek.com', '', 'sub.api.deepseek.com', False, True, True),
    ('', '', 'api.deepseek.com', False, True, True),
])
@pytest.mark.parametrize('phase', ['response', 'error'])
def test_whitelist_excluded_from_hold_and_capture(tmp_path, monkeypatch, whitelist, blacklist, host, blocked, held, recorded, phase):
    path = tmp_path / 'policy.json'
    save_policy(path, whitelist, blacklist)
    monkeypatch.setenv('WORKBENCH_HOST_POLICY', str(path))
    spec = importlib.util.spec_from_file_location('capture_addon_test', Path(__file__).parents[1] / 'addons/http_capture.py')
    addon = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(addon)
    monkeypatch.setitem(sys.modules, 'mitmproxy', SimpleNamespace(http=SimpleNamespace(Response=SimpleNamespace(make=lambda *args: SimpleNamespace(status_code=args[0])))))
    monkeypatch.setattr(addon, '_apply_egress', Mock())
    monkeypatch.setattr(addon, '_json_get', Mock(return_value={'intercept': True}))
    hold = Mock(return_value=None)
    monkeypatch.setattr(addon, '_json_post', hold)
    ingest = Mock()
    monkeypatch.setattr(addon, '_ingest', ingest)
    flow = SimpleNamespace(metadata={}, response=None, request=SimpleNamespace(
        host=host, port=443, method='POST', pretty_url='https://' + host + '/chat/completions', headers={}, content=b'{}'))
    capture = addon.HttpCapture()
    capture.request(flow)
    assert (flow.response is not None) is blocked
    assert hold.called is held
    getattr(capture, phase)(flow)
    if recorded:
        ingest.assert_called_once_with(flow, failed=phase == 'error')
    else:
        ingest.assert_not_called()
