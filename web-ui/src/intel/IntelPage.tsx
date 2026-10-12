import { useEffect, useRef, useState } from 'react'
import { bases, categories, groupKinds, intel, kinds, post, sensitive, statuses, time } from './api'
import type { Activity, Category, Detail, Entity, Kind, Status, View, Workspace } from './api'
import './intel.css'

const message = (e: unknown) => e instanceof Error ? e.message : '请求失败'
const operations: Record<string, string> = { save_intel: '保存发现', query_intel_lib: '查询摘要', read_secret: '读取原值', edit: '人工修改', query: '查询' }

export function IntelPage() {
  const catalogVersion = useRef(0)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [selected, setSelected] = useState(() => localStorage.getItem('intel-workspace') || '')
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let running = false
    const pull = async () => {
      if (running || document.hidden) return
      running = true
      try {
        const version = catalogVersion.current
        const data = await intel<{ items: Workspace[] }>('/workspaces', { signal: controller.signal })
        if (controller.signal.aborted || version !== catalogVersion.current) return
        setWorkspaces(data.items)
        setSelected(old => data.items.some(w => w.id === old) ? old : data.items[0]?.id || '')
        setError('')
      } catch (e) { if (!controller.signal.aborted) setError(message(e)) }
      finally { running = false; if (!controller.signal.aborted) setLoading(false) }
    }
    void pull()
    const timer = window.setInterval(pull, 5000)
    document.addEventListener('visibilitychange', pull)
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', pull) }
  }, [refresh])
  useEffect(() => { if (selected) localStorage.setItem('intel-workspace', selected); else localStorage.removeItem('intel-workspace') }, [selected])
  const workspace = workspaces.find(w => w.id === selected)
  return <section className="intel-shell">
    <aside className="intel-workspaces" aria-label="情报工作区导航">
      <div className="intel-eyebrow">INTELLIGENCE</div><h1>情报资产库</h1>
      <input aria-label="搜索工作区" placeholder="搜索工作区…" value={filter} onChange={e => setFilter(e.target.value)} />
      <div className="intel-workspace-list">
        {workspaces.filter(w => (w.title + w.path).toLowerCase().includes(filter.toLowerCase())).map(w => <button key={w.id} className={selected === w.id ? 'selected' : ''} onClick={() => setSelected(w.id)} aria-pressed={selected === w.id}><strong>{w.title}</strong><small>{w.path}</small><span>{w.count} 条情报</span></button>)}
        {!loading && !workspaces.length && <p className="intel-muted">暂无工作区。新建或等待 Agent 首次调用。</p>}
      </div>
      <button onClick={() => setCreating(true)}>＋ 新建工作区</button>
      <small>自动接入已有 Harness 工作区，以执行目录关联情报。</small>
    </aside>
    <div className="intel-main">
      {error && <div role="alert" className="intel-error">{error}<button onClick={() => setRefresh(r => r + 1)}>重试</button></div>}
      {workspace ? <WorkspacePanel key={workspace.id} workspace={workspace} onDeleted={() => { catalogVersion.current += 1; setWorkspaces(old => old.filter(w => w.id !== workspace.id)); setSelected(workspaces.find(w => w.id !== workspace.id)?.id || ''); setRefresh(r => r + 1) }} /> : <div className="intel-empty"><h2>{loading ? '正在加载工作区…' : '选择或创建一个工作区'}</h2><p>资产、凭据、身份与 Agent 读写记录按工作区组织。</p></div>}
    </div>
    {creating && <WorkspaceForm onClose={() => setCreating(false)} onSaved={w => { setSelected(w.id); setWorkspaces(old => [...old.filter(x => x.id !== w.id), { ...w, count: 0 }]); setCreating(false); setRefresh(r => r + 1) }} />}
  </section>
}

