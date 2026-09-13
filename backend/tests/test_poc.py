from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

from workbench.poc import TemplateError, read_template, scan_templates


@pytest.fixture
def local_target():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"pageItems":[{"username":"fixture"}]}')

        def do_POST(self):
            self.rfile.read(int(self.headers.get('Content-Length', 0)))
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b'{"message":"Forbidden"}')

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield "http://127.0.0.1:{}".format(server.server_port)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_scan_api_against_real_local_http(client, local_target):
    response = client.post('/poc/scan', json={
        'target': local_target,
        'templates': ['nacos/nacos-unauth-users.yaml', 'nacos/nacos-default-login.yaml'],
    })
    assert response.status_code == 200
    report = response.json()
    assert report['total'] == 2
    assert report['matched'] == 1
    assert report['results'][0]['attempts'][0]['status'] == 200
    assert report['results'][1]['matched'] is False
    assert report['results'][1]['attempts'][0]['status'] == 403
    assert report['results'][0]['body'].startswith('HTTP/1.0 200')
    assert '"username":"fixture"' in report['results'][0]['body']
    assert report['results'][1]['body'] is None
    assert report['results'][1]['image'] is None


def test_scan_connection_failure_is_not_clean_result(client, monkeypatch):
    def fail(self, method, url, **kwargs):
        raise httpx.ConnectError('fixture unavailable')
    monkeypatch.setattr(httpx.Client, 'request', fail)
    # Use the executor directly because TestClient itself uses httpx.Client.request.
    root = client.app.state.wb.settings.poc_templates_dir
    report = scan_templates(root, 'http://127.0.0.1:1', ['nacos/nacos-unauth-users.yaml'])
    assert report['matched'] == 0
    assert report['results'][0]['attempts'][0]['error'] == 'ConnectError'


@pytest.mark.parametrize('changes', [
    {'target': 'file:///etc/passwd'}, {'target': 'http://[bad'},
    {'templates': []}, {'concurrency': 0}, {'timeout': 31},
    {'templates': ['../outside.yaml']},
])
def test_scan_rejects_invalid_input(client, changes):
    body = {'target': 'http://127.0.0.1:1', 'templates': ['nacos/nacos-unauth-users.yaml']}
    body.update(changes)
    assert client.post('/poc/scan', json=body).status_code in {400, 422}


def test_unsupported_matcher_rejected_before_request(tmp_path):
    (tmp_path / 'bad.yaml').write_text('''id: bad
info:
  name: bad
http:
  - path: ['{{BaseURL}}/']
    matchers:
      - type: dsl
        dsl: ['true']
''')
    with pytest.raises(TemplateError, match='template_matcher_unsupported'):
        scan_templates(tmp_path, 'http://127.0.0.1:1', ['bad.yaml'])


def test_poc_template_catalog_and_content(client):
    listed = client.get("/poc/templates")
    assert listed.status_code == 200
    body = listed.json()
    assert "nacos" in body["categories"]
    ids = {item["template_id"] for item in body["templates"]}
    assert "nacos/nacos-unauth-users.yaml" in ids

    detail = client.get("/poc/templates/nacos/nacos-unauth-users.yaml")
    assert detail.status_code == 200
    assert detail.json()["id"] == "nacos-unauth-users"
    assert "{{BaseURL}}" in detail.json()["content"]


def test_poc_template_path_cannot_escape(settings):
    try:
        read_template(settings.poc_templates_dir, "../pyproject.toml")
    except TemplateError as exc:
        assert str(exc) == "template_id_invalid"
    else:
        raise AssertionError("path traversal should fail")


def test_scan_matches_nuclei_style_http_template(tmp_path: Path, monkeypatch):
    root = tmp_path / "pocs"
    template_dir = root / "nacos"
    template_dir.mkdir(parents=True)
    (template_dir / "probe.yaml").write_text(
        """id: probe\ninfo:\n  name: probe\n  severity: high\nhttp:\n  - method: GET\n    path: ['{{BaseURL}}/health']\n    matchers-condition: and\n    matchers:\n      - type: status\n        status: [200]\n      - type: word\n        words: ['Nacos']\n""",
        encoding="utf-8",
    )

    def fake_request(self, method, url, **kwargs):
        request = httpx.Request(method, url)
        return httpx.Response(200, request=request, text="Nacos is ready")

    monkeypatch.setattr(httpx.Client, "request", fake_request)
    report = scan_templates(root, "https://example.test", ["nacos/probe.yaml"])
    assert report["matched"] == 1
    assert report["results"][0]["matched"] is True
    assert report["results"][0]["attempts"][0]["url"] == "https://example.test/health"
