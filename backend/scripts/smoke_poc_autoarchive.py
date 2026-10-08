"""UI fixtures + real archive API: opt-out, matches only, durable retry/idempotence.
No HTTP target is scanned. Run against isolated workbench data.
"""
import json
import sys
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

url=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:15173'
out=Path('docs/verification/findings-autoarchive');out.mkdir(parents=True,exist_ok=True)
title='自动归档 UI fixture '+uuid.uuid4().hex[:6]
template=dict(template_id='fixture.yaml',id='fixture',name=title,severity='medium',category='fixture',author='test',description='UI fixture',tags=[],content='id: fixture\n# Not executed\n')
def result(name,matched=True):
    return dict(template_id='fixture.yaml' if matched else 'no-hit.yaml',id='fixture',name=name,severity='medium',matched=matched,image=None,body='HTTP/1.1 200 OK\n\nfixture response',image_error='fixture has no screenshot',attempts=[dict(url='http://local-fixture.invalid',method='GET',status=200,duration_ms=1,matched=matched,matchers=[],error=None)])
with sync_playwright() as p:
    browser=p.chromium.launch()
    page=browser.new_page(viewport={'width':1440,'height':1050})
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    def response(route,payload):route.fulfill(status=200,content_type='application/json',body=json.dumps(payload))
    page.route('**/api/poc/templates',lambda r:response(r,dict(categories=['fixture'],templates=[template])))
    page.route('**/api/poc/templates/fixture.yaml',lambda r:response(r,template))
    scan_count=[0]
    def scan(route):
        scan_count[0]+=1
        response(route,dict(scan_id=f'auto-fixture-{title}-{scan_count[0]}',target='http://local-fixture.invalid',duration_ms=1,matched=1,total=2,results=[result(title),result('Unmatched fixture',False)]))
    page.route('**/api/poc/scan',scan)
    def start_scan():
        page.get_by_label('目标地址').fill('http://local-fixture.invalid')
        page.locator('input[type="checkbox"]:not([role="switch"])').first.check()
        page.get_by_role('button',name='开始扫描',exact=True).click()
        expect(page.locator('.poc-result')).to_have_count(2)
    page.goto(url);page.get_by_role('button',name='poc 扫描',exact=True).click()
    switch=page.get_by_role('switch',name='命中后自动归档')
    expect(switch).to_be_checked()
    switch.uncheck();page.reload();page.get_by_role('button',name='poc 扫描',exact=True).click()
    expect(page.get_by_role('switch',name='命中后自动归档')).not_to_be_checked()
    start_scan()
    expect(page.locator('.poc-auto-archive-job')).to_have_count(0)
    expect(page.get_by_role('button',name='归档此结果',exact=True)).to_have_count(2)
    page.get_by_role('switch',name='命中后自动归档').check()
    expect(page.locator('.poc-auto-archive-job')).to_have_count(0) # no retroactive enqueue
    start_scan()
    expect(page.locator('.poc-auto-archive-job[data-status="committed"]')).to_have_count(1,timeout=20000)
    assert page.locator('.poc-auto-archive-job').count()==1
    assert page.get_by_role('dialog').count()==0
    listing=page.request.get(url+'/api/findings').json()
    saved=[f for f in listing['items'] if f['title']==title]
    assert len(saved)==1 and saved[0]['review_status']=='pending'
    detail=page.request.get(url+'/api/findings/'+saved[0]['id']).json()
    assert len(detail['artifacts'])==3
    assert any(g['category']=='screenshot' and g['status']=='missing' for g in detail['evidence_gaps'])
    page.get_by_role('button',name='漏洞成果库',exact=True).click()
    page.get_by_role('button',name='poc 扫描',exact=True).click()
    expect(page.locator('.poc-auto-archive-job[data-status="committed"]')).to_have_count(1)
    # Simulate response loss AFTER server commit. Reload then retry must return same finding.
    keys=[]
    def observe(request):
        if request.url.endswith('/api/finding-submissions') and request.method=='POST':keys.append(request.post_data_json['submission_key'])
    page.on('request',observe)
    def lose_receipt(route):
        committed=route.fetch()
        assert committed.status==200
        route.fulfill(status=503,content_type='application/json',body=json.dumps({'message':'fixture: receipt lost after commit'}))
    page.route('**/api/finding-submissions/*/commit',lose_receipt)
    start_scan()
    expect(page.locator('.poc-auto-archive-job[data-status="failed"]')).to_have_count(1,timeout=20000)
    original_key=keys[-1]
    before=page.request.get(url+'/api/findings').json()['total']
    page.reload();page.get_by_role('button',name='poc 扫描',exact=True).click()
    expect(page.locator('.poc-auto-archive-job[data-status="failed"]')).to_have_count(1)
    # No re-reading deleted template/network sources on prepared retry.
    page.route('**/api/poc/templates/fixture.yaml',lambda r:r.fulfill(status=404,body='not found'))
    page.unroute('**/api/finding-submissions/*/commit')
    page.get_by_role('button',name='重试归档',exact=True).evaluate('(button)=>{button.click();button.click()}')
    expect(page.locator('.poc-auto-archive-job[data-status="committed"]')).to_have_count(2,timeout=20000)
    assert keys[-1]==original_key
    assert page.request.get(url+'/api/findings').json()['total']==before
    page.screenshot(path=str(out/'auto-archive.png'),full_page=True)
    rows=page.evaluate("""async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('workbench-poc-archive',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});return new Promise(resolve=>{const r=db.transaction('jobs').objectStore('jobs').getAll();r.onsuccess=()=>resolve(r.result)})}""")
    assert all(not row.get('prepared') and not row.get('report') for row in rows)
    assert not errors,errors
    (out/'ui-verification.json').write_text(json.dumps(dict(default_on=True,opt_out_persists=True,no_retroactive_upload=True,matched_only=True,no_manual_form=True,pending_review=True,explicit_gaps=True,navigation_preserves_queue=True,reload_retry_same_key=True,lost_commit_receipt_idempotent=True,no_source_reread_on_retry=True,success_clears_local_evidence=True,page_errors=errors),indent=2))
    browser.close();print('Automatic PoC archive acceptance passed')
