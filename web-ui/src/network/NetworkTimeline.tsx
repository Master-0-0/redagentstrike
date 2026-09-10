import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  clearNetwork,
  dropHold,
  fetchNetwork,
  fetchNetworkEvent,
  forwardHold,
  health,
  loadDraft,
  replayDraft,
  setCapture,
  setIntercept,
} from './api'
import { persistDshUrl } from '../dshUrl'
import type { EmptyKind, NetworkEvent, NetworkPayload, ReplayResult, RequestDraft } from './types'

const EMPTY_COPY: Record<Exclude<EmptyKind, null>, { title: string; body: string }> = {
  idle: {
    title: '还没有 HTTP(S) 记录',
    body: '捕获已开。打开捕获时会把 Agent 工作台接到代理；模型调用、web_fetch 和尊重代理的工具会出现在这里。',
  },
  proxy_off: {
    title: '捕获已关',
    body: '点「捕获」开始监听。关掉后时间线还在，只是不再写入新请求。',
  },
  store_unavailable: {
    title: '网络仓不可用',
    body: 'DuckDB 打不开，无法读取 HTTP 摘要。',
  },
}

const EMPTY_DRAFT: RequestDraft = { method: 'GET', url: '', headers: {}, body: '' }

export function NetworkTimeline() {
  const [apiUp, setApiUp] = useState<'unknown' | 'up' | 'down'>('unknown')
  const [host, setHost] = useState('')
  const [payload, setPayload] = useState<NetworkPayload | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [holdDraft, setHoldDraft] = useState<RequestDraft>(EMPTY_DRAFT)
  const [repeater, setRepeater] = useState<RequestDraft>(EMPTY_DRAFT)
  const [replayOut, setReplayOut] = useState<ReplayResult | null>(null)
  const [tab, setTab] = useState<'detail' | 'repeater'>('detail')

  const pending = payload?.capture.pending[0] ?? null
  const selected = useMemo(
    () => payload?.events.find((event) => event.id === selectedId) ?? null,
    [payload, selectedId],
  )

  const refresh = useCallback(async () => {
    const next = await fetchNetwork({ host })
    syncHarnessUrl(next.capture)
    setPayload(next)
    setSelectedId((current) => {
      if (current && next.events.some((event) => event.id === current)) return current
      return next.events[0]?.id ?? null
    })
    return next
  }, [host])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const status = await health()
        if (!cancelled) setApiUp(status.ok ? 'up' : 'down')
        if (status.ok) await refresh()
      } catch {
        if (!cancelled) setApiUp('down')
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 8_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    if (apiUp !== 'up') return
    let cancelled = false
    const load = async () => {
      try {
        await refresh()
      } catch {
        if (!cancelled) setNotice('读取时间线失败')
      }
    }
    void load()
    const interceptOn = Boolean(payload?.capture.intercept)
    const timer = window.setInterval(() => { void load() }, interceptOn ? 700 : 2_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [apiUp, payload?.capture.intercept, refresh])

  useEffect(() => {
    if (!pending) return
    setHoldDraft({
      method: pending.method,
      url: pending.url,
      host: pending.host,
      headers: pending.headers,
      body: pending.body,
    })
  }, [pending?.id])

  const onToggleCapture = async () => {
    setBusy(true)
    setNotice(null)
    try {
      const next = !(payload?.capture.listening)
      const result = await setCapture(next)
      if (result.error) setNotice(captureErrorText(result.error))
      else if (next) setNotice('已把 Agent 工作台接到代理。工作台会刷新一次。')
      await refresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法切换捕获')
    } finally {
      setBusy(false)
    }
  }

  const onToggleIntercept = async () => {
    setBusy(true)
    setNotice(null)
    try {
      const next = !(payload?.capture.intercept)
      const result = await setIntercept(next)
      if (result.error) setNotice(captureErrorText(result.error))
      await refresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法切换拦截')
    } finally {
      setBusy(false)
    }
  }

  const onForward = async () => {
    if (!pending) return
    setBusy(true)
    try {
      await forwardHold(pending.id, holdDraft)
      await refresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '放行失败')
    } finally {
      setBusy(false)
    }
  }

  const onDrop = async () => {
    if (!pending) return
    setBusy(true)
    try {
      await dropHold(pending.id)
      await refresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '丢弃失败')
    } finally {
      setBusy(false)
    }
  }

  const onOpenRepeater = async (event: NetworkEvent) => {
    setTab('repeater')
    setReplayOut(null)
    try {
      const loaded = await loadDraft(event.id)
      if (loaded.draft) {
        setRepeater(loaded.draft)
        if (loaded.stale) setNotice('原始请求不在内存里，编辑器里是时间线摘要，敏感头需要手工补。')
      } else {
        setRepeater(draftFromEvent(event))
        setNotice('原始请求不在内存里，编辑器里是时间线摘要，敏感头需要手工补。')
      }
    } catch {
      setRepeater(draftFromEvent(event))
    }
  }

  const onClear = async () => {
    setBusy(true)
    setNotice(null)
    try {
      await clearNetwork()
      setSelectedId(null)
      setReplayOut(null)
      setRepeater(EMPTY_DRAFT)
      setTab('detail')
      setNotice('已清除全部捕获记录')
      await refresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '清除失败')
    } finally {
      setBusy(false)
    }
  }

  const onSendReplay = async () => {
    setBusy(true)
    setNotice(null)
    try {
      const result = await replayDraft(repeater)
      setReplayOut(result)
      await refresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '重放失败')
    } finally {
      setBusy(false)
    }
  }

  const listening = Boolean(payload?.capture.listening)
  const interceptOn = Boolean(payload?.capture.intercept)
  const empty = payload?.empty ?? (apiUp === 'down' ? null : 'proxy_off')
  const queue = payload?.capture.pending_count ?? 0

  return (
    <section className="page page-network">
      <header className="nt-head">
        <div className="nt-title">
          <h1>网络时间线</h1>
          <p>代理捕获 HTTP(S)，可拦截编辑后放行，也可把历史请求拿去改了重放。不含 DNS / 裸 TCP。</p>
        </div>
        <div className="nt-badges">
          <span className="nt-badge">仅 HTTP(S) · {payload?.capture.proxy || 'http://127.0.0.1:8088'}</span>
          <span className={`nt-badge ${listening ? 'is-on' : 'is-off'}`}>
            {listening ? '捕获中' : '捕获关'}
          </span>
          <span className={`nt-badge ${interceptOn ? 'is-on' : 'is-off'}`}>
            {interceptOn ? `拦截 ${queue}` : '拦截关'}
          </span>
          {payload?.capture.harness?.managed && (
            <span className={`nt-badge ${payload.capture.harness.proxied ? 'is-on' : 'is-off'}`}>
              {payload.capture.harness.proxied ? '工作台已接入' : '工作台未接入'}
            </span>
          )}
          <button
            type="button"
            className="nt-clear"
            disabled={busy || apiUp !== 'up'}
            onClick={() => void onClear()}
          >
            clear
          </button>
        </div>
      </header>

      <div className="nt-toolbar">
        <button
          type="button"
          className={listening ? 'btn-primary' : 'btn-ghost'}
          disabled={busy || apiUp !== 'up'}
          onClick={() => void onToggleCapture()}
        >
          {listening ? '捕获 开' : '捕获 关'}
        </button>
        <button
          type="button"
          className={interceptOn ? 'btn-primary' : 'btn-ghost'}
          disabled={busy || apiUp !== 'up'}
          onClick={() => void onToggleIntercept()}
        >
          {interceptOn ? '拦截 开' : '拦截 关'}
        </button>
        <label className="nt-grow">
          host
          <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="过滤主机名" />
        </label>
      </div>

      {notice && <p className="nt-notice">{notice}</p>}

      {pending && (
        <section className="nt-intercept">
          <div className="nt-intercept-bar">
            <strong>拦截</strong>
            <span>队列 {queue}</span>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void onForward()}>放行</button>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => void onDrop()}>丢弃</button>
          </div>
          <DraftEditor value={holdDraft} onChange={setHoldDraft} />
        </section>
      )}

      <div className="nt-body">
        <div className="nt-main">
          {apiUp === 'down' ? (
            <div className="nt-empty">
              <h2>控制面未连接</h2>
              <p>先启动 <code>python -m workbench</code>，工作台会把 <code>/api</code> 转到 <code>127.0.0.1:8787</code>。</p>
            </div>
          ) : empty && (payload?.events.length ?? 0) === 0 ? (
            <div className="nt-empty">
              <h2>{EMPTY_COPY[empty].title}</h2>
              <p>{EMPTY_COPY[empty].body}</p>
            </div>
          ) : (
            <ol className="nt-list">
              {(payload?.events ?? []).map((event) => (
                <li key={event.id}>
                  <button
                    type="button"
                    className={event.id === selectedId ? 'nt-row is-active' : 'nt-row'}
                    onClick={() => { setSelectedId(event.id); setTab('detail') }}
                  >
                    <time>{formatTs(event.ts)}</time>
                    <span className="nt-method">{event.join.method || '?'}</span>
                    <span className="nt-summary">{event.host}{urlPath(event.join.url)}</span>
                    <span className={statusClass(event)}>{statusLabel(event)}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>

        <aside className="nt-detail">
          <div className="nt-tabs">
            <button type="button" className={tab === 'detail' ? 'is-on' : ''} onClick={() => setTab('detail')}>详情</button>
            <button type="button" className={tab === 'repeater' ? 'is-on' : ''} onClick={() => setTab('repeater')}>重放</button>
          </div>
          {tab === 'detail' ? (
            selected ? (
              <EventDetail
                eventId={selected.id}
                fallback={selected}
                onReplay={() => void onOpenRepeater(selected)}
              />
            ) : (
              <div className="nt-empty compact">
                <h2>请求详情</h2>
                <p>选中时间轴一行查看摘要，或点「重放」改完再发。</p>
              </div>
            )
          ) : (
            <div className="nt-repeater">
              <DraftEditor value={repeater} onChange={setRepeater} />
              <button type="button" className="btn-primary" disabled={busy || !repeater.url} onClick={() => void onSendReplay()}>
                发送
              </button>
              {replayOut && (
                <div className="nt-replay-out">
                  <h2>响应 {replayOut.status}{replayOut.via_proxy ? ' · 经代理' : ''}</h2>
                  <pre>{formatHeaders(replayOut.headers)}</pre>
                  <pre>{replayOut.body || '—'}</pre>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      <footer className="nt-foot">
        <span>{payload?.counts.total ?? 0} 请求</span>
        <span>2xx {payload?.counts.status_2xx ?? 0}</span>
        <span>4xx {payload?.counts.status_4xx ?? 0}</span>
        <span>5xx {payload?.counts.status_5xx ?? 0}</span>
        <span>失败 {payload?.counts.failed ?? 0}</span>
        <span className="nt-foot-run">{payload?.capture.proxy || 'http://127.0.0.1:8088'}</span>
      </footer>
    </section>
  )
}

function EventDetail(props: {
  eventId: string
  fallback: NetworkEvent
  onReplay: () => void
}) {
  const [event, setEvent] = useState<NetworkEvent>(props.fallback)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setEvent(props.fallback)
    setCopied(false)
    void fetchNetworkEvent(props.eventId)
      .then((next) => {
        if (!cancelled) setEvent(next)
      })
      .catch(() => {
        if (!cancelled) setEvent(props.fallback)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [props.eventId])

  return (
    <div className="nt-detail-inner">
      <div className="nt-detail-actions">
        <button type="button" className="btn-primary" onClick={props.onReplay}>重放到编辑器</button>
        <button
          type="button"
          className="btn-ghost"
          disabled={loading}
          onClick={() => void onCopy(event, setCopied)}
        >
          {copied ? '已复制' : '复制请求'}
        </button>
      </div>
      {loading && <p className="nt-muted">正在加载完整头体…</p>}
      <h2>请求</h2>
      <dl>
        <dt>method</dt><dd>{event.join.method || '—'}</dd>
        <dt>url</dt><dd className="mono">{event.join.url || '—'}</dd>
        <dt>status</dt><dd>{event.join.status ?? '无响应'}</dd>
        <dt>host</dt><dd>{event.host || '—'}</dd>
      </dl>
      <h2>请求头</h2>
      <pre>{formatHeaders(event.truncated.req_headers)}</pre>
      <h2>请求体</h2>
      <pre>{event.truncated.req_body || '—'}</pre>
      <h2>响应头</h2>
      <pre>{formatHeaders(event.truncated.resp_headers)}</pre>
      <h2>响应体</h2>
      <pre>{event.truncated.resp_body || '—'}</pre>
    </div>
  )
}

async function onCopy(
  event: NetworkEvent,
  setCopied: (next: boolean) => void,
): Promise<void> {
  const text = formatHttpExchange(event)
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.left = '-9999px'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    document.body.removeChild(area)
  }
  setCopied(true)
  window.setTimeout(() => setCopied(false), 1600)
}

function formatHttpExchange(event: NetworkEvent): string {
  const method = (event.join.method || 'GET').toUpperCase()
  const rawUrl = event.join.url || '/'
  let path = rawUrl
  let host = event.host || ''
  try {
    const parsed = new URL(rawUrl)
    path = `${parsed.pathname}${parsed.search}${parsed.hash}` || '/'
    host = parsed.host || host
  } catch {
    /* keep raw url as request-target */
  }
  const reqHeaders = { ...event.truncated.req_headers }
  if (host && !Object.keys(reqHeaders).some((key) => key.toLowerCase() === 'host')) {
    reqHeaders.Host = host
  }
  const request = [
    `${method} ${path || '/'} HTTP/1.1`,
    formatHeaderBlock(reqHeaders),
    '',
    event.truncated.req_body || '',
  ].join('\n').replace(/\n+$/u, '')
  const status = event.join.status
  const statusLine = `HTTP/1.1 ${status ?? 0}`
  const response = [
    statusLine,
    formatHeaderBlock(event.truncated.resp_headers),
    '',
    event.truncated.resp_body || '',
  ].join('\n').replace(/\n+$/u, '')
  return `${request}\n\n${response}\n`
}

function formatHeaderBlock(headers: Record<string, string>): string {
  return Object.keys(headers).map((key) => `${key}: ${headers[key]}`).join('\n')
}

function DraftEditor(props: { value: RequestDraft; onChange: (next: RequestDraft) => void }) {
  const { value, onChange } = props
  return (
    <div className="nt-draft">
      <div className="nt-draft-line">
        <select
          value={value.method}
          onChange={(event) => onChange({ ...value, method: event.target.value })}
        >
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((method) => (
            <option key={method} value={method}>{method}</option>
          ))}
        </select>
        <input
          value={value.url}
          onChange={(event) => onChange({ ...value, url: event.target.value })}
          spellCheck={false}
          placeholder="https://…"
        />
      </div>
      <textarea
        value={headersToText(value.headers)}
        onChange={(event) => onChange({ ...value, headers: textToHeaders(event.target.value) })}
        spellCheck={false}
        placeholder="Header: value"
        rows={6}
      />
      <textarea
        value={value.body}
        onChange={(event) => onChange({ ...value, body: event.target.value })}
        spellCheck={false}
        placeholder="body"
        rows={6}
      />
    </div>
  )
}

function draftFromEvent(event: NetworkEvent): RequestDraft {
  return {
    method: event.join.method || 'GET',
    url: event.join.url,
    host: event.host,
    headers: event.truncated.req_headers,
    body: event.truncated.req_body,
  }
}

function headersToText(headers: Record<string, string>): string {
  return Object.keys(headers).map((key) => `${key}: ${headers[key]}`).join('\n')
}

function textToHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const index = trimmed.indexOf(':')
    if (index <= 0) continue
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return out
}

function urlPath(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.pathname + parsed.search
  } catch {
    return url
  }
}

function formatHeaders(headers: Record<string, string>): string {
  const keys = Object.keys(headers)
  if (keys.length === 0) return '—'
  return keys.map((key) => `${key}: ${headers[key]}`).join('\n')
}

function formatTs(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(date.getMilliseconds()).padStart(3, '0')
}

function statusLabel(event: NetworkEvent): string {
  if (event.failed || event.join.status == null) return '失败'
  return String(event.join.status)
}

function statusClass(event: NetworkEvent): string {
  if (event.failed || event.join.status == null) return 'nt-status is-fail'
  const code = event.join.status
  if (code >= 200 && code < 300) return 'nt-status is-2xx'
  if (code >= 400 && code < 500) return 'nt-status is-4xx'
  if (code >= 500) return 'nt-status is-5xx'
  return 'nt-status'
}

function captureErrorText(code: string): string {
  if (code === 'mitmproxy_missing') return '未找到 mitmdump。安装 mitmproxy 后才能真正抓到经代理的流量。'
  if (code === 'capture_macos_only') return 'MVP 仅支持 macOS 捕获。'
  if (code === 'mitm_start_timeout') return 'mitm 启动超时，检查 8088 端口是否被占用。'
  if (code === 'proxy_port_busy') return '127.0.0.1:8088 已被占用。'
  if (code === 'dsh_root_missing') return '找不到 DeepSeek Harness 目录，Agent 工作台无法自动接入代理。'
  if (code === 'dsh_runtime_missing') return '本机没有 pnpm/node，无法重启 Agent 工作台以注入代理。'
  if (code === 'dsh_start_timeout') return 'Agent 工作台重启超时。捕获已开，但工作台可能还没走代理。'
  if (code.startsWith('dsh_spawn_failed')) return '无法启动 Agent 工作台：' + code
  return `捕获未启动：${code}`
}

function syncHarnessUrl(capture: NetworkPayload['capture']): void {
  const url = capture.harness?.url
  if (url) persistDshUrl(url)
}
