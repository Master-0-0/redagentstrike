import { useEffect, useRef, useState } from 'react'
import { api, artifactUrl } from './api'
import { ExportReport } from './ExportReport'
import { ArchiveForm } from './ArchiveForm'
import {
  kinds,
  remedies,
  reviews,
  severities,
  type Artifact,
  type FindingCard,
  type FindingDetail,
  type Source,
} from './types'
import './findings.css'

type BoardTarget = { workspaceId: string; ownerId: string }
export function FindingsPage({ onSource }: { onSource: (target: BoardTarget) => void }) {
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [page, setPage] = useState(1)
  const [payload, setPayload] = useState<{ items: FindingCard[]; total: number } | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [workspaces, setWorkspaces] = useState<{ id: string; title: string }[]>([])
  const filterKey = JSON.stringify(filters)
  useEffect(() => {
    void api<{ workspaces: { id: string; title: string }[] }>('/blackboards')
      .then((r) => setWorkspaces(r.workspaces))
      .catch(() => {})
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    let running = false
    const pull = async () => {
      if (document.hidden || running) return
      running = true
      try {
        const data = await api<{ items: FindingCard[]; total: number }>(
          '/findings?' + new URLSearchParams({ ...JSON.parse(filterKey), page: String(page) }),
          { signal: controller.signal },
        )
        if (!controller.signal.aborted) {
          setPayload(data)
          setError('')
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '读取失败')
      } finally {
        running = false
      }
    }
    void pull()
    const timer = window.setInterval(() => void pull(), 5000)
    document.addEventListener('visibilitychange', pull)
    return () => {
      controller.abort()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', pull)
    }
  }, [filterKey, page, refresh])
  const filter = (key: string, value: string) => {
    setPage(1)
    setFilters({ ...filters, [key]: value })
  }
  return (
    <section className="page findings-page">
      <header className="findings-head">
        <div>
          <p className="findings-eyebrow">FINDINGS / EVIDENCE ARCHIVE</p>
          <h1>漏洞成果库</h1>
          <p>保存发现与证据，让每一次验证可追溯。</p>
        </div>
        <div className="findings-actions">
          <button className="findings-primary" onClick={() => setCreating(true)}>
            ＋ 手工新增
          </button>
          <button onClick={() => setExporting(true)}>导出报告</button>
        </div>
      </header>
      <div className="findings-filters">
        <input
          aria-label="搜索成果"
          placeholder="搜索标题、目标或摘要…"
          value={filters.q ?? ''}
          onChange={(e) => filter('q', e.target.value)}
        />
        {[
          ['severity', '全部风险', severities],
          ['review_status', '全部复核状态', reviews],
          ['remediation_status', '全部修复状态', remedies],
        ].map(([key, label, options]) => (
          <select
            aria-label={String(label)}
            key={String(key)}
            value={filters[String(key)] ?? ''}
            onChange={(e) => filter(String(key), e.target.value)}
          >
            <option value="">{String(label)}</option>
            {Object.entries(options).map(([v, l]) => (
              <option key={v} value={v}>
                {String(l)}
              </option>
            ))}
          </select>
        ))}
        <select
          aria-label="工作区筛选"
          value={filters.workspace_id ?? ''}
          onChange={(e) => filter('workspace_id', e.target.value)}
        >
          <option value="">全部工作区</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.title}
            </option>
          ))}
        </select>
      </div>
      <details className="findings-advanced">
        <summary>会话、Run 与时间筛选</summary>
        <div className="findings-filters">
          <input
            aria-label="会话 ID"
            placeholder="执行会话 ID"
            onChange={(e) => filter('session_id', e.target.value)}
          />
          <input
            aria-label="Run ID"
            placeholder="Run ID"
            onChange={(e) => filter('run_id', e.target.value)}
          />
          <label>
            开始日期
            <input
              type="date"
              onChange={(e) =>
                filter('since', e.target.value ? e.target.value + 'T00:00:00+00:00' : '')
              }
            />
          </label>
          <label>
            结束日期
            <input
              type="date"
              onChange={(e) =>
                filter('until', e.target.value ? e.target.value + 'T23:59:59+00:00' : '')
              }
            />
          </label>
        </div>
      </details>
      {error && (
        <div className="findings-error" role="alert">
          {error}；保留上次结果。<button onClick={() => setRefresh((r) => r + 1)}>重试</button>
        </div>
      )}
      {!payload && !error && <p role="status">正在加载成果…</p>}
      {payload && (
        <>
          <p className="findings-count">{payload.total} 项成果 · 归档不等于确认</p>
          {payload.items.length === 0 ? (
            <div className="findings-empty">
              <h2>暂无符合条件的成果</h2>
              <p>从画板、PoC 扫描结果或手工新增保存已有证据。</p>
            </div>
          ) : (
            <div className="findings-grid">
              {payload.items.map((f) => (
                <button className="finding-card" key={f.id} onClick={() => setSelected(f.id)}>
                  <div className="finding-card-tags">
                    <span className={`finding-severity severity-${f.severity}`}>
                      {severities[f.severity]}
                    </span>
                    <span>{reviews[f.review_status]}</span>
                  </div>
                  <h2>{f.title}</h2>
                  <p className="finding-target">{f.target}</p>
                  <p className="finding-summary">{f.summary}</p>
                  <div className="finding-card-meta">
                    <span>{f.artifact_count} 份证据</span>
                    {f.gap_count > 0 && (
                      <span className="findings-warning">{f.gap_count} 项待补材料</span>
                    )}
                    <span>{remedies[f.remediation_status]}</span>
                  </div>
                  <footer>
                    <span>{f.sources[0]?.session_id || '人工录入'}</span>
                    <time>{new Date(f.created_at).toLocaleDateString()}</time>
                  </footer>
                </button>
              ))}
            </div>
          )}
          <nav className="findings-pagination" aria-label="成果分页">
            <button disabled={page === 1} onClick={() => setPage(page - 1)}>
              上一页
            </button>
            <span>
              第 {page} / {Math.max(1, Math.ceil(payload.total / 20))} 页
            </span>
            <button disabled={page * 20 >= payload.total} onClick={() => setPage(page + 1)}>
              下一页
            </button>
          </nav>
        </>
      )}
      {exporting && <ExportReport onClose={() => setExporting(false)} />}
      {creating && (
        <ArchiveForm onClose={() => setCreating(false)} onSaved={() => setRefresh((r) => r + 1)} />
      )}
      {selected && (
        <FindingView
          key={selected}
          id={selected}
          onClose={() => setSelected(null)}
          onChanged={() => setRefresh((r) => r + 1)}
          onSource={onSource}
        />
      )}
    </section>
  )
}

