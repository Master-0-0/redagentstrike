"""Workspace-scoped intelligence storage, encrypted values and metadata-only audit."""
import hashlib
import hmac
import ipaddress
import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from cryptography.fernet import Fernet
from .intel_models import Query, Save, category


def now():
    return datetime.now(timezone.utc).isoformat()

def uid():
    return uuid.uuid4().hex

def dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))

class IntelError(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
        super().__init__(code)

class IntelStore:
    def __init__(self, directory):
        self.lock = threading.RLock()
        root = Path(directory)
        root.mkdir(parents=True, exist_ok=True)
        dbpath, keypath = root / 'intel.sqlite', root / 'intel.key'
        if not keypath.exists():
            if dbpath.exists():
                raise IntelError('intel_key_missing', 503)
            temp = root / (uid() + '.key.tmp')
            fd = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(fd, 'wb') as f:
                    f.write(Fernet.generate_key())
                    f.flush()
                    os.fsync(f.fileno())
                try:
                    os.link(temp, keypath)
                except FileExistsError:
                    pass
            finally:
                temp.unlink()
        self.key = keypath.read_bytes()
        self.cipher = Fernet(self.key)
        os.chmod(keypath, 0o600)
        self.db = sqlite3.connect(str(dbpath), check_same_thread=False)
        os.chmod(dbpath, 0o600)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,title TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),identity_key TEXT NOT NULL,category TEXT NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL,identifier TEXT NOT NULL,namespace TEXT NOT NULL,secret BLOB,note BLOB NOT NULL,status TEXT NOT NULL,manual_status INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,UNIQUE(workspace_id,identity_key));
        CREATE TABLE IF NOT EXISTS relations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),from_id TEXT NOT NULL REFERENCES entities(id),to_id TEXT NOT NULL REFERENCES entities(id),label TEXT NOT NULL,basis TEXT NOT NULL,evidence BLOB NOT NULL,created_at TEXT NOT NULL,UNIQUE(workspace_id,from_id,to_id,label,basis));
        CREATE TABLE IF NOT EXISTS observations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL REFERENCES entities(id),session_id TEXT NOT NULL,owner_session_id TEXT,status TEXT NOT NULL,evidence BLOB NOT NULL,observed_at TEXT,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,owner_session_id TEXT,operation TEXT NOT NULL,outcome TEXT NOT NULL,object_ids TEXT NOT NULL,criteria TEXT NOT NULL,error_code TEXT,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS submissions(workspace_id TEXT NOT NULL,submission_key TEXT NOT NULL,digest TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(workspace_id,submission_key));
        CREATE INDEX IF NOT EXISTS entity_list ON entities(workspace_id,category,last_seen);
        CREATE INDEX IF NOT EXISTS observation_list ON observations(workspace_id,entity_id,created_at);
        CREATE INDEX IF NOT EXISTS audit_list ON audit(workspace_id,created_at);
        ''')

    def close(self):
        with self.lock:
            self.db.close()

    def encrypt(self, value):
        return self.cipher.encrypt(value.encode())

    def decrypt(self, value):
        return self.cipher.decrypt(value).decode()

    def fingerprint(self, value):
        return hmac.new(self.key, value.encode(), hashlib.sha256).hexdigest()

    def workspace(self, path, title=None):
        p = Path(path).expanduser().resolve()
        if not p.is_dir():
            raise IntelError('workspace_directory_missing')
        with self.lock, self.db:
            row = self.db.execute('SELECT * FROM workspaces WHERE path=?', (str(p),)).fetchone()
            if row:
                return dict(row)
            row = dict(id=uid(), path=str(p), title=title or p.name, created_at=now())
            self.db.execute('INSERT INTO workspaces VALUES(:id,:path,:title,:created_at)', row)
            return row

    def workspaces(self):
        with self.lock:
            return [dict(r) for r in self.db.execute('SELECT w.*, (SELECT count(*) FROM entities e WHERE e.workspace_id=w.id) AS count FROM workspaces w ORDER BY title,id')]

    def require_workspace(self, wid):
        if not self.db.execute('SELECT 1 FROM workspaces WHERE id=?', (wid,)).fetchone():
            raise IntelError('workspace_not_found', 404)

    def require_entity(self, wid, eid):
        row = self.db.execute('SELECT * FROM entities WHERE workspace_id=? AND id=?', (wid, eid)).fetchone()
        if not row:
            raise IntelError('entity_not_found', 404)
        return row

    def audit(self, wid, context, operation, outcome, ids=None, criteria=None, error=None):
        # Only controlled keys, IDs and enums. No names, queries, notes or secret values.
        self.db.execute('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?,?,?)', (uid(), wid, context.get('session_id', 'manual'), context.get('owner_session_id'), operation, outcome, dump(ids or []), dump(criteria or {}), error, now()))

    def record_failure(self, wid, context, operation, code):
        with self.lock, self.db:
            self.audit(wid, context, operation, 'failed', error=code)

    def save(self, wid, body: Save, context):
        digest = self.fingerprint(dump(dict(payload=body.model_dump(), context=context)))
        with self.lock, self.db:
            self.require_workspace(wid)
            old = self.db.execute('SELECT * FROM submissions WHERE workspace_id=? AND submission_key=?', (wid, body.submission_key)).fetchone()
            if old:
                if old['digest'] != digest:
                    raise IntelError('submission_conflict', 409)
                return json.loads(old['receipt'])
            refs, saved, rel_ids, linked_ids = {}, [], [], []
            ts = now()
            for e in body.entities:
                identifier = e.identifier.strip()
                if e.kind in {'domain', 'host'}:
                    identifier = identifier.lower().rstrip('.')
                if e.kind == 'ip':
                    try:
                        identifier = str(ipaddress.ip_address(identifier))
                    except ValueError:
                        raise IntelError('invalid_ip')
                key = self.fingerprint(dump([e.kind, e.namespace.strip(), identifier, e.secret]))
                row = self.db.execute('SELECT * FROM entities WHERE workspace_id=? AND identity_key=?', (wid, key)).fetchone()
                eid = row['id'] if row else uid()
                refs[e.ref] = eid
                if row:
                    # Preserve manual decisions; observations always keep the agent's assessment.
                    self.db.execute('UPDATE entities SET last_seen=?,version=version+1,status=? WHERE id=?', (ts, row['status'] if row['manual_status'] else e.status, eid))
                else:
                    self.db.execute('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (eid, wid, key, category(e.kind), e.kind, e.name.strip(), identifier, e.namespace.strip(), self.encrypt(e.secret) if e.secret is not None else None, self.encrypt(e.note), e.status, 0, 1, ts, ts))
                evidence = dump(dict(evidence=e.evidence, note=e.note))
                self.db.execute('INSERT INTO observations VALUES(?,?,?,?,?,?,?,?,?)', (uid(), wid, eid, context.get('session_id', 'manual'), context.get('owner_session_id'), e.status, self.encrypt(evidence), e.observed_at, ts))
                saved.append(dict(ref=e.ref, id=eid, action='merged' if row else 'created'))
            for r in body.relations:
                a, b = refs.get(r.from_ref, r.from_ref), refs.get(r.to_ref, r.to_ref)
                self.require_entity(wid, a)
                self.require_entity(wid, b)
                linked_ids.extend([a, b])
                oldrel = self.db.execute('SELECT id FROM relations WHERE workspace_id=? AND from_id=? AND to_id=? AND label=? AND basis=?', (wid, a, b, r.label, r.basis)).fetchone()
                rid = oldrel['id'] if oldrel else uid()
                if not oldrel:
                    self.db.execute('INSERT INTO relations VALUES(?,?,?,?,?,?,?,?)', (rid, wid, a, b, r.label, r.basis, self.encrypt(r.evidence), ts))
                # Retain each relation observation, even when the edge already exists.
                self.db.execute('INSERT INTO observations VALUES(?,?,?,?,?,?,?,?,?)', (uid(), wid, a, context.get('session_id', 'manual'), context.get('owner_session_id'), 'observed', self.encrypt(dump(dict(relation_id=rid, evidence=r.evidence))), None, ts))
                rel_ids.append(rid)
            receipt = dict(ok=True, workspace_id=wid, submission_key=body.submission_key, entities=saved, relation_ids=rel_ids)
            self.db.execute('INSERT INTO submissions VALUES(?,?,?,?)', (wid, body.submission_key, digest, dump(receipt)))
            self.audit(wid, context, 'save_intel', 'success', list(dict.fromkeys([s['id'] for s in saved] + linked_ids)), dict(relation_ids=rel_ids))
            return receipt

    def public(self, row, reveal=False, detail=False):
        result = {k: row[k] for k in ('id', 'workspace_id', 'category', 'kind', 'name', 'identifier', 'namespace', 'status', 'version', 'first_seen', 'last_seen')}
        result['has_secret'] = row['secret'] is not None
        latest = self.db.execute('SELECT session_id,owner_session_id,status,observed_at,created_at FROM observations WHERE workspace_id=? AND entity_id=? ORDER BY created_at DESC,id DESC LIMIT 1', (row['workspace_id'], row['id'])).fetchone()
        result['latest_observation'] = dict(latest) if latest else None
        if detail:
            result['note'] = self.decrypt(row['note'])
        if reveal and row['secret'] is not None:
            result['secret'] = self.decrypt(row['secret'])
        return result

    def query(self, wid, q: Query, context=None):
        with self.lock, self.db:
            self.require_workspace(wid)
            parts, args = ['workspace_id=?'], [wid]
            for col in ('category', 'kind', 'status'):
                value = getattr(q, col)
                if value:
                    parts.append(col + '=?')
                    args.append(value)
            if q.q:
                parts.append('(instr(lower(name),lower(?))>0 OR instr(lower(identifier),lower(?))>0 OR instr(lower(namespace),lower(?))>0)')
                args.extend([q.q] * 3)
            if q.ids:
                for eid in q.ids:
                    self.require_entity(wid, eid)
                parts.append('id IN (' + ','.join('?' for _ in q.ids) + ')')
                args.extend(q.ids)
            if q.related_to:
                self.require_entity(wid, q.related_to)
                parts.append('id IN (SELECT to_id FROM relations WHERE workspace_id=? AND from_id=? UNION SELECT from_id FROM relations WHERE workspace_id=? AND to_id=?)')
                args.extend([wid, q.related_to, wid, q.related_to])
            where = ' AND '.join(parts)
            total = self.db.execute('SELECT count(*) FROM entities WHERE ' + where, args).fetchone()[0]
            rows = self.db.execute('SELECT * FROM entities WHERE ' + where + ' ORDER BY last_seen DESC,id LIMIT ? OFFSET ?', args + [q.limit, q.offset]).fetchall()
            if context is not None or q.include_secrets:
                criteria = dict(category=q.category, kind=q.kind, status=q.status, has_search=bool(q.q), related_to=q.related_to, requested_ids=q.ids, offset=q.offset, limit=q.limit)
                self.audit(wid, context or {}, 'read_secret' if q.include_secrets else 'query_intel_lib', 'success', [r['id'] for r in rows], criteria)
            items = [self.public(r, q.include_secrets) for r in rows]
            if q.include_details:
                for item in items:
                    d = self.detail(wid, item['id'])
                    d['observations_truncated'] = d['observations_truncated'] or len(d['observations']) > 3
                    d['relations_truncated'] = d['relations_truncated'] or len(d['relations']) > 20
                    d['observations'] = d['observations'][:3]
                    d['relations'] = d['relations'][:20]
                    for o in d['observations']:
                        for k, v in o['content'].items():
                            if isinstance(v, str) and len(v) > 2000:
                                o['content'][k] = v[:2000] + '… [truncated]'
                    for r in d['relations']:
                        r['evidence'] = r['evidence'][:1000]
                    item['details'] = d
            return dict(items=items, total=total, next_offset=q.offset + len(rows) if q.offset + len(rows) < total else None)

    def detail(self, wid, eid):
        with self.lock:
            entity = self.public(self.require_entity(wid, eid), detail=True)
            relations = []
            for r in self.db.execute('SELECT * FROM relations WHERE workspace_id=? AND (from_id=? OR to_id=?) ORDER BY created_at DESC LIMIT 101', (wid, eid, eid)):
                rel = dict(r)
                rel['evidence'] = self.decrypt(rel['evidence'])
                rel['target'] = self.public(self.require_entity(wid, r['to_id'] if r['from_id'] == eid else r['from_id']))
                relations.append(rel)
            observations = []
            for r in self.db.execute('SELECT * FROM observations WHERE workspace_id=? AND entity_id=? ORDER BY created_at DESC,id DESC LIMIT 51', (wid, eid)):
                row = dict(r)
                row['content'] = json.loads(self.decrypt(row.pop('evidence')))
                observations.append(row)
            return dict(entity=entity, relations=relations[:100], relations_truncated=len(relations)>100, observations=observations[:50], observations_truncated=len(observations)>50)

    def patch(self, wid, eid, body):
        with self.lock, self.db:
            row = self.require_entity(wid, eid)
            if row['version'] != body.version:
                raise IntelError('version_conflict', 409)
            self.db.execute('UPDATE entities SET name=?,note=?,status=?,manual_status=1,version=version+1 WHERE id=?', (body.name, self.encrypt(body.note), body.status, eid))
            self.db.execute('INSERT INTO observations VALUES(?,?,?,?,?,?,?,?,?)', (uid(), wid, eid, 'manual', None, body.status, self.encrypt(dump(dict(evidence=body.evidence, note=body.note, action='manual_edit'))), None, now()))
            self.audit(wid, {}, 'edit', 'success', [eid])
            return self.detail(wid, eid)

    def activity(self, wid, offset=0, limit=50):
        with self.lock:
            self.require_workspace(wid)
            count = self.db.execute('SELECT count(*) FROM audit WHERE workspace_id=?', (wid,)).fetchone()[0]
            rows = []
            for r in self.db.execute('SELECT * FROM audit WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?', (wid, limit, offset)):
                row = dict(r)
                row['object_ids'], row['criteria'] = json.loads(row['object_ids']), json.loads(row['criteria'])
                rows.append(row)
            return dict(items=rows, total=count)
