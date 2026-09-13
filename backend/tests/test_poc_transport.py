import httpx
import pytest
from workbench.poc_transport import send_request, PocTransportError
from workbench.proxypool import ProxyPool


@pytest.fixture
def pool(tmp_path):
    pool = ProxyPool(tmp_path / 'pool.sqlite')
    yield pool
    pool.close()


def test_pool_empty_never_sends_direct(pool):
    with httpx.Client() as client, pytest.raises(PocTransportError) as caught:
        send_request(client, pool, 'pool', 1, 'GET', 'http://invalid.test')
    assert caught.value.error == 'pool_empty'
    assert caught.value.attempts == [{'proxy_id': None, 'lease_id': None, 'status': None, 'error': 'pool_empty', 'via': 'pool'}]


def test_timeout_then_connect_error_rotates_and_records_success(pool, monkeypatch):
    first = pool.add(scheme='http', host='127.0.0.1', port=10001)
    second = pool.add(scheme='http', host='127.0.0.1', port=10002)
    calls = []
    def request(self, method, url, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ReadTimeout('timeout')
        if len(calls) == 2:
            raise httpx.ConnectError('unreachable')
        return httpx.Response(200, request=httpx.Request(method, url))
    monkeypatch.setattr(httpx.Client, 'request', request)
    with httpx.Client() as client:
        response, attempts = send_request(client, pool, 'fallback', 1, 'GET', 'http://target.test')
    assert response.status_code == 200
    assert [step['proxy_id'] for step in attempts] == [None, first.id, second.id]
    assert [step['proxy_host'] for step in attempts] == [None, '127.0.0.1', '127.0.0.1']
    assert all(step['egress_ip'] is None for step in attempts)
    assert pool.get(first.id).fail_streak == 1
    assert pool.get(second.id).last_ok_at


def test_proxy_retries_bounded_to_three_nodes(pool, monkeypatch):
    for port in range(10001, 10005):
        pool.add(scheme='http', host='127.0.0.1', port=port)
    def fail(*args, **kwargs):
        raise httpx.ConnectError('unreachable')
    monkeypatch.setattr(httpx.Client, 'request', fail)
    with httpx.Client() as client, pytest.raises(PocTransportError) as caught:
        send_request(client, pool, 'pool', 1, 'GET', 'http://target.test')
    attempts = caught.value.attempts
    assert len(attempts) == 3
    assert len({step['proxy_id'] for step in attempts}) == 3
