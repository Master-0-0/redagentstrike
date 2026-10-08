"""Real local HTTP capture on macOS/Linux; requires mitmdump."""
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import httpx
import pytest
import uvicorn

from workbench.api import create_app
from workbench.config import Settings
from workbench.mitm import _find_mitmdump

pytestmark = pytest.mark.skipif(
    sys.platform not in {'darwin', 'linux'} or _find_mitmdump() is None,
    reason='macOS/Linux + mitmdump required',
)


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def test_proxy_inject_http_then_stop(tmp_path):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'capture-smoke')
        def log_message(self, *_):
            pass

    target = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    target_thread = Thread(target=target.serve_forever, daemon=True)
    target_thread.start()
    settings = Settings(data_dir=tmp_path, api_port=free_port(), proxy_port=free_port())
    server = uvicorn.Server(uvicorn.Config(create_app(settings), host='127.0.0.1', port=settings.api_port, log_level='warning'))
    worker = Thread(target=server.run, daemon=True)
    worker.start()
    try:
        with httpx.Client(base_url=f'http://127.0.0.1:{settings.api_port}', trust_env=False, timeout=15) as api:
            for _ in range(100):
                if server.started:
                    break
                time.sleep(.05)
            assert server.started
            started = api.post('/capture', json={'enabled': True}).json()
            assert started['error'] is None, started
            url = f'http://127.0.0.1:{target.server_port}/smoke'
            with httpx.Client(proxy=f'http://127.0.0.1:{settings.proxy_port}', trust_env=False, timeout=15) as proxied:
                response = proxied.get(url)
                assert response.status_code == 200 and response.text == 'capture-smoke'
            for _ in range(100):
                timeline = api.get('/network').json()
                if any(event['join']['url'] == url for event in timeline['events']):
                    break
                time.sleep(.05)
            assert any(event['join']['url'] == url for event in timeline['events']), timeline
            stopped = api.post('/capture', json={'enabled': False}).json()
            assert stopped['error'] is None and not stopped['capture']['listening']
            before = api.get('/network').json()['counts']['total']
            assert httpx.get(url, trust_env=False).status_code == 200
            assert api.get('/network').json()['counts']['total'] == before
    finally:
        server.should_exit = True
        worker.join(timeout=15)
        target.shutdown()
        target.server_close()
        target_thread.join(timeout=5)
