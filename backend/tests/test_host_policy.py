import pytest

from workbench.host_policy import blocked_reason, load_policy, parse_rules, save_policy


def test_normalize_and_deduplicate():
    assert parse_rules(' .GOV.CN, .edu.cn\n.gov.cn；API.Example.COM.，127.0.0.1 ') == ['.gov.cn', '.edu.cn', 'api.example.com', '127.0.0.1']
    assert parse_rules('例子.中国') == ['xn--fsqu00a.xn--fiqs8s']


@pytest.mark.parametrize('value', ['https://example.com', 'example.com/path', 'example.com:443', '*.gov.cn', '..gov.cn', '.', '.127.0.0.1', '-bad.test'])
def test_reject_invalid_rules(value):
    with pytest.raises(ValueError):
        parse_rules(value)


@pytest.mark.parametrize('host,blocked', [
    ('gov.cn', False), ('a.gov.cn', False), ('A.B.GOV.CN.', False),
    ('a.edu.cn', False), ('evilgov.cn', False), ('gov.cn.evil.test', False),
    ('denied.gov.cn', True), ('api.example.com', False), ('sub.api.example.com', False),
])
def test_domain_boundaries_and_blacklist_priority(host, blocked):
    rules = {'whitelist': ['.gov.cn', '.edu.cn', 'api.example.com'], 'blacklist': ['denied.gov.cn']}
    assert bool(blocked_reason(host, rules)) is blocked


def test_empty_lists_allow_and_empty_whitelist_only_blocks_matches():
    assert blocked_reason('example.com', {'whitelist': [], 'blacklist': []}) == ''
    assert blocked_reason('example.com', {'whitelist': [], 'blacklist': ['.gov.cn']}) == ''
    assert blocked_reason('a.gov.cn', {'whitelist': [], 'blacklist': ['.gov.cn']})


def test_persistence_and_invalid_update_preserves_previous_rules(tmp_path):
    path = tmp_path / 'host-policy.json'
    assert load_policy(path) == {'whitelist': [], 'blacklist': []}
    expected = save_policy(path, '.gov.cn, .edu.cn', 'bad.gov.cn')
    assert load_policy(path) == expected
    with pytest.raises(ValueError):
        save_policy(path, 'https://invalid.example', '')
    assert load_policy(path) == expected


def test_api_save_read_validate_and_clear(client):
    assert client.get('/capture/hosts').json() == {'whitelist': [], 'blacklist': []}
    result = client.put('/capture/hosts', json={'whitelist': '.gov.cn, .edu.cn', 'blacklist': 'bad.gov.cn'})
    assert result.status_code == 200
    assert client.get('/capture/hosts').json() == result.json()
    assert client.put('/capture/hosts', json={'blacklist': 'https://invalid.test'}).status_code == 422
    assert client.get('/capture/hosts').json() == result.json()
    assert client.put('/capture/hosts', json={'whitelist': '', 'blacklist': ''}).json() == {'whitelist': [], 'blacklist': []}