function FindingView({
  id,
  onClose,
  onChanged,
  onSource,
}: {
  id: string
  onClose: () => void
  onChanged: () => void
  onSource: (t: BoardTarget) => void
}) {
  const [data, setData] = useState<FindingDetail | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [editing, setEditing] = useState(false)
  const [append, setAppend] = useState(false)
  useEffect(() => {
    let active = true
    void api<FindingDetail>('/findings/' + id)
      .then((d) => {
        if (active) {
          setData(d)
          setError('')
        }
      })
      .catch((e) => {
        if (active) setError(String(e.message))
      })
    return () => {
      active = false
    }
  }, [id, refresh])
  const changed = () => {
    setRefresh((r) => r + 1)
    onChanged()
  }
  return (
    <div className="findings-overlay">
      <section
        className="findings-dialog findings-detail"
        role="dialog"
        aria-modal="true"
        aria-label="成果详情"
      >
        <header>
          <h2>成果详情</h2>
          <button onClick={onClose}>关闭</button>
        </header>
        {error && (
          <p role="alert" className="findings-error">
            {error}
            <button onClick={() => setRefresh((r) => r + 1)}>重新加载</button>
          </p>
        )}
        {!data && !error && <p>读取详情…</p>}
        {data && (
          <>
            <div className="finding-card-tags">
              <span className={`finding-severity severity-${data.severity}`}>
                {severities[data.severity]}
              </span>
              <span>{reviews[data.review_status]}</span>
              <span>{remedies[data.remediation_status]}</span>
            </div>
            <h1>{data.title}</h1>
            <p className="finding-target">{data.target}</p>
            <p>
              提交方判断：{data.agent_assessment === 'reproduced' ? '报告已复现' : '疑似'} ·
              人工结论独立维护
            </p>
            {data.agent_assessment === 'reproduced' && data.artifacts.length === 0 && (
              <p className="findings-warning">报告已复现，但没有支撑附件；需要人工复核。</p>
            )}
            <section>
              <h3>漏洞说明</h3>
              <p className="findings-prose">{data.summary}</p>
              <h4>利用前提</h4>
              <p className="findings-prose">{data.preconditions}</p>
              <h4>复现步骤</h4>
              <ol>
                {data.steps.map((s) => (
                  <li key={s.id}>
                    <code>{s.id}</code> {s.description}
                    <small>
                      {' '}
                      {data.artifacts
                        .filter((a) => a.step_ids.includes(s.id))
                        .map((a) => a.filename)
                        .join('、')}
                    </small>
                  </li>
                ))}
              </ol>
              <div className="findings-fields">
                <div>
                  <h4>预期结果</h4>
                  <p className="findings-prose">{data.expected_result}</p>
                </div>
                <div>
                  <h4>实际结果</h4>
                  <p className="findings-prose">{data.actual_result}</p>
                </div>
              </div>
            </section>
            <section>
              <h3>PoC 与执行材料</h3>
              <p>提交文件本身不能证明已执行。结合关联步骤、执行说明与工具日志人工核对。</p>
              {data.artifacts
                .filter((a) => ['poc', 'tool_output'].includes(a.kind))
                .map((a) => (
                  <Evidence key={a.id} artifact={a} fid={id} />
                ))}
            </section>
            <section>
              <h3>HTTP 请求与响应</h3>
              {data.artifacts
                .filter((a) => a.kind.startsWith('http_'))
                .map((a) => (
                  <Evidence key={a.id} artifact={a} fid={id} />
                ))}
            </section>
            <section>
              <h3>图片证据</h3>
              {data.artifacts
                .filter((a) => a.kind.endsWith('_screenshot'))
                .map((a) => (
                  <Evidence key={a.id} artifact={a} fid={id} />
                ))}
            </section>
            {data.artifacts
              .filter((a) => a.kind === 'attachment')
              .map((a) => (
                <Evidence key={a.id} artifact={a} fid={id} />
              ))}
            <section>
              <h3>来源与事实快照</h3>
              {data.sources.map((s, i) => (
                <SourceView key={i} source={s} onSource={onSource} />
              ))}
            </section>
            <section>
              <h3>证据缺口</h3>
              {data.evidence_gaps.length === 0 && <p>未声明缺口；这不构成漏洞确认。</p>}
              {data.evidence_gaps.map((g) => (
                <div className="findings-gap-record" key={g.id}>
                  <strong>
                    {g.category} ·{' '}
                    {g.resolved_at ? '已解决' : g.status === 'missing' ? '未采集' : '不适用'}
                  </strong>
                  <p>{g.reason}</p>
                  <code>{g.id}</code>
                </div>
              ))}
              <button onClick={() => setAppend(true)}>追加证据 / 解决缺口</button>
            </section>
            <section>
              <h3>人工复核与修复</h3>
              <button onClick={() => setEditing(true)}>编辑说明与人工状态</button>
            </section>
            <section>
              <h3>修改历史</h3>
              {data.history.map((h) => (
                <details key={h.id}>
                  <summary>
                    {new Date(h.created_at).toLocaleString()} · {h.actor} · {h.operation}
                  </summary>
                  <p>{h.note}</p>
                  {h.before !== undefined && (
                    <>
                      <h4>修改前</h4>
                      <pre>{JSON.stringify(h.before, null, 2)}</pre>
                      <h4>修改后</h4>
                      <pre>{JSON.stringify(h.after, null, 2)}</pre>
                    </>
                  )}
                </details>
              ))}
            </section>
            {editing && (
              <EditForm
                data={data}
                onClose={() => setEditing(false)}
                onSaved={() => {
                  setEditing(false)
                  changed()
                }}
              />
            )}
            {append && (
              <ArchiveForm findingId={id} onClose={() => setAppend(false)} onSaved={changed} />
            )}
          </>
        )}
      </section>
    </div>
  )
}

