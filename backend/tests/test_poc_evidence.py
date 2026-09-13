import httpx

from workbench.poc_evidence import response_packet, capture_response_image


def test_response_packet_keeps_status_headers_and_body():
    response = httpx.Response(201, headers=[('X-Test', 'one'), ('X-Test', 'two')], text='<script>alert(1)</script>')
    packet = response_packet(response)
    assert packet.startswith('HTTP/1.1 201 Created\r\n')
    assert 'x-test: one\r\nx-test: two' in packet
    assert packet.endswith('\r\n\r\n<script>alert(1)</script>')


def test_screenshot_failure_does_not_break_scan(monkeypatch):
    from playwright.sync_api import Playwright
    def fail(*args, **kwargs):
        raise RuntimeError('browser missing')
    monkeypatch.setattr(Playwright, 'chromium', property(fail))
    image, error = capture_response_image('http://localhost', 'GET', 'HTTP/1.1 200 OK')
    assert image is None
    assert 'RuntimeError' in error