function WorkspacePanel({ workspace, onDeleted }: { workspace: Workspace; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false)
  const base = '/workspaces/' + workspace.id
  const [view, setView] = useState<View>('assets')
  const [q, setQ] = useState(''), [kind, setKind] = useState(''), [status, setStatus] = useState('')
  const [offset, setOffset] = useState(0), [selected, setSelected] = useState('')
  const [rows, setRows] = useState<Entity[]>([]), [events, setEvents] = useState<Activity[]>([])
  const [total, setTotal] = useState(0), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0), [creating, setCreating] = useState(false)
  const [updated, setUpdated] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let running = false
    setLoading(true); setRows([]); setEvents([]); setTotal(0)
    const pull = async () => {
      if (document.hidden || running) return
      running = true
      try {
        if (view === 'activity') {
          const data = await intel<{ items: Activity[]; total: number }>(base + `/activity?offset=${offset}&limit=30`, { signal: controller.signal })
          if (controller.signal.aborted) return
          setEvents(data.items); setTotal(data.total)
        } else {
          const data = await intel<{ items: Entity[]; total: number }>(base + '/query', { ...post({ category: view, q, ...(kind ? { kind } : {}), ...(status ? { status } : {}), offset, limit: 30 }), signal: controller.signal })
          if (controller.signal.aborted) return
          setRows(data.items); setTotal(data.total)
        }
        setError(''); setUpdated(new Date().toLocaleTimeString())
      } catch (e) { if (!controller.signal.aborted) setError(message(e)) }
      finally { running = false; if (!controller.signal.aborted) setLoading(false) }
    }
    const start = window.setTimeout(pull, 180), timer = window.setInterval(pull, 5000)
    document.addEventListener('visibilitychange', pull)
    return () => { controller.abort(); clearTimeout(start); clearInterval(timer); document.removeEventListener('visibilitychange', pull) }
  }, [base, view, q, kind, status, offset, refresh])
  const switchView = (next: View) => { setView(next); setQ(''); setKind(''); setStatus(''); setOffset(0); setSelected('') }
  const openEntity = (e: Entity) => { switchView(e.category); setSelected(e.id) }
  const openId = async (id: string) => {
    try { const d = await intel<Detail>(base + '/entities/' + encodeURIComponent(id)); openEntity(d.entity) }
    catch (e) { setError(message(e)) }
  }
  return <>
    <header className="intel-head"><div><div className="intel-eyebrow">WORKSPACE</div><h2>{workspace.title}</h2><p>{workspace.path}</p></div><span className="intel-sync">{updated ? `自动更新 · ${updated}` : '正在连接'}</span><button className="intel-danger" onClick={() => setDeleting(true)}>删除工作区</button></header>
    {deleting && <DeleteWorkspace workspace={workspace} onClose={() => setDeleting(false)} onDeleted={onDeleted} />}
    <nav className="intel-tabs" aria-label="工作区情报分类">{Object.entries(categories).map(([key, label]) => <button key={key} aria-pressed={view === key} onClick={() => switchView(key as View)}>{label}</button>)}</nav>
    <div className="intel-toolbar">
      {view !== 'activity' ? <><input aria-label="搜索情报" placeholder="搜索名称、标识、所属域…" value={q} onChange={e => { setQ(e.target.value); setOffset(0) }} />
        <select aria-label="类型筛选" value={kind} onChange={e => { setKind(e.target.value); setOffset(0) }}><option value="">全部类型</option>{groupKinds[view].map(k => <option key={k} value={k}>{kinds[k]}</option>)}</select>
        <select aria-label="状态筛选" value={status} onChange={e => { setStatus(e.target.value); setOffset(0) }}><option value="">全部状态</option>{Object.entries(statuses).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <button className="intel-primary" onClick={() => setCreating(true)}>＋ 新增</button></> : <p>执行会话的查询、原值读取、保存与失败记录。搜索词不写入日志。</p>}
      <button onClick={() => setRefresh(r => r + 1)}>刷新</button>
    </div>
    {error && <div className="intel-error" role="alert">{error}；已有结果保留。</div>}
    <div className={selected ? 'intel-body has-detail' : 'intel-body'}>
      <section className="intel-results" aria-label={categories[view] + '列表'}>
        <div className="intel-count">{loading ? '加载中…' : `共 ${total} 条 · ${categories[view]}`}</div>
        {!loading && total === 0 && <div className="intel-empty"><h3>{view === 'activity' ? '暂无读写记录' : '暂无匹配情报'}</h3><p>{view === 'activity' ? 'Agent 调用情报工具后将在此留下记录。' : 'Agent 发现并保存后会自动出现，也可手工新增。'}</p></div>}
        {view === 'activity' ? events.map(a => <article className="intel-event" key={a.id}><div><strong>{operations[a.operation] || a.operation}</strong><span className={a.outcome === 'failed' ? 'intel-failed' : 'intel-badge'}>{a.outcome === 'failed' ? '失败' : '成功'}</span></div><p>执行会话：{a.session_id}</p>{a.owner_session_id && <small>主会话：{a.owner_session_id}</small>}<p><small>{time(a.created_at)}</small></p>{a.error_code && <p className="intel-failed">{a.error_code}</p>}
          {a.criteria && Object.keys(a.criteria).length > 0 && <p className="intel-muted">条件：{String(a.criteria.category || '全部分类')} / {String(a.criteria.kind || '全部类型')} {a.criteria.has_search ? '· 含搜索词（不记录原文）' : ''}{a.criteria.related_to ? ` · 关联 ${String(a.criteria.related_to)}` : ''}</p>}
          <div className="intel-id-links">{a.object_ids.map(id => <button key={id} onClick={() => void openId(id)}>{id}</button>)}</div>
        </article>) : <div className="intel-table-wrap"><table className="intel-table"><thead><tr><th>名称 / 标识</th><th>类型 / 状态</th><th>最近发现</th></tr></thead><tbody>{rows.map(e => <tr key={e.id} className={selected === e.id ? 'selected' : ''}><td><button className="intel-row-link" onClick={() => setSelected(e.id)}><strong>{e.name}</strong><small>{e.identifier}</small>{e.namespace && <small>所属域：{e.namespace}</small>}</button></td><td>{kinds[e.kind]}<small>{statuses[e.status]}</small></td><td><small>{time(e.last_seen)}</small></td></tr>)}</tbody></table></div>}
        {total > 30 && <div className="intel-pagination"><button disabled={offset === 0} onClick={() => setOffset(n => Math.max(0, n - 30))}>上一页</button><span>{Math.floor(offset / 30) + 1} / {Math.ceil(total / 30)}</span><button disabled={offset + 30 >= total} onClick={() => setOffset(n => n + 30)}>下一页</button></div>}
      </section>
      {selected && <EntityPanel key={selected} base={base} id={selected} onClose={() => setSelected('')} onNavigate={openEntity} onChanged={() => setRefresh(r => r + 1)} />}
    </div>
    {creating && view !== 'activity' && <EntityForm base={base} category={view} onClose={() => setCreating(false)} onSaved={id => { setCreating(false); setSelected(id); setRefresh(r => r + 1) }} />}
  </>
}

