#!/bin/bash
set -uo pipefail
cd /app
mkdir -p /results
# No host credentials or home directory are mounted into this disposable lab.
./start.sh > /results/start.log 2>&1
result=$?
echo "start_exit=$result"
if [ "$result" -eq 0 ]; then
  python - <<'PY'
import json
import socket
import httpx
from pathlib import Path
with httpx.Client(trust_env=False, timeout=15) as client:
    assert client.get('http://127.0.0.1:8787/health').json()['ok']
    assert client.get('http://127.0.0.1:5173/').status_code == 200
    assert client.get('http://127.0.0.1:5173/api/health').json()['ok']
    enabled = client.post('http://127.0.0.1:8787/capture', json={'enabled': True}, timeout=70).json()
    assert enabled['error'] is None and enabled['capture']['listening'], enabled
    assert enabled['capture']['harness']['proxied'] is True, enabled
    disabled = client.post('http://127.0.0.1:8787/capture', json={'enabled': False}, timeout=70).json()
    assert disabled['error'] is None and not disabled['capture']['listening'], disabled
    assert disabled['capture']['harness']['proxied'] is False, disabled
    Path('/results/harness-capture-toggle.json').write_text(json.dumps({'enable': enabled, 'disable': disabled}, indent=2))
    capture = client.get('http://127.0.0.1:8787/capture').json()
    Path('/results/harness-status.json').write_text(json.dumps(capture, indent=2))
    response = client.get(capture['harness']['url'], follow_redirects=True)
    assert response.status_code == 200, (response.status_code, response.text[:200])
    container_ip = socket.gethostbyname(socket.gethostname())
    checks = {}
    for port in (8787, 5173, 3081):
        try:
            checks[str(port)] = client.get(f'http://{container_ip}:{port}/').status_code
        except httpx.ConnectError:
            checks[str(port)] = 'connection refused (loopback binding)'
    Path('/results/container-network.json').write_text(json.dumps(checks, indent=2))
from playwright.sync_api import sync_playwright
with sync_playwright() as runtime:
    browser = runtime.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 960})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:5173/', wait_until='networkidle')
    assert page.locator('#root').inner_text().strip()
    page.screenshot(path='/results/workbench-linux.png', full_page=True)
    Path('/results/browser-errors.json').write_text(json.dumps(errors, indent=2))
    browser.close()
    assert not errors, errors
print('PASS: API, UI, Vite API proxy, Harness HTTP and Chromium UI rendering are available.')
PY
  result=$?
  ./start.sh > /results/repeated-start.log 2>&1 || result=1
fi
./stop.sh > /results/stop.log 2>&1 || result=1
python - <<'PY' || result=1
import socket
for port in (8787, 5173, 3081):
    with socket.socket() as sock:
        assert sock.connect_ex(('127.0.0.1', port)) != 0, f'port {port} remains open after stop'
print('PASS: all three service ports closed after stop.')
PY
[ ! -f /app/backend/data/dsh-web.log ] || cp /app/backend/data/dsh-web.log /results/dsh-web.log
exit "$result"
