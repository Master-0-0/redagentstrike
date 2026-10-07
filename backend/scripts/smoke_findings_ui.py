"""Browser acceptance against an isolated, running workbench (no target scans).
Usage: backend/.venv/bin/python backend/scripts/smoke_findings_ui.py URL OUTDIR
"""
import json
import re
import sys
import tempfile
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:15173'
out = Path(sys.argv[2] if len(sys.argv) > 2 else 'docs/verification/findings')
out.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory() as temp, sync_playwright() as p:
    fixture = Path(temp) / 'ui-evidence.txt'
    raw = 'Authorization: Bearer UI_SECRET\n<script>window.archiveUnsafe = true</script>\nBrowser acceptance fixture.\n'
    fixture.write_text(raw)
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width':1440,'height':1050})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(url)
    page.get_by_role('button', name='漏洞成果库', exact=False).click()
    page.get_by_role('button', name='＋ 手工新增').click()
    title = 'UI 验收：证据归档与人工复核 ' + uuid.uuid4().hex[:6]
    page.get_by_label('漏洞标题', exact=True).fill(title)
    page.get_by_label('目标', exact=True).fill('本机 UI fixture')
    page.get_by_label('漏洞摘要', exact=True).fill('检查手工归档、预览完整凭据、原字节下载和人工状态编辑。')
    page.get_by_label('添加证据文件').set_input_files(str(fixture))
    page.get_by_label('ui-evidence.txt 证据类型').select_option('tool_output')
    page.get_by_role('button', name='保存为待复核成果').click()
    expect(page.get_by_role('heading',name='归档成功 · 待人工核对')).to_be_visible(timeout=20000)
    page.get_by_role('button',name='完成',exact=True).click()
    page.get_by_label('搜索成果').fill(title)
    expect(page.locator('.finding-card')).to_have_count(1)
    page.screenshot(path=str(out/'list.png'),full_page=True)
    page.locator('.finding-card').click()
    page.get_by_role('button',name='预览证据',exact=True).click()
    expect(page.locator('.findings-artifact pre')).to_contain_text('Browser acceptance fixture.')
    assert 'UI_SECRET' in page.locator('.findings-artifact pre').inner_text()
    assert page.evaluate('window.archiveUnsafe') is None
    with page.expect_download() as download:
        page.get_by_role('link',name='下载完整附件（含保存凭据）').click()
    downloaded = Path(temp)/'download.txt'
    download.value.save_as(str(downloaded))
    assert downloaded.read_text() == raw
    page.get_by_role('button',name='编辑说明与人工状态').click()
    page.get_by_label('人工复核',exact=True).select_option('confirmed')
    page.get_by_label('修复状态',exact=True).select_option('fixed')
    page.get_by_label('修改备注',exact=True).fill('UI 测试人工确认，不代表真实漏洞。')
    page.get_by_role('button',name='保存修改',exact=True).click()
    expect(page.locator('.findings-detail > .finding-card-tags')).to_contain_text('已确认')
    expect(page.locator('.findings-detail > .finding-card-tags')).to_contain_text('已修复')
    page.get_by_role('button',name='追加证据 / 解决缺口').click()
    page.get_by_label('补充说明',exact=True).fill('追加说明后应保留人工结论。')
    page.get_by_role('button',name='追加材料').click()
    expect(page.get_by_role('heading',name='追加成功 · 人工状态保持不变')).to_be_visible()
    page.get_by_role('button',name='完成',exact=True).click()
    expect(page.locator('.findings-detail > .finding-card-tags')).to_contain_text('已确认')
    page.screenshot(path=str(out/'detail.png'),full_page=True)
    page.get_by_role('button',name='关闭',exact=True).click()
    page.get_by_label('搜索成果').fill('不存在的成果关键词')
    expect(page.get_by_role('heading',name='暂无符合条件的成果')).to_be_visible()
    page.screenshot(path=str(out/'empty.png'),full_page=True)
    page.get_by_label('搜索成果').fill('')
    expect(page.locator('.finding-card').first).to_be_visible()
    # Poll failure keeps old results visible, then explicit retry recovers.
    page.route('**/api/findings?*', lambda route: route.fulfill(status=503,content_type='application/json',body=json.dumps({'message':'UI fixture simulated outage'})))
    expect(page.get_by_role('alert')).to_contain_text('保留上次结果',timeout=10000)
    assert page.locator('.finding-card').count() >= 1
    page.unroute('**/api/findings?*')
    page.get_by_role('button',name='重试',exact=True).click()
    expect(page.get_by_role('alert')).to_have_count(0)
    page.set_viewport_size({'width':390,'height':844})
    page.screenshot(path=str(out/'mobile.png'),full_page=True)
    assert not errors, errors
    (out/'ui-verification.json').write_text(json.dumps({'manual_create':True,'preview_preserves_credentials':True,'html_inert':True,'download_preserves_bytes':True,'human_review_edit':True,'append_preserves_review':True,'search_empty_state':True,'poll_failure_preserves_results':True,'retry_recovers':True,'page_errors':errors},indent=2))
    browser.close()
    print('UI acceptance passed')