function EntityPanel({ base, id, onClose, onNavigate, onChanged }: { base: string; id: string; onClose: () => void; onNavigate: (e: Entity) => void; onChanged: () => void }) {
  const [data, setData] = useState<Detail | null>(null), [error, setError] = useState('')
  const [tab, setTab] = useState('overview'), [secret, setSecret] = useState<string | null>(null)
  const [editing, setEditing] = useState(false), [linking, setLinking] = useState(false), [refresh, setRefresh] = useState(0)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController(); let running = false
    const pull = async () => {
      if (running || document.hidden) return
      running = true
      try { const d = await intel<Detail>(base + '/entities/' + id, { signal: controller.signal }); if (!controller.signal.aborted) { setData(d); setError('') } }
      catch (e) { if (!controller.signal.aborted) setError(message(e)) } finally { running = false }
    }
    void pull(); const timer = window.setInterval(pull, 5000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [base, id, refresh])
  useEffect(() => { if (secret === null) return; const t = window.setTimeout(() => setSecret(null), 30000); return () => clearTimeout(t) }, [secret])
  useEffect(() => { const hide = () => { if (document.hidden) setSecret(null) }; document.addEventListener('visibilitychange', hide); return () => document.removeEventListener('visibilitychange', hide) }, [])
  const reveal = async () => {
    if (secret !== null) { setSecret(null); return }
    try { const result = await intel<{ items: Entity[] }>(base + '/query', post({ ids: [id], include_secrets: true })); if (alive.current) setSecret(result.items[0]?.secret ?? '') }
    catch (e) { if (alive.current) setError(message(e)) }
  }
  const changed = () => { setRefresh(r => r + 1); onChanged() }
  return <aside className="intel-detail" aria-label="条目详情"><div className="intel-detail-head"><small>{id}</small><button aria-label="关闭详情" onClick={onClose}>关闭</button></div>
    {error && <p role="alert" className="intel-error">{error}</p>}
    {!data ? <p>正在加载详情…</p> : <><h3>{data.entity.name}</h3><span className="intel-badge">{kinds[data.entity.kind]}</span><span className="intel-badge">{statuses[data.entity.status]}</span>
      <nav className="intel-detail-tabs" aria-label="详情分类">{[['overview', '概况'], ['relations', '关联对象'], ['history', '来源与历史']].map(([key, label]) => <button key={key} aria-pressed={tab === key} onClick={() => { setTab(key); setSecret(null) }}>{label}</button>)}</nav>
      {tab === 'overview' && <><dl><dt>标识</dt><dd>{data.entity.identifier}</dd><dt>所属域 / 系统</dt><dd>{data.entity.namespace || '未指定'}</dd><dt>首次发现</dt><dd>{time(data.entity.first_seen)}</dd><dt>最近发现</dt><dd>{time(data.entity.last_seen)}</dd><dt>备注</dt><dd>{data.entity.note || '暂无'}</dd></dl>
        {data.entity.has_secret && <div className="intel-secret"><small>敏感原值 · 30 秒后自动收起</small><pre>{secret === null ? '••••••••••••' : secret}</pre><button onClick={() => void reveal()}>{secret === null ? '查看原值' : '收起原值'}</button></div>}
        <button onClick={() => setEditing(true)}>编辑信息 / 状态</button></>}
      {tab === 'relations' && <><button onClick={() => setLinking(true)}>＋ 添加关联</button>{!data.relations.length && <p className="intel-muted">暂无关联，可关联本工作区已有对象。</p>}{data.relations.map(r => <div className="intel-relation" key={r.id}><small>{r.from_id === id ? '指向' : '来自'} · {r.label} · {bases[r.basis]}</small><button onClick={() => onNavigate(r.target)}>{r.target.name} →</button><p>{r.evidence}</p></div>)}{data.relations_truncated && <p>仅展示最近 100 条关系；可通过工具按关联对象分页查询。</p>}</>}
      {tab === 'history' && <>{data.observations.map(o => <article className="intel-observation" key={o.id}><small>{time(o.created_at)} · {statuses[o.status]}</small><p>执行会话：{o.session_id}</p>{o.owner_session_id && <p>主会话：{o.owner_session_id}</p>}{o.observed_at && <p>观察时间：{o.observed_at}</p>}<p>{o.content.evidence || '未提供证据说明'}</p>{o.content.note && <p>{o.content.note}</p>}{o.content.relation_id && <small>关系：{o.content.relation_id}</small>}</article>)}{data.observations_truncated && <p>显示最近 50 条；完整历史仍保存在数据库中。</p>}</>}
      {editing && <EditForm base={base} entity={data.entity} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); changed() }} />}
      {linking && <RelationForm base={base} entity={data.entity} onClose={() => setLinking(false)} onSaved={() => { setLinking(false); changed() }} />}
    </>}
  </aside>
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  return <dialog ref={dialog} className="intel-modal" onCancel={e => { e.preventDefault(); onClose() }} aria-label={title}><div className="intel-detail-head"><h3>{title}</h3><button onClick={onClose}>关闭</button></div>{children}</dialog>
}
function DeleteWorkspace({ workspace, onClose, onDeleted }: { workspace: Workspace; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  return <Modal title="删除情报工作区" onClose={() => { if (!busy) onClose() }}><form onSubmit={async e => {
    e.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try { await intel('/workspaces/' + encodeURIComponent(workspace.id), { method: 'DELETE' }); onDeleted() }
    catch (err) { setError(message(err)) }
    finally { setBusy(false) }
  }}>
    <p>确定删除工作区「{workspace.title}」？其全部情报、关联、观察记录与 Agent 读写记录将永久删除，无法恢复。</p>
    <p className="intel-muted">本机项目文件与 Harness 工作区会保留。删除后不会自动接入；如需再次使用，请手动新建同目录的情报工作区。</p>
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy} onClick={onClose}>取消</button><button className="intel-danger" disabled={busy}>{busy ? '删除中…' : '确认删除'}</button>
  </form></Modal>
}
function WorkspaceForm({ onClose, onSaved }: { onClose: () => void; onSaved: (w: Workspace) => void }) {
  const [title, setTitle] = useState(''), [path, setPath] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  return <Modal title="新建情报工作区" onClose={onClose}><form onSubmit={async e => { e.preventDefault(); setBusy(true); try { onSaved(await intel<Workspace>('/workspaces', post({ title, path }))) } catch (err) { setError(message(err)) } finally { setBusy(false) } }}>
    <label>工作区名称<input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label><label>本机执行目录<input required maxLength={4096} placeholder="/Users/…/project" value={path} onChange={e => setPath(e.target.value)} /></label><p className="intel-muted">填写已有目录；该目录内的 Cairn 会话会自动关联到此工作区。</p>{error && <p role="alert">{error}</p>}<button disabled={busy} className="intel-primary">{busy ? '保存中…' : '创建工作区'}</button></form></Modal>
}
function EntityForm({ base, category, onClose, onSaved }: { base: string; category: Category; onClose: () => void; onSaved: (id: string) => void }) {
  const [kind, setKind] = useState<Kind>(groupKinds[category][0]), [name, setName] = useState(''), [identifier, setIdentifier] = useState(''), [namespace, setNamespace] = useState(''), [secret, setSecret] = useState(''), [note, setNote] = useState(''), [evidence, setEvidence] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const pending = useRef({ payload: '', key: '' })
  return <Modal title={'新增' + categories[category]} onClose={onClose}><form onSubmit={async e => { e.preventDefault(); setBusy(true)
    const entities = [{ ref: 'new', kind, name, identifier, namespace, ...(sensitive.has(kind) ? { secret } : {}), note, evidence }]
    const payload = JSON.stringify(entities); if (pending.current.payload !== payload) pending.current = { payload, key: crypto.randomUUID() }
    try { const r = await intel<{ entities: { id: string }[] }>(base + '/save', post({ submission_key: pending.current.key, entities })); onSaved(r.entities[0].id) } catch (err) { setError(message(err)) } finally { setBusy(false) }
  }}>
    <label>类型<select aria-label="类型" value={kind} onChange={e => { setKind(e.target.value as Kind); setSecret('') }}>{groupKinds[category].map(k => <option value={k} key={k}>{kinds[k]}</option>)}</select></label>
    <label>显示名称<input required maxLength={500} value={name} onChange={e => setName(e.target.value)} /></label><label>{sensitive.has(kind) ? '标识（账号/服务名称，不含敏感原值）' : '标识 / 值'}<input required maxLength={2048} value={identifier} onChange={e => setIdentifier(e.target.value)} /></label>
    <label>所属域 / 系统{['account', 'person', 'employee_id', 'student_id', 'user_id'].includes(kind) ? '（必填）' : ''}<input required={['account', 'person', 'employee_id', 'student_id', 'user_id'].includes(kind)} maxLength={2048} value={namespace} onChange={e => setNamespace(e.target.value)} /></label>
    {sensitive.has(kind) && <label>敏感原值<input type="password" autoComplete="new-password" required maxLength={16384} value={secret} onChange={e => setSecret(e.target.value)} /></label>}
    <label>发现依据<textarea maxLength={8000} value={evidence} onChange={e => setEvidence(e.target.value)} /></label><label>备注<textarea maxLength={4000} value={note} onChange={e => setNote(e.target.value)} /></label>
    <p className="intel-muted">新增状态为“未验证”。敏感原值仅填写在专用字段中。</p>{error && <p role="alert">{error}</p>}<button disabled={busy} className="intel-primary">{busy ? '保存中…' : '保存'}</button>
  </form></Modal>
}
function EditForm({ base, entity, onClose, onSaved }: { base: string; entity: Entity; onClose: () => void; onSaved: () => void }) {
  const [initial] = useState(entity), [name, setName] = useState(entity.name), [note, setNote] = useState(entity.note || ''), [status, setStatus] = useState(entity.status), [evidence, setEvidence] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  return <Modal title="编辑信息与状态" onClose={onClose}><form onSubmit={async e => { e.preventDefault(); setBusy(true); try { await intel(base + '/entities/' + initial.id, { method: 'PATCH', body: JSON.stringify({ version: initial.version, name, note, status, evidence }) }); onSaved() } catch (err) { setError(message(err)) } finally { setBusy(false) } }}>
    <label>名称<input required maxLength={500} value={name} onChange={e => setName(e.target.value)} /></label><label>状态<select aria-label="状态" value={status} onChange={e => setStatus(e.target.value as Status)}>{Object.entries(statuses).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label><label>状态依据<textarea required={['verified', 'failed', 'revoked'].includes(status)} maxLength={8000} value={evidence} onChange={e => setEvidence(e.target.value)} /></label><label>备注<textarea maxLength={4000} value={note} onChange={e => setNote(e.target.value)} /></label><p className="intel-muted">人工状态将保留，后续 Agent 观察会另记历史。凭据更换时请新增记录。</p>{error && <p role="alert">{error}</p>}<button disabled={busy} className="intel-primary">保存修改</button>
  </form></Modal>
}
function RelationForm({ base, entity, onClose, onSaved }: { base: string; entity: Entity; onClose: () => void; onSaved: () => void }) {
  const [q, setQ] = useState(''), [options, setOptions] = useState<Entity[]>([]), [target, setTarget] = useState(''), [label, setLabel] = useState('关联'), [basis, setBasis] = useState<keyof typeof bases>('declared'), [evidence, setEvidence] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const pending = useRef({ payload: '', key: '' })
  useEffect(() => { const c = new AbortController(); setTarget(''); const t = setTimeout(() => { void intel<{ items: Entity[] }>(base + '/query', { ...post({ q, limit: 50 }), signal: c.signal }).then(r => { if (!c.signal.aborted) setOptions(r.items.filter(x => x.id !== entity.id)) }).catch(e => { if (!c.signal.aborted) setError(message(e)) }) }, 200); return () => { clearTimeout(t); c.abort() } }, [base, entity.id, q])
  return <Modal title="添加对象关联" onClose={onClose}><form onSubmit={async e => { e.preventDefault(); setBusy(true); const relations = [{ from_ref: entity.id, to_ref: target, label, basis, evidence }]; const payload = JSON.stringify(relations); if (pending.current.payload !== payload) pending.current = { payload, key: crypto.randomUUID() }; try { await intel(base + '/save', post({ submission_key: pending.current.key, relations })); onSaved() } catch (err) { setError(message(err)) } finally { setBusy(false) } }}>
    <p>从：{entity.name}</p><label>搜索本工作区对象<input value={q} onChange={e => setQ(e.target.value)} placeholder="输入名称缩小范围（最多展示 50 条）" /></label><label>关联到<select aria-label="关联到" required value={target} onChange={e => setTarget(e.target.value)}><option value="">选择对象</option>{options.map(o => <option key={o.id} value={o.id}>{kinds[o.kind]} · {o.name} · {o.namespace || o.identifier}</option>)}</select></label><label>关系名称<input required maxLength={100} value={label} onChange={e => setLabel(e.target.value)} /></label><label>关系依据<select aria-label="关系依据" value={basis} onChange={e => setBasis(e.target.value as keyof typeof bases)}>{Object.entries(bases).map(([k, v]) => <option value={k} key={k}>{v}</option>)}</select></label><label>证据说明<textarea required maxLength={4000} value={evidence} onChange={e => setEvidence(e.target.value)} /></label>{error && <p role="alert">{error}</p>}<button disabled={busy || !target} className="intel-primary">保存关联</button>
  </form></Modal>
}
