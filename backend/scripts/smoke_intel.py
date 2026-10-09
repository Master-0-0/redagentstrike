"""Isolated API + real Harness tools + browser acceptance; never scans a target.
Run: PYTHONPATH=backend/src backend/.venv/bin/python backend/scripts/smoke_intel.py
"""
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import patch

import httpx
import uvicorn
from playwright.sync_api import sync_playwright, expect
from workbench.api import create_app
from workbench.config import Settings

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/verification/intel'
OUT.mkdir(parents=True, exist_ok=True)

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

def ready(url):
    for _ in range(100):
        try:
            if httpx.get(url, timeout=1, trust_env=False).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(.1)
    raise RuntimeError('test server did not start')

with tempfile.TemporaryDirectory(prefix='intel-acceptance-') as tmp:
    home = Path(tmp)
    api_port, ui_port = free_port(), free_port()
    api = f'http://127.0.0.1:{api_port}'
    url = f'http://127.0.0.1:{ui_port}'
    settings = Settings(data_dir=home/'data', dsh_home=home/'dsh', api_port=api_port, dsh_port=free_port(), manage_dsh=False)
    server = uvicorn.Server(uvicorn.Config(create_app(settings), host='127.0.0.1', port=api_port, log_level='error'))
    with patch('workbench.api._install_agent_skill'):
        thread = threading.Thread(target=server.run, daemon=True); thread.start()
        ready(api + '/health')
    log = (home/'vite.log').open('w')
    vite = subprocess.Popen(['node', 'node_modules/vite/bin/vite.js', '--port', str(ui_port)], cwd=ROOT/'web-ui', env={**os.environ, 'VITE_API_ORIGIN': api, 'VITE_DSH_ORIGIN': api}, stdout=log, stderr=log)
    try:
        ready(url)
        run = subprocess.run(['node', str(ROOT/'dsh-intel/scripts/smoke-harness.mjs'), api, str(home/'harness')], env={**os.environ, 'DSH_HOME': str(home/'harness-home')}, text=True, capture_output=True, timeout=90)
        if run.returncode:
            raise RuntimeError(run.stdout[-3000:] + run.stderr[-3000:])
        harness = json.loads((home/'harness/verification.json').read_text())
        workspace = home/'workspace'; workspace.mkdir()
        other = home/'other'; other.mkdir()
        ctx = dict(workspace_path=str(workspace), session_id='explore-demo', owner_session_id='cairn-demo')
        with httpx.Client(base_url=api, trust_env=False) as client:
            w = client.post('/intel/workspaces', json=dict(title='授权演示项目', path=str(workspace))).json()
            wid = w['id']
            client.post('/intel/workspaces', json=dict(title='隔离工作区', path=str(other))).raise_for_status()
            seed = dict(context=ctx, submission_key='ui-seed', entities=[dict(ref='host', kind='host', name='db.demo.test', identifier='db.demo.test'), dict(ref='p', kind='password', name='数据库凭据', identifier='demo_reader@db.demo.test', namespace='db.demo.test', secret='UI-FIXTURE-ONLY', evidence='配置声明，未验证'), dict(ref='person', kind='person', name='演示身份', identifier='演示身份', namespace='demo.test')], relations=[dict(from_ref='host', to_ref='p', label='关联凭据', basis='declared', evidence='同一配置文件中的声明')])
            seeded = client.post('/intel/agent/save', json=seed); seeded.raise_for_status()
            host_id = seeded.json()['entities'][0]['id']
            with sync_playwright() as p:
                browser = p.chromium.launch()
                page = browser.new_page(viewport={'width':1440, 'height':1000})
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(url)
                page.get_by_role('button', name='情报资产库', exact=True).click()
                page.get_by_role('button', name='授权演示项目', exact=False).click()
                expect(page.get_by_role('heading', name='授权演示项目')).to_be_visible()
                page.locator('.intel-row-link').filter(has_text='db.demo.test').click()
                page.get_by_role('button', name='关联对象', exact=True).click()
                page.get_by_role('button', name='数据库凭据 →', exact=True).click()
                expect(page.get_by_role('button', name='凭证关联', exact=True)).to_have_attribute('aria-pressed', 'true')
                page.get_by_role('button', name='概况', exact=True).click()
                expect(page.locator('.intel-secret pre')).not_to_contain_text('UI-FIXTURE-ONLY')
                page.get_by_role('button', name='查看原值', exact=True).click()
                expect(page.locator('.intel-secret pre')).to_have_text('UI-FIXTURE-ONLY')
                page.get_by_role('button', name='收起原值', exact=True).click()
                page.get_by_role('button', name='编辑信息 / 状态').click()
                page.get_by_label('状态', exact=True).select_option('disabled')
                page.get_by_role('button', name='保存修改').click()
                expect(page.locator('.intel-detail>.intel-badge').last).to_have_text('已停用')
                page.get_by_role('button', name='身份', exact=True).click()
                page.get_by_role('button', name='＋ 新增', exact=True).click()
                page.get_by_label('类型', exact=True).select_option('email')
                page.get_by_label('显示名称').fill('演示联系邮箱')
                page.get_by_label('标识 / 值').fill('ops@demo.test')
                page.get_by_role('button', name='保存', exact=True).click()
                expect(page.get_by_role('heading', name='演示联系邮箱')).to_be_visible()
                page.get_by_role('button', name='关联对象', exact=True).click()
                page.get_by_role('button', name='＋ 添加关联').click()
                page.get_by_label('搜索本工作区对象').fill('演示身份')
                expect(page.get_by_label('关联到').locator('option')).to_have_count(2)
                page.get_by_label('关联到').select_option(index=1)
                page.get_by_label('关系名称').fill('联系方式归属')
                page.get_by_label('证据说明').fill('虚构资料中明确关联')
                page.get_by_role('button', name='保存关联').click()
                expect(page.get_by_role('button', name='演示身份 →')).to_be_visible()
                # New identity types support manual entry and category/kind filtering.
                for kind, label in [('employee_id', '工号'), ('student_id', '学号'), ('national_id', '身份证号'), ('user_id', '用户 ID')]:
                    page.get_by_role('button', name='＋ 新增', exact=True).click()
                    page.get_by_label('类型', exact=True).select_option(kind)
                    page.get_by_label('显示名称').fill('虚构' + label)
                    page.get_by_label('标识 / 值').fill('000123' if kind != 'national_id' else 'FIXTURE-ID-****')
                    page.get_by_label('所属域 / 系统').fill('fixture.example')
                    page.get_by_role('button', name='保存', exact=True).click()
                    expect(page.get_by_role('heading', name='虚构' + label)).to_be_visible()
                    page.get_by_label('类型筛选').select_option(kind)
                    expect(page.locator('.intel-row-link')).to_have_count(1)
                    expect(page.locator('.intel-row-link')).to_contain_text('虚构' + label)
                page.get_by_label('类型筛选').select_option('')
                page.get_by_role('button', name='资产关联', exact=True).click()
                page.locator('.intel-row-link').filter(has_text='db.demo.test').click()
                page.get_by_role('button', name='关联对象', exact=True).click()
                page.screenshot(path=str(OUT/'assets.png'), full_page=True)
                # Saving while the page is open appears on the next poll, keeping selection.
                client.post('/intel/agent/save', json=dict(context=ctx, submission_key='live-add', entities=[dict(ref='new', kind='ip', name='新增 IP', identifier='192.0.2.42')])).raise_for_status()
                expect(page.locator('.intel-row-link').filter(has_text='新增 IP')).to_be_visible(timeout=10000)
                expect(page.get_by_role('heading', name='db.demo.test', exact=True)).to_be_visible()
                # A poll outage keeps existing rows and reports failure, not an empty library.
                page.route('**/api/intel/workspaces/*/query', lambda route: route.fulfill(status=503, content_type='application/json', body='{"error_code":"intel_storage_unavailable"}'))
                expect(page.get_by_role('alert')).to_contain_text('已有结果保留', timeout=10000)
                expect(page.locator('.intel-row-link').filter(has_text='新增 IP')).to_be_visible()
                page.unroute('**/api/intel/workspaces/*/query')
                expect(page.get_by_role('alert')).to_have_count(0, timeout=10000)
                page.get_by_role('button', name='Agent 读写', exact=True).click()
                expect(page.locator('.intel-event').filter(has_text='读取原值')).to_be_visible()
                assert 'UI-FIXTURE-ONLY' not in page.locator('.intel-results').inner_text()
                page.screenshot(path=str(OUT/'activity.png'), full_page=True)
                page.get_by_role('button', name='隔离工作区', exact=False).click()
                expect(page.get_by_role('heading', name='暂无匹配情报')).to_be_visible()
                assert 'UI-FIXTURE-ONLY' not in page.locator('.intel-main').inner_text()
                page.get_by_role('button', name='授权演示项目', exact=False).click()
                page.get_by_label('搜索情报').fill('not-present')
                expect(page.get_by_role('heading', name='暂无匹配情报')).to_be_visible()
                page.get_by_label('搜索情报').fill('')
                expect(page.locator('.intel-row-link').filter(has_text='新增 IP')).to_be_visible()
                page.set_viewport_size({'width': 390, 'height': 844})
                page.screenshot(path=str(OUT/'mobile.png'), full_page=True)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                assert not errors, errors
                browser.close()
        result = dict(harness=harness, ui=dict(workspace_isolation=True, navigation=True, linked_navigation=True, explicit_secret_reveal=True, manual_edit=True, manual_create=True, relationship_create=True, live_update_preserves_selection=True, outage_preserves_rows=True, empty_search=True, audit_without_secrets=True, mobile_no_overflow=True, page_errors=errors))
        (OUT/'verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        print(json.dumps(result, ensure_ascii=False))
    finally:
        vite.terminate(); vite.wait(timeout=10); log.close()
        server.should_exit = True; thread.join(timeout=10)
