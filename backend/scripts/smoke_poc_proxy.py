"""Real HTTP forwarding smoke: leased proxy 407 -> next leased proxy -> Nacos.

Run from backend: PYTHONPATH=src .venv/bin/python scripts/smoke_poc_proxy.py
Uses an isolated pool/database and two temporary loopback proxies.
"""
import json
import socket
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.parse import urlsplit

import httpx
from fastapi.testclient import TestClient
from workbench.api import create_app
from workbench.config import Settings


@contextmanager
def proxy_server(reject=False):
    seen = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.path)
            if reject:
                self.send_response(407)
                self.end_headers()
                return
            parsed = urlsplit(self.path)
            if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.port != 8848:
                self.send_error(403)
                return
            with httpx.Client(trust_env=False, timeout=10) as client:
                response = client.get(self.path, headers={'Accept': 'application/json'})
            self.send_response(response.status_code)
            self.send_header('Content-Type', response.headers.get('content-type', 'application/json'))
            self.send_header('Content-Length', str(len(response.content)))
            self.end_headers()
            self.wfile.write(response.content)

        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port, seen
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def main():
    with socket.socket() as port_probe:
        port_probe.bind(('127.0.0.1', 0))
        capture_port = port_probe.getsockname()[1]
    with TemporaryDirectory(prefix='poc-proxy-smoke-') as data, proxy_server(True) as bad, proxy_server() as good:
        with TestClient(create_app(Settings(data_dir=Path(data), proxy_port=capture_port))) as client:
            capture = client.post('/capture', json={'enabled': True}).json()
            assert capture['capture']['listening'], capture
            pool = client.app.state.wb.pool
            first = pool.add(scheme='http', host='127.0.0.1', port=bad[0], source='smoke')
            second = pool.add(scheme='http', host='127.0.0.1', port=good[0], source='smoke')
            response = client.post('/poc/scan', json={
                'target': 'http://127.0.0.1:8848', 'templates': ['nacos/nacos-unauth-users.yaml'],
                'proxy_mode': 'pool', 'concurrency': 1, 'timeout': 10,
            })
            assert response.status_code == 200, response.text
            result = response.json()['results'][0]
            route = result['attempts'][0]['transport_attempts']
            assert result['matched'], result['attempts']
            assert [step['proxy_id'] for step in route] == [first.id, second.id], route
            assert route[0]['error'] == 'http_407' and route[1]['status'] == 200
            assert all(step['lease_id'] for step in route)
            assert len(bad[1]) == len(good[1]) == 1
            assert pool.get(first.id).fail_streak == 1
            assert pool.get(second.id).last_ok_at
            assert result['body'].startswith('HTTP/') and result['image']
            events = client.get('/network').json()['events']
            assert len(events) == 2, events
            assert [event['join']['status'] for event in events] == [407, 200]
            assert [event['egress_proxy_id'] for event in events] == [first.id, second.id]
            assert [event['id'] for event in events] == [step['network_event_id'] for step in route]
            assert all(event['source'] == 'poc' for event in events)
            detail = client.get('/network/events/' + events[1]['id']).json()
            assert 'pageItems' in detail['truncated']['resp_body']
            direct = client.post('/poc/scan', json={
                'target': 'http://127.0.0.1:8848', 'templates': ['nacos/nacos-unauth-users.yaml'],
                'proxy_mode': 'direct',
            }).json()
            assert direct['matched'] == 1
            assert client.get('/network').json()['counts']['total'] == 3
            client.post('/capture', json={'enabled': False})
            uncaptured = client.post('/poc/scan', json={
                'target': 'http://127.0.0.1:8848', 'templates': ['nacos/nacos-unauth-users.yaml'],
                'proxy_mode': 'direct',
            }).json()
            assert uncaptured['matched'] == 1
            assert client.get('/network').json()['counts']['total'] == 3
            print(json.dumps({'passed': True, 'matched': True, 'transport_attempts': route,
                              'timeline_count': 3, 'capture_off_did_not_append': True,
                              'forwarded_requests': len(good[1]), 'proxy_request_target': good[1][0],
                              'image_present': bool(result['image']), 'body_present': bool(result['body']),
                              'scope': 'isolated pool, real loopback HTTP proxies, local Nacos'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
