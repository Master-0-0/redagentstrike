from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest

from workbench.mitm import MitmManager
from workbench.poc import scan_templates
from workbench.poc_recording import ScanRecording


@pytest.fixture
def captured(client, monkeypatch):
    switch = {'on': True}
    monkeypatch.setattr(MitmManager, 'listening', property(lambda self: switch['on']))
    monkeypatch.setattr(MitmManager, 'start', lambda self: switch.update(on=True))
    monkeypatch.setattr(MitmManager, 'stop', lambda self: switch.update(on=False))
    state = client.app.state.wb
    state.control.ensure_open_run()
    monkeypatch.setattr('workbench.poc.capture_response_image', lambda *args: (None, None))
    return client, state, switch


def run_scan(state, mode='direct', template='nacos/nacos-unauth-users.yaml'):
    return scan_templates(state.settings.poc_templates_dir, 'http://example.test', [template],
                          pool=state.pool, proxy_mode=mode, recording=ScanRecording(state.poc_recorder))


def install_transport(monkeypatch, handler):
    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request', lambda self, req: handler(req))


def good(req):
    return httpx.Response(200, headers={'X-Fixture': 'yes'}, content=b'{"pageItems":[{"username":"fixture"}]}')


def test_direct_capture_details_replay_and_link(captured, monkeypatch):
    client, state, _ = captured
    install_transport(monkeypatch, good)
    report = run_scan(state)
    route = report['results'][0]['attempts'][0]['transport_attempts'][0]
    event = client.get('/network/events/' + route['network_event_id']).json()
    assert event['source'] == 'poc' and event['scan_id'] == report['scan_id']
    assert event['attempt_index'] == 1 and event['duration_ms'] >= 0
    assert event['join']['status'] == 200
    assert event['truncated']['resp_headers']['x-fixture'] == 'yes'
    assert 'fixture' in event['truncated']['resp_body']
    assert event['truncated']['req_headers']['host'] == 'example.test'
    assert client.get('/network/drafts/' + event['id']).json()['draft']['url'] == event['join']['url']
    assert client.get('/network').json()['counts']['total'] == 1


@pytest.mark.parametrize('action', ['off', 'clear', 'off_on', 'session', 'initial_off'])
def test_capture_lifecycle_discards_late_requests(captured, monkeypatch, action):
    client, state, switch = captured
    if action == 'initial_off':
        switch['on'] = False
    def handler(req):
        if action in {'off', 'off_on'}:
            client.post('/capture', json={'enabled': False})
            if action == 'off_on':
                client.post('/capture', json={'enabled': True})
        elif action == 'clear':
            client.post('/network/clear')
        elif action == 'session':
            state.control.end_run(state.control.current_run_id())
            state.control.ensure_open_run()
        return good(req)
    install_transport(monkeypatch, handler)
    report = run_scan(state)
    assert report['matched'] == 1
    assert report['results'][0]['attempts'][0]['transport_attempts'][0]['network_event_id'] is None
    assert client.get('/network').json()['counts']['total'] == 0


def test_storage_failure_is_warning_not_retry(captured, monkeypatch):
    _, state, _ = captured
    requests = []
    def handler(req):
        requests.append(req)
        return good(req)
    install_transport(monkeypatch, handler)
    def fail(event):
        raise RuntimeError('store failure')
    monkeypatch.setattr(state.net, 'insert', fail)
    report = run_scan(state)
    assert report['matched'] == 1 and report['recording_warnings']
    assert len(requests) == 1


@pytest.mark.parametrize('failure', [httpx.ReadTimeout, httpx.ConnectError])
def test_network_failure_is_recorded(captured, monkeypatch, failure):
    client, state, _ = captured
    def handler(req):
        raise failure('fixture failure', request=req)
    install_transport(monkeypatch, handler)
    report = run_scan(state)
    event_id = report['results'][0]['attempts'][0]['transport_attempts'][0]['network_event_id']
    event = client.get('/network/events/' + event_id).json()
    assert event['error'] == failure.__name__ and event['failed']
    assert event['join']['status'] is None


