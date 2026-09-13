import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchPocTemplate, fetchPocTemplates, runPocScan } from './api'
import type { PocScanReport, PocTemplate, PocTemplateDetail } from './types'

export function PocScan() {
  const [templates, setTemplates] = useState<PocTemplate[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [detail, setDetail] = useState<PocTemplateDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [timeout, setTimeoutValue] = useState(10)
  const [concurrency, setConcurrency] = useState(4)
  const [proxyMode, setProxyMode] = useState<'direct' | 'fallback' | 'pool'>('fallback')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [report, setReport] = useState<PocScanReport | null>(null)
  const [preview, setPreview] = useState<{ image: string; name: string } | null>(null)

  const proxySummary = useMemo(() => {
    const addresses = new Set<string>()
    let rotations = 0
    for (const result of report?.results ?? []) {
      for (const attempt of result.attempts) {
        const routes = (attempt.transport_attempts ?? []).filter((route) => route.via === 'direct' || route.proxy_id)
        routes.forEach((route, index) => {
          if (route.via !== 'pool' || !route.proxy_id) return
          addresses.add(route.egress_ip || route.proxy_host || '地址未知')
          if (index > 0) rotations += 1
        })
      }
    }
    return { addresses: [...addresses], rotations }
  }, [report])

  const grouped = useMemo(() => {
    const groups = new Map<string, PocTemplate[]>()
    for (const template of templates) {
      groups.set(template.category, [...(groups.get(template.category) ?? []), template])
    }
    return [...groups.entries()]
  }, [templates])

  useEffect(() => {
    let cancelled = false
    void fetchPocTemplates()
      .then((payload) => {
        if (cancelled) return
        setTemplates(payload.templates)
        setExpanded(new Set(payload.categories))
        const first = payload.templates[0]
        if (first) setActiveId(first.template_id)
      })
      .catch((error) => {
        if (!cancelled) setNotice(error instanceof Error ? error.message : '读取 PoC 模板失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!activeId) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetail(null)
    setDetailError(null)
    void fetchPocTemplate(activeId)
      .then((next) => { if (!cancelled) setDetail(next) })
      .catch((error) => {
        if (!cancelled) setDetailError(error instanceof Error ? error.message : '读取模板内容失败')
      })
    return () => { cancelled = true }
  }, [activeId])

  function toggleCategory(category: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  function toggleTemplate(templateId: string) {
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(templateId)) next.delete(templateId)
      else next.add(templateId)
      return next
    })
  }

  function toggleCategoryTemplates(category: string) {
    const ids = templates.filter((item) => item.category === category).map((item) => item.template_id)
    const allChecked = ids.every((id) => checked.has(id))
    setChecked((current) => {
      const next = new Set(current)
      for (const id of ids) allChecked ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function scan() {
    if (!target.trim()) {
      setNotice('请输入 HTTP(S) 目标地址。')
      return
    }
    if (checked.size === 0) {
      setNotice('请至少勾选一个 PoC 模板。')
      return
    }
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10 || !Number.isFinite(timeout) || timeout < 1 || timeout > 30) {
      setNotice('并发需为 1–10 的整数，超时需为 1–30 秒。')
      return
    }
    setBusy(true)
    setNotice(null)
    setReport(null)
    try {
      const next = await runPocScan({
        proxy_mode: proxyMode,
        target: target.trim(),
        templates: [...checked],
        timeout,
        concurrency,
      })
      setReport(next)
      setNotice(`扫描完成：${next.total} 个模板，命中 ${next.matched} 个。${(next.recording_warnings ?? []).join(' ')}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '扫描失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page page-network page-poc">
      <header className="nt-head">
        <div className="nt-title">
          <h1>poc 扫描</h1>
          <p>按 nuclei 的模板化思路管理 YAML PoC，选择模板后对授权目标执行 HTTP 验证。</p>
        </div>
        <div className="nt-badges">
          <span className="nt-badge poc-proxy-badge" title="本次扫描使用的代理地址，优先显示代理池已检测的出口 IP，否则显示节点主机地址；扫描完成后更新。">
            已轮换 IP {proxySummary.addresses.join('、') || '—'}
          </span>
          <span className="nt-badge" title="本次扫描各请求的切换次数之和：直连失败转代理或代理失败换节点计一次；首次领取、池为空不计。">
            轮换 {proxySummary.rotations} 次
          </span>
          <span className="nt-badge">模板 {templates.length}</span>
          <span className="nt-badge">已选 {checked.size}</span>
          {report && <span className={`nt-badge ${report.matched ? 'is-off' : 'is-on'}`}>命中 {report.matched}</span>}
        </div>
      </header>

      <div className="poc-toolbar">
        <label className="poc-target">
          目标地址
          <input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="https://127.0.0.1:8848" spellCheck={false} />
        </label>
        <label>
          并发
          <input type="number" min={1} max={10} value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} />
        </label>
        <label>
          超时（秒）
          <input type="number" min={1} max={30} value={timeout} onChange={(event) => setTimeoutValue(Number(event.target.value))} />
        </label>
        <button type="button" className="btn-primary" disabled={busy || loading} onClick={() => void scan()}>
          {busy ? '扫描中…' : '开始扫描'}
        </button>
        <label>访问方式
          <select value={proxyMode} disabled={busy} onChange={(event) => setProxyMode(event.target.value as typeof proxyMode)}>
            <option value="fallback">直连失败后轮换代理</option>
            <option value="pool">通过代理池（最多 3 个节点）</option>
            <option value="direct">仅直连</option>
          </select>
        </label>
      </div>

      {notice && <p className="nt-notice" role="status">{notice}</p>}

      <div className="poc-workspace">
        <aside className="poc-manager">
          <details open className="poc-management-tree">
          <summary className="poc-pane-title">
            <strong>PoC 管理</strong>
            <span>{checked.size}/{templates.length}</span>
          </summary>
          {loading ? (
            <p className="nt-muted poc-pad">正在读取模板…</p>
          ) : grouped.length === 0 ? (
            <p className="nt-muted poc-pad">没有可用的 YAML 模板。</p>
          ) : grouped.map(([category, items]) => {
            const isOpen = expanded.has(category)
            const allChecked = items.every((item) => checked.has(item.template_id))
            return (
              <div className="poc-category" key={category}>
                <div className="poc-category-row">
                  <button type="button" className="poc-disclosure" aria-expanded={isOpen} onClick={() => toggleCategory(category)}>
                    <span aria-hidden="true">{isOpen ? '⌄' : '›'}</span>
                    <strong>{category}</strong>
                    <small>{items.length}</small>
                  </button>
                  <input type="checkbox" checked={allChecked} aria-label={`选择 ${category} 全部模板`} onChange={() => toggleCategoryTemplates(category)} />
                </div>
                {isOpen && (
                  <ul className="poc-files">
                    {items.map((template) => (
                      <li key={template.template_id} className={activeId === template.template_id ? 'is-active' : ''}>
                        <input type="checkbox" checked={checked.has(template.template_id)} aria-label={`选择 ${template.name}`} onChange={() => toggleTemplate(template.template_id)} />
                        <button type="button" onClick={() => setActiveId(template.template_id)} title={template.name}>
                          <span className="poc-file-icon" aria-hidden="true">Y</span>
                          <span>{template.template_id.split('/').pop()}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
          </details>
        </aside>

        <main className="poc-preview">
          <div className="poc-pane-title">
            <strong>{detail?.name ?? 'YAML 内容'}</strong>
            {detail && <Severity value={detail.severity} />}
          </div>
          {detailError ? <p className="nt-notice" role="alert">{detailError}</p> : activeId && !detail ? (
            <p className="nt-muted poc-pad">正在加载 YAML…</p>
          ) : detail ? (
            <>
              <div className="poc-meta">
                <span className="mono">{detail.template_id}</span>
                <span>{detail.description || '暂无说明'}</span>
              </div>
              <pre className="poc-yaml"><code>{detail.content}</code></pre>
            </>
          ) : (
            <div className="poc-empty"><p>点击左侧 YAML 文件查看内容。</p></div>
          )}
        </main>

        <aside className="poc-results">
          <div className="poc-pane-title">
            <strong>扫描结果</strong>
            {report && <span>{report.duration_ms}ms</span>}
          </div>
          {!report ? (
            <div className="poc-empty"><p>{busy ? '正在执行所选模板，请稍候…' : '选择模板并开始扫描后，结果会显示在这里。'}</p></div>
          ) : <><p className="poc-meta mono">目标：{report.target}</p>{report.results.map((result) => (
            <article className={`poc-result ${result.matched ? 'is-hit' : ''}`} key={result.template_id}>
              <div>
                <strong>{result.name}</strong>
                <Severity value={result.severity} />
              </div>
              <p>{result.matched ? '已命中' : result.attempts.some((item) => item.error) ? '请求失败' : '未命中'}</p>
              {result.attempts.map((attempt, index) => (
                <dl key={`${attempt.url}-${index}`}>
                  <dt>请求</dt><dd className="mono">{attempt.method} {attempt.url}</dd>
                  <dt>状态</dt><dd>{attempt.status ?? attempt.error ?? '—'} · {attempt.duration_ms}ms</dd>
                  {attempt.transport_attempts?.map((route, routeIndex) => (
                    <div className="poc-matcher" key={`route-${routeIndex}`}>
                      第 {routeIndex + 1} 次：{route.via === 'direct' ? '直连' : `代理 ${route.proxy_id ?? '未领取'}`} · {route.error ?? route.status}
                      {route.network_event_id && <span> · 已记录到网络时间线</span>}
                    </div>
                  ))}
                  {attempt.matchers.map((matcher, matcherIndex) => <div className="poc-matcher" key={matcherIndex}>{matcher.type} / {matcher.part}：{matcher.matched ? '匹配' : '未匹配'}</div>)}
                </dl>
              ))}
              {result.matched && (
                <section className="poc-evidence" aria-label={`${result.name} 命中证据`}>
                  <details>
                    <summary>image · 响应截图</summary>
                    {result.image ? (
                      <button type="button" className="poc-image-trigger" aria-label={`放大查看 ${result.name} 响应截图`}
                        onClick={() => setPreview({ image: result.image!, name: result.name })}>
                        <img src={result.image} alt={`${result.name} 命中响应截图`} />
                      </button>
                    ) : <p role="status">{result.image_error || '暂无截图'}</p>}
                    <p>本次响应的静态预览，截图仅显示首屏；完整文本见 body。</p>
                  </details>
                  <details>
                    <summary>body · 响应包</summary>
                    <pre>{result.body ?? '暂无响应包'}</pre>
                  </details>
                </section>
              )}
            </article>
          ))}</>}
        </aside>
      </div>
      {preview && <ImagePreview image={preview.image} name={preview.name} onClose={() => setPreview(null)} />}
    </section>
  )
}

function ImagePreview({ image, name, onClose }: { image: string; name: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    const previousFocus = document.activeElement as HTMLElement | null
    element?.showModal()
    return () => {
      element?.close()
      previousFocus?.focus()
    }
  }, [])

  return (
    <dialog ref={dialog} className="poc-image-dialog" aria-labelledby="poc-image-title"
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="poc-image-panel">
        <header>
          <h2 id="poc-image-title">{name} · 响应截图</h2>
          <button type="button" className="btn-ghost" onClick={onClose} autoFocus>关闭</button>
        </header>
        <div className="poc-image-scroll"><img src={image} alt={`${name} 命中响应截图大图`} /></div>
      </div>
    </dialog>
  )
}

function Severity({ value }: { value: string }) {
  return <span className={`poc-severity is-${value.toLowerCase()}`}>{value}</span>
}
