"""Findings routes; bounded JSON, streamed uploads, inert evidence previews."""
import json
import os
from functools import partial
from fastapi import APIRouter, Request, Query
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool
from .findings import ArchiveError, fail, uid

router = APIRouter()


async def call(fn, *args, failure=None):
    try:
        return await run_in_threadpool(fn, *args)
    except ArchiveError as exc:
        if failure:
            await run_in_threadpool(failure, exc)
        return JSONResponse(status_code=exc.status, content=dict(ok=False, error_code=exc.code, message=str(exc), retryable=exc.retryable))
    except ValidationError as exc:
        fields = [str('.'.join(str(p) for p in e['loc'])) for e in exc.errors()]
        return JSONResponse(status_code=422, content=dict(ok=False, error_code='invalid_manifest', message='清单字段无效：' + ', '.join(fields), retryable=False))
    except (ValueError, TypeError, KeyError):
        return JSONResponse(status_code=422, content=dict(ok=False, error_code='invalid_manifest', message='清单结构无效', retryable=False))
    except OSError:
        if failure:
            await run_in_threadpool(failure, ArchiveError('storage_unavailable', '证据存储不可用', 503, True))
        return JSONResponse(status_code=503, content=dict(ok=False, error_code='storage_unavailable', message='证据存储不可用', retryable=True))


def store(request):
    return request.app.state.wb.findings


async def bounded_json(request):
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > request.app.state.wb.settings.findings_manifest_limit:
            fail('payload_too_large', 'JSON 清单超过限额', 413)
    try:
        value = json.loads(body)
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, UnicodeError):
        fail('invalid_manifest', '需要 JSON 对象', 422)


async def json_action(request, fn):
    try:
        body = await bounded_json(request)
    except ArchiveError as exc:
        return JSONResponse(status_code=exc.status, content=dict(ok=False, error_code=exc.code, message=str(exc), retryable=False))
    return await call(fn, body)


@router.post('/finding-submissions')
async def prepare(request: Request):
    return await json_action(request, store(request).prepare)


@router.get('/finding-submissions/{sid}')
async def progress(sid: str, request: Request):
    return await call(store(request).submission, sid)


@router.put('/finding-submissions/{sid}/artifacts/{cid}')
async def upload(sid: str, cid: str, request: Request):
    archive = store(request)
    a = await call(archive.upload_info, sid, cid)
    if isinstance(a, JSONResponse):
        return a
    temp = archive.root / '.uploads' / uid()
    try:
        # A private temporary file is never promoted before hash/size verification.
        stream = await run_in_threadpool(partial(open, temp, 'xb'))
        await run_in_threadpool(os.chmod, temp, 0o600)
        size = 0
        try:
            async for chunk in request.stream():
                size += len(chunk)
                if size > min(a['size'], archive.settings.findings_file_limit):
                    fail('payload_too_large', '上传超过声明大小或 Findings 限额：' + cid, 413)
                await run_in_threadpool(stream.write, chunk)
            await run_in_threadpool(stream.flush)
            await run_in_threadpool(os.fsync, stream.fileno())
        finally:
            await run_in_threadpool(stream.close)
        return await call(archive.accept_upload, sid, cid, temp, request.headers.get('content-type', 'application/octet-stream'), failure=partial(archive.record_failure, sid))
    except ArchiveError as exc:
        return JSONResponse(status_code=exc.status, content=dict(ok=False, error_code=exc.code, message=str(exc), retryable=exc.retryable))
    except OSError:
        return JSONResponse(status_code=503, content=dict(ok=False, error_code='storage_unavailable', message='上传存储失败', retryable=True))
    finally:
        try:
            await run_in_threadpool(temp.unlink, True)
        except OSError:
            pass


@router.post('/finding-submissions/{sid}/commit')
async def commit(sid: str, request: Request):
    return await call(store(request).commit, sid, failure=partial(store(request).record_failure, sid))


@router.get('/findings')
async def listing(request: Request, page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)):
    return await call(store(request).listing, dict(request.query_params), page, page_size)


@router.get('/findings/{fid}')
async def detail(fid: str, request: Request):
    return await call(store(request).detail, fid)


@router.patch('/findings/{fid}')
async def patch(fid: str, request: Request):
    return await json_action(request, partial(store(request).patch, fid))


def read_preview(path):
    with path.open('rb') as stream:
        body = stream.read(65537)
    return dict(text=body[:65536].decode('utf-8', errors='replace'), truncated=len(body) > 65536)


@router.get('/findings/{fid}/artifacts/{aid}')
async def artifact(fid: str, aid: str, request: Request, preview: bool = False):
    result = await call(store(request).artifact, fid, aid)
    if isinstance(result, JSONResponse):
        return result
    a, path = result
    headers = {'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'no-store'}
    if preview and a['kind'] != 'attachment' and a['media_type'] in ('image/png', 'image/jpeg'):
        return FileResponse(path, media_type=a['media_type'], headers=headers)
    if preview and a['kind'] != 'attachment' and (a['media_type'].startswith('text/') or a['media_type'] == 'application/json'):
        return JSONResponse(await run_in_threadpool(read_preview, path), headers=headers)
    # HTML, SVG, executables and unrecognized types are always inert downloads.
    return FileResponse(path, media_type='application/octet-stream', filename=a['filename'], headers=headers)


@router.post('/findings/export')
async def export_report(request: Request):
    from .findings_report import render_report, report_evidence

    def generate(body):
        ids = body.get('finding_ids')
        format = body.get('format')
        if format not in ('docx', 'pdf') or not isinstance(ids, list) or not 1 <= len(ids) <= 100 or any(not isinstance(i, str) or not i or len(i) > 128 for i in ids):
            fail('invalid_export', '请选择 1 至 100 项成果和 DOCX 或 PDF 格式', 422)
        archive = store(request)
        findings = [archive.detail(fid) for fid in dict.fromkeys(ids)]
        report_evidence(archive, findings)
        content = render_report(findings, format)
        media = 'application/pdf' if format == 'pdf' else 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        return Response(content, media_type=media, headers={'Content-Disposition': f'attachment; filename="findings-report.{format}"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})

    return await json_action(request, generate)