def test_redirects_and_concurrent_scans_are_distinct(captured, monkeypatch, tmp_path):
    client, state, _ = captured
    template = tmp_path / 'redirect.yaml'
    template.write_text('''id: redirect
info: {name: redirect}
http:
  - method: GET
    path: ['{{BaseURL}}/redirect']
    redirects: true
    matchers:
      - type: status
        status: [200]
''')
    def handler(req):
        return httpx.Response(302, headers={'Location': '/final'}, content=b'moved') if req.url.path == '/redirect' else good(req)
    install_transport(monkeypatch, handler)
    def scan():
        return scan_templates(tmp_path, 'http://example.test', ['redirect.yaml'],
                              recording=ScanRecording(state.poc_recorder))
    with ThreadPoolExecutor(max_workers=2) as executor:
        reports = list(executor.map(lambda _: scan(), range(2)))
    assert all(report['matched'] == 1 for report in reports)
    events = client.get('/network').json()['events']
    assert len(events) == 4
    for report in reports:
        rows = [event for event in events if event['scan_id'] == report['scan_id']]
        assert [row['join']['status'] for row in rows] == [302, 200]
        assert [row['attempt_index'] for row in rows] == [1, 2]
        route = report['results'][0]['attempts'][0]['transport_attempts'][0]
        assert len(route['network_requests']) == 2


def test_empty_pool_produces_no_network_record(captured):
    client, state, _ = captured
    report = run_scan(state, 'pool')
    assert report['results'][0]['attempts'][0]['error'] == 'pool_empty'
    assert client.get('/network').json()['counts']['total'] == 0


def test_post_body_and_proxy_credential_exclusion(captured, monkeypatch):
    client, state, _ = captured
    def handler(req):
        assert req.content == b'username=nacos&password=nacos'
        # Credential-only transport header must not be persisted or replayed.
        req.headers['Proxy-Authorization'] = 'Basic fixture-secret'
        return httpx.Response(200, content=b'{"accessToken":"fixture"}')
    install_transport(monkeypatch, handler)
    report = run_scan(state, template='nacos/nacos-default-login.yaml')
    route = report['results'][0]['attempts'][0]['transport_attempts'][0]
    event = client.get('/network/events/' + route['network_event_id']).json()
    assert event['truncated']['req_body'] == 'username=nacos&password=nacos'
    assert 'proxy-authorization' not in event['truncated']['req_headers']
    draft = client.get('/network/drafts/' + event['id']).json()['draft']
    assert draft['body'] == 'username=nacos&password=nacos'
    assert 'proxy-authorization' not in draft['headers']


def test_metadata_migration_preserves_legacy_rows(tmp_path):
    import duckdb
    from workbench.netstore import NetStore
    path = tmp_path / 'legacy.duckdb'
    conn = duckdb.connect(str(path))
    conn.execute('''CREATE TABLE net_http (
        id VARCHAR, run_id VARCHAR, ts TIMESTAMP, host VARCHAR, method VARCHAR, url VARCHAR,
        status INTEGER, summary VARCHAR, req_headers VARCHAR, req_body VARCHAR,
        resp_headers VARCHAR, resp_body VARCHAR, evidence_id VARCHAR, failed BOOLEAN,
        egress_proxy_id VARCHAR)''')
    conn.execute("INSERT INTO net_http VALUES ('old','run','2026-09-14','example.test','GET','http://example.test',200,'ok','{}','','{}','original',NULL,false,NULL)")
    conn.close()
    store = NetStore(path)
    try:
        assert store.available
        event = store.get('old')
        assert event.metadata == {}
        assert event.resp_body == 'original'
        assert store.query('run')[0].id == 'old'
    finally:
        store.close()
