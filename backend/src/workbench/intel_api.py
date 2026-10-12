"""Local intelligence API; runtime context is independent of Cairn facts."""
import json
import sqlite3
from fastapi import APIRouter, Request, Query as Param
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from cryptography.fernet import InvalidToken
from starlette.concurrency import run_in_threadpool
from .blackboards import list_blackboards
from .intel import IntelError
from .intel_models import AgentQuery, AgentSave, Query, Save, Workspace, Patch

router = APIRouter(prefix='/intel')

def store(request):
    st = request.app.state.wb.intel
    if st is None:
        raise IntelError('intel_storage_unavailable', 503)
    return st

async def payload(request, model):
    if request.headers.get('content-type', '').split(';', 1)[0].strip().lower() != 'application/json':
        raise IntelError('json_content_type_required', 415)
    data = bytearray()
    async for part in request.stream():
        data.extend(part)
        if len(data) > 1024 * 1024:
            raise IntelError('payload_too_large', 413)
    try:
        return model.model_validate(json.loads(data))
    except (ValueError, ValidationError):
        # Never echo Pydantic input, which could contain a password.
        raise IntelError('invalid_intel_payload', 422)

async def action(request, fn, model=None, wid=None, op=None):
    context, resolved = {}, wid
    try:
        st = store(request)
        body = await payload(request, model) if model else None
        if isinstance(body, (AgentQuery, AgentSave)):
            context = body.context.model_dump()
            resolved = (await run_in_threadpool(st.workspace, context['workspace_path']))['id']
        return JSONResponse(await run_in_threadpool(fn, st, body, resolved, context), headers={'Cache-Control': 'no-store'})
    except IntelError as e:
        code, status = e.code, e.status
    except (OSError, sqlite3.Error, InvalidToken):
        code, status = 'intel_storage_unavailable', 503
    if resolved and op:
        try:
            await run_in_threadpool(store(request).record_failure, resolved, context, op, code)
        except (IntelError, OSError, sqlite3.Error):
            pass
    return JSONResponse(dict(ok=False, error_code=code, message=code, retryable=status>=500), status_code=status, headers={'Cache-Control': 'no-store'})

@router.get('/workspaces')
async def workspaces(request: Request):
    def listing(st, *_):
        # Existing Harness workspaces appear automatically; inaccessible directories are skipped.
        for w in list_blackboards(request.app.state.wb.settings.dsh_home)['workspaces']:
            try:
                st.workspace(w['path'], w['title'])
            except (IntelError, OSError):
                pass
        return dict(items=st.workspaces())
    return await action(request, listing)

@router.post('/workspaces')
async def create_workspace(request: Request):
    return await action(request, lambda st, b, *_: st.workspace(b.path, b.title, restore=True), Workspace)

@router.delete('/workspaces/{wid}')
async def delete_workspace(wid: str, request: Request):
    return await action(request, lambda st, b, w, c: st.delete_workspace(w), wid=wid)

@router.post('/workspaces/{wid}/query')
async def query(wid: str, request: Request):
    return await action(request, lambda st, b, w, _: st.query(w, b), Query, wid, 'query')

@router.post('/workspaces/{wid}/save')
async def save(wid: str, request: Request):
    return await action(request, lambda st, b, w, c: st.save(w, b, c), Save, wid, 'save_intel')

@router.get('/workspaces/{wid}/entities/{eid}')
async def detail(wid: str, eid: str, request: Request):
    return await action(request, lambda st, b, w, c: st.detail(w, eid), wid=wid)

@router.patch('/workspaces/{wid}/entities/{eid}')
async def patch(wid: str, eid: str, request: Request):
    return await action(request, lambda st, b, w, c: st.patch(w, eid, b), Patch, wid, 'edit')

@router.get('/workspaces/{wid}/activity')
async def activity(wid: str, request: Request, offset: int = Param(0, ge=0), limit: int = Param(50, ge=1, le=100)):
    return await action(request, lambda st, b, w, c: st.activity(w, offset, limit), wid=wid)

@router.post('/agent/query')
async def agent_query(request: Request):
    return await action(request, lambda st, b, w, c: dict(workspace_id=w, **st.query(w, Query.model_validate(b.model_dump(exclude={'context'})), c)), AgentQuery, op='query_intel_lib')

@router.post('/agent/save')
async def agent_save(request: Request):
    return await action(request, lambda st, b, w, c: st.save(w, Save.model_validate(b.model_dump(exclude={'context'})), c), AgentSave, op='save_intel')
