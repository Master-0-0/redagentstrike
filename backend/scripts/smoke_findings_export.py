"""Isolated report export acceptance. Never point API at production data."""
import json
import sys
import uuid
from pathlib import Path
import httpx
from playwright.sync_api import sync_playwright, expect

origin = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:15173'
api = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:18789'
out = Path('docs/verification/findings-export')
out.mkdir(parents=True, exist_ok=True)
prefix = '导出验收-' + uuid.uuid4().hex[:6]
with httpx.Client(trust_env=False) as c:
    for n in range(21):
        body = {'submission_key': str(uuid.uuid4()), 'op': 'create', 'source': {'source_type': 'manual'}, 'finding': {'title': f'{prefix}-{n:02d}', 'target': 'https://fixture.invalid/api?token=fixture-secret', 'summary': '测试账号能够读取其他账号的记录。此内容仅用于导出功能验收。', 'severity': 'medium', 'preconditions': '已登录的测试账号。', 'steps': [{'id': 'step-1', 'description': '使用测试账号查看已保存的响应。\nAuthorization: Bearer fixture-secret'}], 'expected_result': '仅能读取自己的记录。', 'actual_result': '已保存的响应包含另一测试账号的记录。<script>不能执行</script>', 'agent_assessment': 'suspected'}, 'evidence_gaps': [{'category': kind, 'status': 'missing', 'reason': '未提供此类材料。'} for kind in ('poc', 'http', 'screenshot', 'tool_output')]}
        r = c.post(api + '/finding-submissions', json=body); r.raise_for_status()
        c.post(api + '/finding-submissions/' + r.json()['id'] + '/commit').raise_for_status()
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 1440, 'height': 1050})
    errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(origin)
    page.get_by_role('button', name='漏洞成果库', exact=True).click()
    page.get_by_role('button', name='导出报告', exact=True).click()
    dialog = page.get_by_role('dialog', name='导出报告')
    expect(dialog).to_be_visible()
    expect(dialog.get_by_role('button', name='导出 0 项成果')).to_be_disabled()
    dialog.get_by_label('搜索导出成果').fill(prefix)
    expect(dialog.get_by_role('checkbox')).to_have_count(20)
    dialog.get_by_role('checkbox').first.check()
    dialog.get_by_role('button', name='下一页', exact=True).click()
    expect(dialog.get_by_role('checkbox')).to_have_count(1)
    dialog.get_by_role('checkbox').first.check()
    expect(dialog.get_by_role('button', name='导出 2 项成果')).to_be_enabled()
    page.screenshot(path=str(out / 'selection.png'), full_page=True)
    for format in ('docx', 'pdf'):
        dialog.get_by_label('报告格式').select_option(format)
        with page.expect_download() as event:
            dialog.get_by_role('button', name='导出 2 项成果').click()
        event.value.save_as(str(out / ('report.' + format)))
        expect(dialog.get_by_role('button', name='导出 2 项成果')).to_be_enabled()
    # A failed request keeps selection and allows retry.
    page.route('**/api/findings/export', lambda r: r.fulfill(status=503, content_type='application/json', body='{"message":"测试导出失败"}'))
    dialog.get_by_role('button', name='导出 2 项成果').click()
    expect(dialog.get_by_role('alert')).to_contain_text('测试导出失败')
    expect(dialog.get_by_role('button', name='导出 2 项成果')).to_be_enabled()
    page.unroute('**/api/findings/export')
    dialog.get_by_role('button', name='清空选择').click()
    expect(dialog.get_by_role('button', name='导出 0 项成果')).to_be_disabled()
    page.keyboard.press('Escape'); expect(dialog).not_to_be_visible()
    assert not errors, errors
    browser.close()
(out / 'verification.json').write_text(json.dumps({'selection_across_pages': True, 'docx_download': True, 'pdf_download': True, 'empty_selection_disabled': True, 'failure_preserves_selection': True, 'page_errors': errors}, indent=2))
print('Report export acceptance passed')
