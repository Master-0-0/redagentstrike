"""Validate board and PoC entry forms against the real archive API.
Board registry/PoC result responses are explicit UI fixtures; no scan is run.
"""
import base64
import json
import sys
import uuid
from io import BytesIO
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright, expect

url = sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:15173'
out = Path('docs/verification/findings'); out.mkdir(parents=True,exist_ok=True)
board = json.loads(Path('dsh-cairn-search/preset/skills/state-space-search/references/board.example.json').read_text())
image = BytesIO(); Image.new('RGB',(120,60),'white').save(image,format='PNG')
title = 'PoC UI fixture '+uuid.uuid4().hex[:6]
template = dict(template_id='fixture.yaml',id='fixture',name=title,severity='info',category='fixture',author='test',description='UI fixture only',tags=[],content='id: fixture\n# UI fixture only; no scan executed\n')
report = dict(target='http://local-fixture.invalid',duration_ms=1,matched=1,total=1,results=[dict(template_id='fixture.yaml',id='fixture',name=title,severity='info',matched=True,image='data:image/png;base64,'+base64.b64encode(image.getvalue()).decode(),body='HTTP/1.1 200 OK\n\nUI fixture only',image_error=None,attempts=[dict(url='http://local-fixture.invalid',method='GET',status=200,duration_ms=1,matched=True,matchers=[],error=None)])])
with sync_playwright() as p:
    browser=p.chromium.launch(); page=browser.new_page(viewport={'width':1440,'height':1050})
    def response(route,payload):route.fulfill(status=200,content_type='application/json',body=json.dumps(payload))
    page.route('**/api/blackboards',lambda r:response(r,{'dsh_home':'fixture','workspaces':[dict(id='fixture-ws',path='/fixture',title='Fixture workspace',boards=[dict(owner_id='fixture-owner',title=board['title'],status='active',mtime='2026-09-24T00:00:00Z')])]}))
    page.route('**/api/blackboards/fixture-ws/fixture-owner',lambda r:response(r,dict(workspace_id='fixture-ws',owner_id='fixture-owner',path='/fixture/board.json',text=json.dumps(board))))
    page.goto(url);page.get_by_role('button',name='画板展示',exact=True).click()
    page.locator('.dsh-bb-node[data-kind="fact"]').click()
    page.get_by_role('button',name='保存到漏洞成果库',exact=True).click()
    expect(page.get_by_label('漏洞摘要',exact=True)).to_have_value(board['facts'][2]['description'])
    board_title='画板 UI fixture '+uuid.uuid4().hex[:6]
    page.get_by_label('漏洞标题',exact=True).fill(board_title)
    page.get_by_label('目标',exact=True).fill('local fixture')
    page.get_by_role('button',name='保存为待复核成果').click()
    expect(page.get_by_role('heading',name='归档成功 · 待人工核对')).to_be_visible()
    page.get_by_role('button',name='完成',exact=True).click()
    page.get_by_role('button',name='漏洞成果库',exact=True).click()
    page.get_by_label('搜索成果').fill(board_title)
    expect(page.locator('.finding-card')).to_have_count(1)
    page.locator('.finding-card').click()
    expect(page.locator('.findings-source blockquote')).to_contain_text(board['facts'][2]['description'])
    page.get_by_role('button',name='在工作台查看来源画板').click()
    expect(page.locator('.dsh-bb-node[data-kind="fact"]')).to_be_visible()
    page.route('**/api/poc/templates',lambda r:response(r,{'categories':['fixture'],'templates':[template]}))
    page.route('**/api/poc/templates/fixture.yaml',lambda r:response(r,template))
    page.route('**/api/poc/scan',lambda r:response(r,report))
    page.get_by_role('button',name='poc 扫描',exact=True).click()
    page.get_by_role('switch',name='命中后自动归档').uncheck()
    page.get_by_label('目标地址').fill(report['target'])
    page.locator('input[type="checkbox"]:not([role="switch"])').first.check()
    page.get_by_role('button',name='开始扫描',exact=True).click()
    page.get_by_role('button',name='归档此结果',exact=True).click()
    expect(page.get_by_label('漏洞标题',exact=True)).to_have_value(title)
    expect(page.locator('.findings-upload')).to_have_count(4)
    page.screenshot(path=str(out/'poc-form.png'),full_page=True)
    page.get_by_role('button',name='保存为待复核成果',exact=True).click()
    expect(page.get_by_role('heading',name='归档成功 · 待人工核对')).to_be_visible()
    page.get_by_role('button',name='完成',exact=True).click()
    page.get_by_role('button',name='漏洞成果库',exact=True).click()
    page.get_by_label('搜索成果').fill(title)
    expect(page.locator('.finding-card')).to_have_count(1)
    page.locator('.finding-card').click()
    expect(page.locator('.findings-detail > .finding-card-tags')).to_contain_text('待复核')
    expect(page.locator('.findings-artifact')).to_have_count(4)
    expect(page.locator('.findings-artifact').filter(has_text='响应文本截图')).to_contain_text('不能代替完整响应附件')
    (out/'entry-verification.json').write_text(json.dumps({'board_fact_prefill':True,'board_fact_snapshot_saved':True,'in_page_source_navigation':True,'poc_result_fixture_archived':True,'poc_artifacts':4,'poc_stays_pending':True,'response_screenshot_label':True,'network_scan_executed':False},indent=2))
    browser.close();print('Board/PoC entry acceptance passed')
