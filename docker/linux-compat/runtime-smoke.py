"""Real HTTP/HTTPS capture, interception and replay using unmodified platform logic."""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import ipaddress
import json
import os
import ssl
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
import uvicorn
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from workbench.api import create_app
from workbench.config import Settings
from workbench.mitm import _find_mitmdump
from workbench.poc_evidence import capture_response_image

results = {}
requests_seen = []

class Target(BaseHTTPRequestHandler):
    def do_GET(self):
        requests_seen.append(self.path)
        body = b'linux-compat-local-target'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *_):
        pass


def wait_for(call, predicate, label):
    for _ in range(100):
        value = call()
        if predicate(value):
            return value
        time.sleep(.1)
    raise AssertionError(f'{label}: {value}')


with TemporaryDirectory() as directory:
    root = Path(directory)
    # A local test TLS origin with explicit trust; neither TLS leg disables verification.
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'compat-local-origin')])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=1)).not_valid_after(now + timedelta(days=1))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), critical=False)
            .sign(key, hashes.SHA256()))
    cert_path, key_path = root / 'origin.pem', root / 'origin.key'
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    binary = _find_mitmdump()
    assert binary, 'mitmdump required'
    # Supply the test origin's CA through mitmproxy's normal trust option.
    launcher = root / 'mitmdump-test-ca'
    launcher.write_text(f'#!{sys.executable}\nimport os, sys\nos.execv({binary!r}, [{binary!r}, "--set", {("ssl_verify_upstream_trusted_ca=" + str(cert_path))!r}] + sys.argv[1:])\n')
    launcher.chmod(0o700)
    previous_binary = os.environ.get('WORKBENCH_MITMDUMP')
    os.environ['WORKBENCH_MITMDUMP'] = str(launcher)
    target = ThreadingHTTPServer(('127.0.0.1', 0), Target)
    tls_target = ThreadingHTTPServer(('127.0.0.1', 0), Target)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert_path, key_path)
    tls_target.socket = tls.wrap_socket(tls_target.socket, server_side=True)
    for origin in (target, tls_target):
        threading.Thread(target=origin.serve_forever, daemon=True).start()
    settings = Settings(data_dir=root / 'data', api_port=18787, proxy_port=18088, manage_dsh=False)
    server = uvicorn.Server(uvicorn.Config(create_app(settings), host='127.0.0.1', port=18787, log_level='warning'))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        with httpx.Client(base_url='http://127.0.0.1:18787', timeout=20, trust_env=False) as api:
            for _ in range(100):
                try:
                    if api.get('/health').status_code == 200:
                        break
                except httpx.ConnectError:
                    pass
                time.sleep(.1)
            assert api.get('/health').json()['capture_supported'] is True
            enabled = api.post('/capture', json={'enabled': True}).json()
            results['native_capture_start'] = enabled
            assert enabled['error'] is None and enabled['capture']['listening'], enabled
            http_url = f'http://127.0.0.1:{target.server_port}'
            https_url = f'https://127.0.0.1:{tls_target.server_port}'
            def get_proxied(url):
                with httpx.Client(proxy='http://127.0.0.1:18088', verify=ssl.create_default_context(cafile=str(settings.mitm_ca)), trust_env=False, timeout=20) as proxied:
                    return proxied.get(url)
            for url in (http_url + '/http', https_url + '/https'):
                response = get_proxied(url)
                assert response.status_code == 200 and response.text == 'linux-compat-local-target'
            network = wait_for(lambda: api.get('/network').json(), lambda n: n['counts']['total'] >= 2, 'HTTP/HTTPS timeline')
            urls = {event['join']['url'] for event in network['events']}
            assert {http_url + '/http', https_url + '/https'} <= urls, network
            results['http_https_network'] = network
            assert api.post('/capture/intercept', json={'enabled': True}).json()['error'] is None
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(get_proxied, http_url + '/held')
                hold = wait_for(lambda: api.get('/capture/pending').json(), lambda h: bool(h['pending']), 'held request')['pending'][0]
                assert '/held' not in requests_seen
                response = api.post(f"/capture/pending/{hold['id']}/forward", json={'method': 'GET', 'url': http_url + '/edited', 'headers': {}, 'body': ''})
                assert response.status_code == 200
                assert pending.result(timeout=20).status_code == 200
                assert '/edited' in requests_seen and '/held' not in requests_seen
                pending = pool.submit(get_proxied, http_url + '/dropped')
                hold = wait_for(lambda: api.get('/capture/pending').json(), lambda h: bool(h['pending']), 'drop request')['pending'][0]
                assert api.post(f"/capture/pending/{hold['id']}/drop").status_code == 200
                try:
                    response = pending.result(timeout=20)
                    assert response.status_code >= 400
                except httpx.RequestError:
                    pass
                assert '/dropped' not in requests_seen
            api.post('/capture/intercept', json={'enabled': False})
            replay = api.post('/capture/replay', json={'method': 'GET', 'url': http_url + '/replayed', 'headers': {}, 'body': ''}).json()
            assert replay['status'] == 200 and replay['via_proxy'] and '/replayed' in requests_seen, replay
            results['intercept_forward_drop_replay'] = 'passed'
            stopped = api.post('/capture', json={'enabled': False}).json()
            assert stopped['error'] is None and not stopped['capture']['listening']
            before = api.get('/network').json()['counts']['total']
            assert httpx.get(http_url + '/direct', trust_env=False).status_code == 200
            assert api.get('/network').json()['counts']['total'] == before
            restarted = api.post('/capture', json={'enabled': True}).json()
            assert restarted['error'] is None and restarted['capture']['listening']
            assert get_proxied(http_url + '/restarted').status_code == 200
            wait_for(lambda: api.get('/network').json(), lambda n: any(e['join']['url'].endswith('/restarted') for e in n['events']), 'restart capture')
            api.post('/capture', json={'enabled': False})
            results['stop_and_restart'] = 'passed'
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        for origin in (target, tls_target):
            origin.shutdown()
            origin.server_close()
        if previous_binary is None:
            os.environ.pop('WORKBENCH_MITMDUMP', None)
        else:
            os.environ['WORKBENCH_MITMDUMP'] = previous_binary
        Path('/results/runtime-smoke.json').write_text(json.dumps(results, indent=2, ensure_ascii=False))

image, error = capture_response_image('http://local.test', 'GET', 'HTTP/1.1 200 OK\r\n\r\nLinux 中文兼容性测试')
assert error is None and image, error
Path('/results/response-evidence.png').write_bytes(base64.b64decode(image.split(',', 1)[1]))
print('PASS: native HTTP/HTTPS capture; intercept/edit/forward/drop; replay; stop/restart; Chromium screenshot. No platform override.')
