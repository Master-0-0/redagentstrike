"""Durable two-phase archive. SQLite owns visibility; fixed IDs recover moves."""
from __future__ import annotations
import errno
import fcntl
import hashlib
import json
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from .findings_models import Manifest, Finding


def now():
    return datetime.now(timezone.utc).isoformat()


def uid():
    return uuid.uuid4().hex


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


class ArchiveError(Exception):
    def __init__(self, code, message, status=400, retryable=False):
        super().__init__(message)
        self.code, self.status, self.retryable = code, status, retryable


def fail(code, message, status=400, retryable=False):
    raise ArchiveError(code, message, status, retryable)


def sync_dir(path):
    fd = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''):
            digest.update(chunk)
    return digest.hexdigest()


class FindingsStore:
    def __init__(self, settings, net):
        self.settings, self.net = settings, net
        self.root = settings.data_dir / 'findings'
        self.lock = threading.RLock()
        self.db = None
        self.available = False
        try:
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            (self.root / '.staging').mkdir(exist_ok=True, mode=0o700)
            (self.root / '.uploads').mkdir(exist_ok=True, mode=0o700)
            self.db = sqlite3.connect(str(settings.data_dir / 'findings.sqlite'), check_same_thread=False)
            os.chmod(settings.data_dir / 'findings.sqlite', 0o600)
            self.db.row_factory = sqlite3.Row
            self.db.execute('PRAGMA foreign_keys=ON')
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.execute('PRAGMA busy_timeout=10000')
            if self.db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise sqlite3.DatabaseError('integrity check failed')
            version = self.db.execute('PRAGMA user_version').fetchone()[0]
            if version > 1:
                raise sqlite3.DatabaseError('unsupported findings schema')
            if version == 0:
                self.db.executescript('''
                BEGIN IMMEDIATE;
                CREATE TABLE findings(id TEXT PRIMARY KEY, document TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE finding_sources(id TEXT PRIMARY KEY, finding_id TEXT NOT NULL REFERENCES findings(id), document TEXT NOT NULL);
                CREATE TABLE finding_artifacts(id TEXT PRIMARY KEY, finding_id TEXT NOT NULL REFERENCES findings(id), submission_id TEXT NOT NULL, document TEXT NOT NULL);
                CREATE TABLE finding_network_refs(finding_id TEXT NOT NULL REFERENCES findings(id), artifact_id TEXT NOT NULL, event_id TEXT NOT NULL, run_id TEXT NOT NULL);
                CREATE TABLE finding_evidence_gaps(id TEXT PRIMARY KEY, finding_id TEXT NOT NULL REFERENCES findings(id), document TEXT NOT NULL);
                CREATE TABLE finding_submissions(id TEXT PRIMARY KEY, submission_key TEXT UNIQUE NOT NULL, digest TEXT NOT NULL, document TEXT NOT NULL);
                CREATE TABLE finding_history(id TEXT PRIMARY KEY, finding_id TEXT NOT NULL REFERENCES findings(id), document TEXT NOT NULL);
                CREATE INDEX artifact_finding ON finding_artifacts(finding_id);
                CREATE INDEX source_finding ON finding_sources(finding_id);
                PRAGMA user_version=1;
                COMMIT;
                ''')
            self.available = True
            # Check recovery candidates without making them visible or auto-committing.
            with self.guard():
                for row in self.db.execute('SELECT document FROM finding_submissions').fetchall():
                    s = json.loads(row[0])
                    if s['status'] != 'committed':
                        for a in s['artifacts']:
                            path = self.directory(s) / a['id']
                            if path.exists() and a['sha256'] and (path.stat().st_size != a['size'] or file_hash(path) != a['sha256']):
                                self.failed(s, ArchiveError('hash_mismatch', 'recovery integrity check failed', 409))
                                break
        except (OSError, sqlite3.Error, ArchiveError):
            self.available = False

    def close(self):
        if self.db:
            self.db.close()

    @contextmanager
    def guard(self):
        if not self.available:
            fail('storage_unavailable', '成果归档存储不可用；原数据库已保留', 503, True)
        with self.lock:
            try:
                with (self.root / '.lock').open('a') as lockfile:
                    os.chmod(lockfile.name, 0o600)
                    fcntl.flock(lockfile, fcntl.LOCK_EX)
                    try:
                        yield
                    except Exception:
                        self.db.rollback()
                        raise
                    finally:
                        fcntl.flock(lockfile, fcntl.LOCK_UN)
            except (OSError, sqlite3.Error) as exc:
                fail('disk_full' if getattr(exc, 'errno', None) == errno.ENOSPC else 'storage_unavailable', '证据存储操作失败；请修复存储后重试', 503, True)

    def _submission(self, sid):
        row = self.db.execute('SELECT document FROM finding_submissions WHERE id=?', (sid,)).fetchone()
        if not row:
            fail('submission_missing', '提交不存在', 404)
        return json.loads(row[0])

    def save_submission(self, s):
        self.db.execute('UPDATE finding_submissions SET document=? WHERE id=?', (packed(s), s['id']))
        self.db.commit()

    def failed(self, s, error):
        s.update(status='failed', error={'error_code': error.code, 'message': str(error), 'retryable': error.retryable})
        self.save_submission(s)

    def directory(self, s):
        final = self.root / s['finding_id'] / s['id']
        return final if final.exists() else self.root / '.staging' / s['id']

    def _detail(self, fid):
        row = self.db.execute('SELECT * FROM findings WHERE id=?', (fid,)).fetchone()
        if not row:
            fail('finding_missing', '成果不存在', 404)
        value = json.loads(row['document'])
        value.update(id=fid, version=row['version'], created_at=row['created_at'], updated_at=row['updated_at'])
        for name in ('sources', 'artifacts', 'evidence_gaps', 'history'):
            value[name] = [json.loads(r[0]) for r in self.db.execute('SELECT document FROM finding_' + name + ' WHERE finding_id=? ORDER BY rowid', (fid,))]
        return value

    def references(self, manifest, finding):
        if manifest['op'] == 'create':
            kinds = {a['kind'] for a in manifest['artifacts']}
            present = {
                'poc': 'poc' in kinds,
                'http': bool(manifest['network_refs']) or bool(kinds & {'http_request', 'http_response'}),
                'screenshot': bool(kinds & {'browser_screenshot', 'response_screenshot'}),
                'tool_output': 'tool_output' in kinds,
            }
            declared = {g['category'] for g in manifest['evidence_gaps']}
            missing = [category for category, exists in present.items() if not exists and category not in declared]
            if missing:
                fail('invalid_manifest', '缺失材料必须声明 missing 或 not_applicable：' + ', '.join(missing))
        steps = {s['id'] for s in finding['steps']}
        for artifact in manifest['artifacts'] + manifest['network_refs']:
            if any(s not in steps for s in artifact['step_ids']):
                fail('invalid_manifest', '附件引用了不存在的复现步骤')
        if manifest['op'] == 'append':
            gaps = {g['id'] for g in finding['evidence_gaps']}
            if any(g not in gaps for g in manifest['resolved_gap_ids']):
                fail('invalid_manifest', '缺口不属于此成果')

    def prepare(self, raw):
        parsed = Manifest.model_validate(raw)
        m = parsed.model_dump()
        digest = hashlib.sha256(packed({k: v for k, v in raw.items() if k not in ('submission_key', 'content_digest')}).encode()).hexdigest()
        if m['content_digest'] and m['content_digest'] != digest:
            fail('invalid_manifest', '内容摘要不匹配')
        limits = self.settings
        if len(m['artifacts']) > limits.findings_max_files or len(m['network_refs']) > limits.findings_max_network_refs or any(a['size'] > limits.findings_file_limit for a in m['artifacts']) or sum(a['size'] for a in m['artifacts']) > limits.findings_total_limit:
            fail('payload_too_large', '附件清单超过 Findings 限额', 413)
        with self.guard():
            row = self.db.execute('SELECT document, digest FROM finding_submissions WHERE submission_key=?', (m['submission_key'],)).fetchone()
            if row:
                if row['digest'] != digest:
                    fail('idempotency_conflict', '此 submission_key 已用于不同内容', 409)
                s = json.loads(row['document'])
                if s['status'] == 'committed':
                    return self.progress(s)
                if s.get('error') and not s['error']['retryable']:
                    fail(**self.error_args(s['error']))
            else:
                finding = m['finding'] if m['op'] == 'create' else self._detail(m['finding_id'])
                self.references(m, finding)
                s = dict(id=uid(), finding_id=m['finding_id'] or uid(), submission_key=m['submission_key'], manifest=m, status='prepared', last_completed_stage='prepared', created_at=now(), artifacts=[], receipt=None, error=None)
                for a in m['artifacts']:
                    s['artifacts'].append(dict(a, id=uid(), archived_at=now(), representation='file_bytes', fidelity='unknown', truncation='unknown', redaction='unknown', platform_validation='size_sha256_media_type'))
                for ref in m['network_refs']:
                    s['artifacts'].append(dict(id=uid(), client_id='network-' + uid(), kind='http_snapshot', filename='http-snapshot.json', size=0, sha256='', media_type='application/json', description='解析后的 HTTP 快照，不保证原始线上字节', step_ids=ref['step_ids'], capture_method='NetStore.get', captured_at=None, archived_at=now(), representation='parsed_snapshot', fidelity='transformed', truncation='unknown', redaction='unknown', platform_validation='event_id_run_id', network_ref=ref))
                self.db.execute('INSERT INTO finding_submissions VALUES (?,?,?,?)', (s['id'], s['submission_key'], digest, packed(s)))
                self.db.commit()
            try:
                self.snapshot_network(s)
                s['error'] = None
                s['status'] = 'uploading' if any((self.directory(s) / a['id']).exists() for a in s['artifacts']) else 'prepared'
                self.save_submission(s)
            except ArchiveError as exc:
                self.failed(s, exc)
                raise
            return self.progress(s)

    @staticmethod
    def error_args(error):
        return dict(code=error['error_code'], message=error['message'], status=409, retryable=error['retryable'])

    def snapshot_network(self, s):
        directory = self.directory(s)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        for a in s['artifacts']:
            if a['kind'] != 'http_snapshot':
                continue
            if a['sha256'] and (directory / a['id']).is_file():
                continue
            ref = a['network_ref']
            try:
                event = self.net.get(ref['event_id'])
            except Exception:
                fail('storage_unavailable', '网络事件存储不可用', 503, True)
            if event is None:
                fail('network_event_missing', '网络事件不存在：' + ref['event_id'])
            if event.run_id != ref['run_id']:
                fail('network_run_mismatch', '网络事件与 Run 不一致')
            body = packed(asdict(event)).encode()
            if len(body) > self.settings.findings_file_limit or sum(item['size'] for item in s['artifacts'] if item['id'] != a['id']) + len(body) > self.settings.findings_total_limit:
                fail('payload_too_large', '网络快照超过 Findings 字节预算', 413)
            digest = hashlib.sha256(body).hexdigest()
            if a['sha256'] and a['sha256'] != digest:
                fail('hash_mismatch', '网络事件内容已改变；原快照写入未完成', 409)
            a.update(size=len(body), sha256=digest, captured_at=event.ts)
            # Persist the intended hash before publishing bytes. A crash after rename
            # can then recover without touching the original network event.
            self.save_submission(s)
            path = directory / a['id']
            temp = directory / (uid() + '.tmp')
            with temp.open('xb') as out:
                os.chmod(temp, 0o600)
                out.write(body)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temp, path)
            sync_dir(directory)
            self.save_submission(s)
        if s['last_completed_stage'] == 'prepared':
            s['last_completed_stage'] = 'network_snapshotted'

    def progress(self, s):
        received = [a['client_id'] for a in s['artifacts'] if (self.directory(s) / a['id']).is_file()]
        return dict(id=s['id'], submission_key=s['submission_key'], status=s['status'], finding_id=s['finding_id'], received=received, receipt=s['receipt'], error=s.get('error'), last_completed_stage=s['last_completed_stage'])

    def record_failure(self, sid, error):
        try:
            with self.guard():
                s = self._submission(sid)
                if s['status'] != 'committed':
                    self.failed(s, error)
        except ArchiveError:
            pass  # Disk errors can prevent even the failure ledger from being written.

    def submission(self, sid):
        with self.guard():
            return self.progress(self._submission(sid))

    def upload_info(self, sid, cid):
        with self.guard():
            s = self._submission(sid)
            a = next((a for a in s['artifacts'] if a['client_id'] == cid and a['kind'] != 'http_snapshot'), None)
            if not a:
                fail('invalid_manifest', '附件未在清单声明', 404)
            if s.get('error') and not s['error']['retryable']:
                fail(**self.error_args(s['error']))
            return a

    def accept_upload(self, sid, cid, temp, media_type):
        with self.guard():
            s = self._submission(sid)
            a = next(a for a in s['artifacts'] if a['client_id'] == cid)
            if temp.stat().st_size != a['size'] or file_hash(temp) != a['sha256']:
                fail('hash_mismatch', '附件大小或 SHA-256 不匹配：' + cid, 409, True)
            if media_type.split(';')[0].strip().lower() != a['media_type'].lower():
                fail('invalid_manifest', '附件媒体类型与清单不一致')
            self.validate_image(temp, a)
            directory = self.directory(s)
            destination = directory / a['id']
            if destination.exists():
                if file_hash(destination) != a['sha256']:
                    fail('integrity_error', '已有附件完整性异常', 409)
            elif s['status'] == 'committed':
                fail('integrity_error', '已归档附件丢失；禁止覆盖', 409)
            else:
                directory.mkdir(parents=True, exist_ok=True, mode=0o700)
                os.rename(temp, destination)
                sync_dir(directory)
            if s['status'] != 'committed':
                s.update(status='uploading', last_completed_stage='uploading', error=None)
                self.save_submission(s)
            return self.progress(s)

    @staticmethod
    def validate_image(path, a):
        if a['media_type'] not in ('image/png', 'image/jpeg'):
            return
        try:
            from PIL import Image
            with Image.open(path) as img:
                if img.format != ('PNG' if a['media_type'] == 'image/png' else 'JPEG'):
                    raise ValueError('format')
                img.verify()
        except Exception:
            fail('invalid_manifest', 'PNG/JPEG 图片校验失败')

    def commit(self, sid):
        with self.guard():
            s = self._submission(sid)
            if s['status'] == 'committed':
                return s['receipt']
            if s.get('error') and not s['error']['retryable']:
                fail(**self.error_args(s['error']))
            m = s['manifest']
            self.snapshot_network(s)
            finding = m['finding'] if m['op'] == 'create' else self._detail(s['finding_id'])
            self.references(m, finding)
            directory = self.directory(s)
            for a in s['artifacts']:
                path = directory / a['id']
                if not path.is_file():
                    fail('artifact_missing', '附件尚未上传：' + a['client_id'], 409, True)
                if path.stat().st_size != a['size'] or file_hash(path) != a['sha256']:
                    fail('hash_mismatch', '附件完整性检查失败：' + a['client_id'], 409)
                self.validate_image(path, a)
            final = self.root / s['finding_id'] / s['id']
            if directory != final:
                final.parent.mkdir(exist_ok=True, mode=0o700)
                os.rename(directory, final)
                sync_dir(final.parent)
                sync_dir(self.root / '.staging')
                sync_dir(self.root)
            s['last_completed_stage'] = 'files_moved'
            self.save_submission(s)
            self._commit_database(s, finding)
            return s['receipt']

    def _commit_database(self, s, finding):
        """Separate seam for crash-injection tests; caller holds both locks."""
        m, fid, stamp = s['manifest'], s['finding_id'], now()
        self.db.execute('BEGIN IMMEDIATE')
        mapping = {a['client_id']: a['id'] for a in s['artifacts']}
        if m['op'] == 'create':
            document = dict(finding, review_status='pending', remediation_status='not_started')
            document['steps'] = [dict(step, artifact_ids=[mapping[c] for c in step['artifact_client_ids']]) for step in finding['steps']]
            self.db.execute('INSERT INTO findings VALUES (?,?,?,?,?)', (fid, packed(document), 1, stamp, stamp))
        else:
            self.db.execute('UPDATE findings SET version=version+1, updated_at=? WHERE id=?', (stamp, fid))
        source = dict(m['source'], id=uid(), submission_id=s['id'], created_at=stamp)
        self.insert('sources', source, fid)
        for a in s['artifacts']:
            a = dict(a, finding_id=fid, submission_id=s['id'], storage_key=str(Path(fid) / s['id'] / a['id']))
            if m['finding']:
                a['step_ids'] = list(dict.fromkeys(a['step_ids'] + [step['id'] for step in m['finding']['steps'] if a['client_id'] in step['artifact_client_ids']]))
            self.db.execute('INSERT INTO finding_artifacts VALUES (?,?,?,?)', (a['id'], fid, s['id'], packed(a)))
            if a.get('network_ref'):
                self.db.execute('INSERT INTO finding_network_refs VALUES (?,?,?,?)', (fid, a['id'], a['network_ref']['event_id'], a['network_ref']['run_id']))
        for gap in m['evidence_gaps']:
            self.insert('evidence_gaps', dict(gap, id=uid(), created_at=stamp, resolved_at=None), fid)
        for gid in m['resolved_gap_ids']:
            row = self.db.execute('SELECT document FROM finding_evidence_gaps WHERE id=? AND finding_id=?', (gid, fid)).fetchone()
            gap = json.loads(row[0])
            if not gap['resolved_at']:
                gap.update(resolved_at=stamp, resolved_by_submission=s['id'])
                self.db.execute('UPDATE finding_evidence_gaps SET document=? WHERE id=?', (packed(gap), gid))
        self.insert('history', dict(id=uid(), operation=m['op'], actor=m['source']['source_type'], note=m['note'], submission_id=s['id'], artifact_mapping=mapping, created_at=stamp), fid)
        detail = self._detail(fid)
        warnings = ['网络快照为解析结果，不保证原始字节；事件与会话的归属仍需人工复核'] if m['network_refs'] else []
        if detail['agent_assessment'] == 'reproduced' and not any(a['kind'] in ('http_snapshot', 'http_response', 'tool_output', 'browser_screenshot', 'response_screenshot') for a in detail['artifacts']):
            warnings.append('Agent 声明已复现，但缺少附件支持；保持待人工复核')
        s['receipt'] = dict(ok=True, submission_key=s['submission_key'], finding_id=fid, review_status=detail['review_status'], saved_artifacts=len(s['artifacts']), evidence_gaps=detail['evidence_gaps'], warnings=warnings)
        s.update(status='committed', last_completed_stage='committed', error=None)
        self.db.execute('UPDATE finding_submissions SET document=? WHERE id=?', (packed(s), s['id']))
        self.db.commit()

    def insert(self, table, value, fid):
        self.db.execute('INSERT INTO finding_' + table + ' VALUES (?,?,?)', (value['id'], fid, packed(value)))

    def detail(self, fid):
        with self.guard():
            result = self._detail(fid)
            for a in result['artifacts']:
                path = self.root / a['storage_key']
                a['integrity'] = 'ok' if path.is_file() and path.stat().st_size == a['size'] and file_hash(path) == a['sha256'] else 'error'
                a.pop('storage_key', None)
            return result

    def listing(self, filters, page, page_size):
        with self.guard():
            clauses, args = [], []
            for key in ('severity', 'review_status', 'remediation_status'):
                if filters.get(key):
                    clauses.append("json_extract(f.document, '$." + key + "')=?")
                    args.append(filters[key])
            if filters.get('q'):
                clauses.append("(json_extract(f.document,'$.title') LIKE ? OR json_extract(f.document,'$.target') LIKE ? OR json_extract(f.document,'$.summary') LIKE ?)")
                args.extend(['%' + filters['q'] + '%'] * 3)
            for key in ('workspace_id', 'session_id'):
                if filters.get(key):
                    clauses.append("EXISTS (SELECT 1 FROM finding_sources s WHERE s.finding_id=f.id AND json_extract(s.document, '$." + key + "')=?)")
                    args.append(filters[key])
            if filters.get('run_id'):
                clauses.append('EXISTS (SELECT 1 FROM finding_network_refs n WHERE n.finding_id=f.id AND n.run_id=?)')
                args.append(filters['run_id'])
            for key, op in (('since', '>='), ('until', '<=')):
                if filters.get(key):
                    clauses.append('f.created_at ' + op + ' ?')
                    args.append(filters[key])
            where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
            total = self.db.execute('SELECT count(*) FROM findings f' + where, args).fetchone()[0]
            rows = self.db.execute('SELECT f.* FROM findings f' + where + ' ORDER BY f.created_at DESC, f.id DESC LIMIT ? OFFSET ?', args + [page_size, (page - 1) * page_size]).fetchall()
            items = []
            for row in rows:
                d = json.loads(row['document'])
                item = {k: d[k] for k in ('title', 'target', 'severity', 'review_status', 'remediation_status')}
                item.update(id=row['id'], summary=d['summary'][:500], version=row['version'], created_at=row['created_at'])
                item['artifact_count'] = self.db.execute('SELECT count(*) FROM finding_artifacts WHERE finding_id=?', (row['id'],)).fetchone()[0]
                item['gap_count'] = self.db.execute("SELECT count(*) FROM finding_evidence_gaps WHERE finding_id=? AND json_extract(document,'$.resolved_at') IS NULL AND json_extract(document,'$.status')='missing'", (row['id'],)).fetchone()[0]
                item['sources'] = [{k: v for k, v in json.loads(r[0]).items() if k in ('source_type', 'workspace_id', 'session_id')} for r in self.db.execute('SELECT document FROM finding_sources WHERE finding_id=?', (row['id'],))]
                items.append(item)
            return dict(items=items, total=total, page=page, page_size=page_size)

    def patch(self, fid, raw):
        allowed = set(Finding.model_fields) | {'review_status', 'remediation_status'}
        if set(raw) - {'version', 'changes', 'note'} or type(raw.get('version')) is not int or not isinstance(raw.get('changes'), dict) or not isinstance(raw.get('note', ''), str):
            fail('invalid_manifest', '编辑需要 version、changes 和可选 note')
        changes = raw['changes']
        if set(changes) - allowed:
            fail('invalid_manifest', '不能修改附件或系统字段')
        if 'review_status' in changes and changes['review_status'] not in ('pending', 'confirmed', 'false_positive'):
            fail('invalid_manifest', '无效的人工复核状态')
        if 'remediation_status' in changes and changes['remediation_status'] not in ('not_started', 'in_progress', 'fixed', 'retest_passed', 'not_applicable'):
            fail('invalid_manifest', '无效的修复状态')
        with self.guard():
            old = self._detail(fid)
            if raw['version'] != old['version']:
                fail('version_conflict', '成果已更新，请重新加载后编辑', 409)
            document = {k: old[k] for k in allowed}
            document.update(changes)
            clean = {k: document[k] for k in Finding.model_fields}
            if not isinstance(clean['steps'], list) or not all(isinstance(step, dict) for step in clean['steps']):
                fail('invalid_manifest', 'steps 必须是步骤对象数组')
            if 'steps' in changes and any('artifact_ids' in step for step in changes['steps']):
                fail('invalid_manifest', '附件关联只能由归档协议生成')
            clean['steps'] = [{k: v for k, v in s.items() if k != 'artifact_ids'} for s in clean['steps']]
            validated = Finding.model_validate(clean)
            ids = [s.id for s in validated.steps]
            if len(ids) != len(set(ids)):
                fail('invalid_manifest', '步骤 ID 不可重复')
            if 'steps' in changes and any(s.artifact_client_ids for s in validated.steps):
                fail('invalid_manifest', '编辑步骤不能新增提交附件引用；请通过追加协议关联证据')
            stamp = now()
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('UPDATE findings SET document=?, version=version+1, updated_at=? WHERE id=?', (packed(document), stamp, fid))
            self.insert('history', dict(id=uid(), operation='edit', actor='human', before={k: old[k] for k in changes}, after=changes, note=raw.get('note', ''), created_at=stamp), fid)
            self.db.commit()
            return self._detail(fid)

    def artifact(self, fid, aid):
        with self.guard():
            row = self.db.execute('SELECT document FROM finding_artifacts WHERE id=? AND finding_id=?', (aid, fid)).fetchone()
            if not row:
                fail('artifact_missing', '附件不存在', 404)
            a = json.loads(row[0])
            path = self.root / a['storage_key']
            if not path.is_file() or path.stat().st_size != a['size'] or file_hash(path) != a['sha256']:
                fail('integrity_error', '已归档附件完整性异常', 409)
            return a, path