function SourceView({
  source: s,
  onSource,
}: {
  source: Source
  onSource: (t: BoardTarget) => void
}) {
  const [available, setAvailable] = useState(false)
  const owner = s.owner_session_id
    ? [...s.owner_session_id.trim()]
        .map((c) =>
          /^[A-Za-z0-9._-]$/.test(c)
            ? c
            : `~${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
        )
        .join('')
    : ''
  useEffect(() => {
    let active = true
    if (s.workspace_id && owner)
      void api(`/blackboards/${encodeURIComponent(s.workspace_id)}/${encodeURIComponent(owner)}`)
        .then(() => {
          if (active) setAvailable(true)
        })
        .catch(() => {
          if (active) setAvailable(false)
        })
    return () => {
      active = false
    }
  }, [s.workspace_id, owner])
  return (
    <div className="findings-source">
      <p>
        {s.source_type === 'manual' ? '人工录入' : 'Cairn'} · 工作区：
        {s.workspace_path || s.workspace_id || '未关联'}
      </p>
      <p>
        执行会话：{s.session_id || '未关联'}
        <br />
        Owner：{s.owner_session_id || '无法解析'} · {s.owner_resolution || '不适用'}
      </p>
      {s.fact_snapshots?.map((f) => (
        <blockquote key={f.id}>
          <strong>{f.id}</strong>
          <p>{f.description}</p>
        </blockquote>
      ))}
      <button
        disabled={!available}
        onClick={() => onSource({ workspaceId: s.workspace_id!, ownerId: owner })}
      >
        {available ? '在工作台查看来源画板' : '原始画板不可用或未关联'}
      </button>
    </div>
  )
}

function Evidence({ artifact: a, fid }: { artifact: Artifact; fid: string }) {
  const [preview, setPreview] = useState<{ text: string; truncated: boolean } | null>(null)
  const [error, setError] = useState('')
  const [opened, setOpened] = useState(false)
  const loaded = useRef(false)
  const isImage = a.kind !== 'attachment' && ['image/png', 'image/jpeg'].includes(a.media_type)
  const isText =
    a.kind !== 'attachment' &&
    (a.media_type.startsWith('text/') || a.media_type === 'application/json')
  async function show() {
    setOpened((v) => !v)
    if (isText && !loaded.current) {
      try {
        setPreview(await api(`/findings/${fid}/artifacts/${a.id}?preview=true`))
        loaded.current = true
      } catch (e) {
        setError(e instanceof Error ? e.message : '预览失败')
      }
    }
  }
  return (
    <article className="findings-artifact">
      <div>
        <strong>{kinds[a.kind]}</strong>
        <span>
          {' '}
          · {a.filename} · {a.size.toLocaleString()} B
        </span>
      </div>
      <p>{a.description}</p>
      <p className="findings-small">
        关联步骤：{a.step_ids.join('、') || '未指定'} · 提交方采集声明：{a.capture_method} ·
        声明时间：{a.captured_at || '未知'}
      </p>
      {a.execution_note && <p>执行方式说明（提交方声明）：{a.execution_note}</p>}
      {a.page_url && <p>页面地址：{a.page_url}</p>}
      {a.kind.startsWith('http_') && (
        <p className="findings-warning">
          {a.representation} · 保真性：{a.fidelity} · 截断：{a.truncation} · 脱敏：{a.redaction}
          {a.network_ref && ` · 事件 ${a.network_ref.event_id} / Run ${a.network_ref.run_id}`}
        </p>
      )}
      {a.kind === 'response_screenshot' && (
        <p className="findings-warning">
          响应文本截图：最多 24,000 字符且受固定视口限制，不能代替完整响应附件。
        </p>
      )}
      {a.integrity !== 'ok' ? (
        <p className="findings-error">附件完整性异常；保存字节丢失或发生变化。</p>
      ) : (
        <>
          <div className="findings-actions">
            {(isImage || isText) && (
              <button onClick={() => void show()}>{opened ? '收起预览' : '预览证据'}</button>
            )}
            <a href={artifactUrl(fid, a.id)} download>
              下载完整附件（含保存凭据）
            </a>
          </div>
          {opened && isImage && (
            <>
              <img
                className="findings-image"
                src={artifactUrl(fid, a.id, true)}
                alt={kinds[a.kind]}
                onError={() => setError('图片加载失败')}
              />
            </>
          )}
          {opened && isText && (
            <>
              <p>
                {preview?.truncated ? '仅显示前 64 KiB，请下载完整附件。' : '显示附件保存内容。'}
              </p>
              <pre>{preview?.text ?? '加载中…'}</pre>
            </>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>校验与归档信息</summary>
        <p className="mono">SHA-256: {a.sha256}</p>
        <p>归档时间：{a.archived_at}；哈希仅校验副本完整性，不证明采集真实性。</p>
      </details>
    </article>
  )
}

function EditForm({
  data,
  onClose,
  onSaved,
}: {
  data: FindingDetail
  onClose: () => void
  onSaved: () => void
}) {
  const [value, setValue] = useState({ ...data })
  const [steps, setSteps] = useState(data.steps.map((s) => `${s.id}\t${s.description}`).join('\n'))
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    setError('')
    try {
      const fields = [
        'title',
        'target',
        'summary',
        'severity',
        'preconditions',
        'expected_result',
        'actual_result',
        'agent_assessment',
        'review_status',
        'remediation_status',
      ] as const
      const changes: Record<string, unknown> = {}
      fields.forEach((k) => {
        if (value[k] !== data[k]) changes[k] = value[k]
      })
      if (steps !== data.steps.map((s) => `${s.id}\t${s.description}`).join('\n'))
        changes.steps = steps.split('\n').map((line) => {
          const [id, ...rest] = line.split('\t')
          return { id, description: rest.join('\t') }
        })
      await api('/findings/' + data.id, {
        method: 'PATCH',
        body: JSON.stringify({ version: data.version, changes, note }),
      })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="findings-overlay">
      <section className="findings-dialog" role="dialog" aria-modal="true" aria-label="编辑成果">
        <header>
          <h2>编辑成果 · v{data.version}</h2>
          <button disabled={busy} onClick={onClose}>
            关闭
          </button>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <fieldset disabled={busy}>
            {data.review_status === 'confirmed' && (
              <p className="findings-warning">
                当前成果已确认。修改关键说明后请重新核对人工结论；系统不会自动改变复核状态。
              </p>
            )}
            {(
              [
                'title',
                'target',
                'summary',
                'preconditions',
                'expected_result',
                'actual_result',
              ] as const
            ).map((k, i) => (
              <label key={k}>
                {['标题', '目标', '摘要', '前提', '预期结果', '实际结果'][i]}
                <textarea
                  required
                  value={value[k]}
                  onChange={(e) => setValue({ ...value, [k]: e.target.value })}
                />
              </label>
            ))}
            <label>
              步骤（每行：稳定 ID、Tab、描述；历史证据关联保留）
              <textarea required value={steps} onChange={(e) => setSteps(e.target.value)} />
            </label>
            {(
              [
                ['severity', severities],
                ['review_status', reviews],
                ['remediation_status', remedies],
              ] as const
            ).map(([k, opts]) => (
              <label key={k}>
                {k === 'severity' ? '风险' : k === 'review_status' ? '人工复核' : '修复状态'}
                <select
                  aria-label={
                    k === 'severity' ? '风险' : k === 'review_status' ? '人工复核' : '修复状态'
                  }
                  value={value[k]}
                  onChange={(e) => setValue({ ...value, [k]: e.target.value })}
                >
                  {Object.entries(opts).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label>
              修改备注
              <textarea value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          </fieldset>
          {error && (
            <p className="findings-error" role="alert">
              {error}。版本冲突时请关闭编辑并重新加载详情。
            </p>
          )}
          <button disabled={busy} type="submit">
            {busy ? '保存中…' : '保存修改'}
          </button>
        </form>
      </section>
    </div>
  )
}
