import copy
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from workbench.intel import IntelStore, IntelError


def context(tmp_path, name='project'):
    path = tmp_path / name
    path.mkdir(exist_ok=True)
    return dict(workspace_path=str(path), session_id='explore-1', owner_session_id='main-1')

def discovery(ctx, key='save-one'):
    return dict(context=ctx, submission_key=key, entities=[
        dict(ref='host', kind='domain', name='DEMO.TEST.', identifier='DEMO.TEST.', status='observed'),
        dict(ref='user', kind='account', name='reader', identifier='reader', namespace='db.demo.test'),
        dict(ref='password', kind='password', name='Database password', identifier='reader@db', namespace='db.demo.test', secret='sensitive-fixture-482!', evidence='observed in config'),
    ], relations=[dict(from_ref='user', to_ref='password', label='credential', basis='declared', evidence='config'), dict(from_ref='password', to_ref='host', label='service', basis='inferred', evidence='candidate only')])

def save(client, body):
    r = client.post('/intel/agent/save', json=body)
    assert r.status_code == 200, r.text
    return r.json()

def test_bidirectional_scoped_query_secret_history_and_restart(client, tmp_path, settings):
    ctx = context(tmp_path)
    body = discovery(ctx)
    receipt = save(client, body)
    wid = receipt['workspace_id']
    ids = {e['ref']: e['id'] for e in receipt['entities']}
    r = client.post('/intel/agent/query', json=dict(context=ctx, category='credentials')).json()
    assert len(r['items']) == 2
    assert 'sensitive-fixture' not in json.dumps(r)
    assert client.post('/intel/agent/query', json=dict(context=ctx, include_secrets=True)).status_code == 422
    r = client.post('/intel/agent/query', json=dict(context=ctx, ids=[ids['password']], include_secrets=True, include_details=True)).json()
    assert r['items'][0]['secret'] == 'sensitive-fixture-482!'
    assert r['items'][0]['latest_observation']['session_id'] == 'explore-1'
    assert len(r['items'][0]['details']['relations']) == 2
    other = context(tmp_path, 'other')
    assert client.post('/intel/agent/query', json=dict(context=other, ids=[ids['password']], include_secrets=True)).status_code == 404
    events = client.get(f'/intel/workspaces/{wid}/activity').json()['items']
    assert any(x['operation'] == 'read_secret' for x in events)
    assert all('sensitive-fixture' not in json.dumps(x) for x in events)
    assert b'sensitive-fixture' not in (settings.data_dir / 'intel.sqlite').read_bytes()
    restarted = IntelStore(settings.data_dir)
    assert restarted.detail(wid, ids['password'])['entity']['has_secret']
    restarted.close()

def test_idempotency_normalization_concurrent_merge_and_rotation(client, tmp_path):
    body = discovery(context(tmp_path))
    with ThreadPoolExecutor(max_workers=4) as pool:
        receipts = list(pool.map(lambda _: save(client, body), range(4)))
    assert all(r == receipts[0] for r in receipts)
    wid = receipts[0]['workspace_id']
    assert client.post(f'/intel/workspaces/{wid}/query', json={}).json()['total'] == 3
    changed = copy.deepcopy(body)
    changed['entities'][0]['name'] = 'changed'
    assert client.post('/intel/agent/save', json=changed).status_code == 409
    changed['submission_key'] = 'next-observation'
    changed['entities'][0]['identifier'] = 'demo.test'
    result = save(client, changed)
    assert all(e['action'] == 'merged' for e in result['entities'])
    rotated = copy.deepcopy(body)
    rotated['submission_key'] = 'rotation'
    rotated['entities'][2]['secret'] = 'new-password'
    result = save(client, rotated)
    assert result['entities'][2]['action'] == 'created'
    assert client.post(f'/intel/workspaces/{wid}/query', json={}).json()['total'] == 4

def test_cross_workspace_relation_rolls_back_entire_save(client, tmp_path):
    a = save(client, discovery(context(tmp_path)))
    body = discovery(context(tmp_path, 'other'))
    body['relations'][0]['to_ref'] = a['entities'][0]['id']
    assert client.post('/intel/agent/save', json=body).status_code == 404
    query = client.post('/intel/agent/query', json=dict(context=body['context'])).json()
    assert query['total'] == 0
    events = client.get(f"/intel/workspaces/{query['workspace_id']}/activity").json()['items']
    assert any(e['outcome'] == 'failed' and e['operation'] == 'save_intel' for e in events)

def test_manual_decision_preserved_and_conflict(client, tmp_path):
    body = discovery(context(tmp_path)); receipt = save(client, body)
    wid, eid = receipt['workspace_id'], receipt['entities'][2]['id']
    url = f'/intel/workspaces/{wid}/entities/{eid}'
    patch = dict(version=1, name='password', note='human note', status='disabled', evidence='no longer use')
    assert client.patch(url, json=patch).status_code == 200
    assert client.patch(url, json=patch).status_code == 409
    body['submission_key'] = 'observed-again'
    body['entities'][2]['status'] = 'verified'
    save(client, body)
    result = client.get(url).json()
    assert result['entity']['status'] == 'disabled'
    assert result['entity']['note'] == 'human note'
    assert any(o['status'] == 'verified' for o in result['observations'])

def test_relation_only_save_and_query_pagination(client, tmp_path):
    body = discovery(context(tmp_path)); r = save(client, body)
    wid, ids = r['workspace_id'], [e['id'] for e in r['entities']]
    save(client, dict(context=body['context'], submission_key='relation-only', relations=[dict(from_ref=ids[0], to_ref=ids[1], label='owns', basis='inferred', evidence='test')]))
    first = client.post('/intel/agent/query', json=dict(context=body['context'], related_to=ids[0], limit=1)).json()
    assert first['total'] == 2 and first['next_offset'] == 1
    second = client.post('/intel/agent/query', json=dict(context=body['context'], related_to=ids[0], limit=1, offset=1)).json()
    assert first['items'][0]['id'] != second['items'][0]['id']
    assert second['next_offset'] is None
    assert all(x in ids for x in client.get(f'/intel/workspaces/{wid}/activity').json()['items'][2]['object_ids'])

def test_invalid_payload_and_audit_do_not_echo_sensitive_inputs(client, tmp_path):
    ctx = context(tmp_path)
    body = discovery(ctx)
    body['entities'][2]['unexpected'] = 'do-not-echo-this-secret'
    r = client.post('/intel/agent/save', json=body)
    assert r.status_code == 422
    assert 'do-not-echo' not in r.text
    saved = save(client, discovery(ctx))
    client.post('/intel/agent/query', json=dict(context=ctx, q='do-not-echo-this-secret'))
    assert 'do-not-echo' not in client.get(f"/intel/workspaces/{saved['workspace_id']}/activity").text
    assert client.post('/intel/agent/save', content=b'x' * (1024 * 1024 + 1), headers={'content-type': 'application/json'}).status_code == 413
    assert client.post('/intel/agent/save', content=json.dumps(discovery(ctx)), headers={'content-type': 'text/plain', 'origin': 'https://untrusted.example'}).status_code == 415

def test_workspace_canonical_binding_and_missing_key(client, tmp_path, settings):
    ctx = context(tmp_path)
    r = client.post('/intel/workspaces', json=dict(title='Custom title', path=ctx['workspace_path'])).json()
    saved = save(client, discovery(ctx))
    assert r['id'] == saved['workspace_id']
    assert next(w for w in client.get('/intel/workspaces').json()['items'] if w['id'] == r['id'])['title'] == 'Custom title'
    (settings.data_dir / 'intel.key').unlink()
    with pytest.raises(IntelError, match='intel_key_missing'):
        IntelStore(settings.data_dir)

def test_verification_requires_evidence_and_invalid_ip_atomic(client, tmp_path):
    body = discovery(context(tmp_path))
    body['entities'][0]['status'] = 'verified'
    assert client.post('/intel/agent/save', json=body).status_code == 422
    body['entities'][0]['status'] = 'observed'
    body['entities'][1] = dict(ref='user', kind='ip', name='bad', identifier='not-an-ip')
    assert client.post('/intel/agent/save', json=body).json()['error_code'] == 'invalid_ip'
    assert client.post('/intel/agent/query', json=dict(context=body['context'])).json()['total'] == 0
