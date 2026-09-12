import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  addProxy,
  checkAllProxies,
  checkProxy,
  deleteProxy,
  fetchProxyPool,
  fetchPublicProxies,
  health,
  patchProxy,
} from './api'
import type { ProxyCounts, ProxyEmpty, ProxyEntry, ProxyPoolPayload, ProxyScheme } from './types'

const EMPTY_FORM = {
  scheme: 'http' as ProxyScheme,
  host: '',
  port: '',
  username: '',
  password: '',
}

const EMPTY_COUNTS: ProxyCounts = {
  total: 0,
  nodes: 0,
  enabled: 0,
  cooling: 0,
  alive: 0,
  dead: 0,
  unknown: 0,
  latency_ms: null,
}

const EMPTY_COPY: Record<Exclude<ProxyEmpty, 'ok'>, { title: string; body: string }> = {
  no_entries: {
    title: '还没有代理节点',
    body: '手工填主机端口，或点「从公开源拉取」。Agent fuzz 超时或连不上时会从这里领新 IP。免费源很多是死的。',
  },
  all_disabled: {
    title: '节点都已停用',
    body: '启用至少一条后才会被租用。停用的不参与换 IP，但仍可测存活。',
  },
  all_cooling: {
    title: '启用的都在冷却',
    body: '连续失败后会熔断一段时间。可以先测存活，确认节点还活着。',
  },
}

export function ProxyPool() {
  const [apiUp, setApiUp] = useState<'unknown' | 'up' | 'down'>('unknown')
  const [payload, setPayload] = useState<ProxyPoolPayload | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [checkingId, setCheckingId] = useState<string | 'all' | 'fetch' | null>(null)

  const entries = payload?.entries ?? []
  const selected = useMemo(
    () => entries.find((entry) => entry.id === selectedId) ?? null,
    [entries, selectedId],
  )

  const refresh = useCallback(async () => {
    const next = await fetchProxyPool()
    setPayload(next)
    setSelectedId((current) => {
      if (current && next.entries.some((entry) => entry.id === current)) return current
      return next.entries[0]?.id ?? null
    })
    return next
  }, [])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const status = await health()
        if (!cancelled) setApiUp(status.ok ? 'up' : 'down')
        if (status.ok && checkingId === null) await refresh()
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
  }, [refresh, checkingId])

  const applySnapshot = (next: ProxyPoolPayload) => {
    setPayload(next)
    setSelectedId((current) => {
      if (current && next.entries.some((entry) => entry.id === current)) return current
      return next.entries[0]?.id ?? null
    })
  }

  const onAdd = async () => {
    const host = form.host.trim()
    const port = form.port.trim()
    if (!host || !port) {
      setNotice('主机和端口不能为空。')
      return
    }
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      setNotice('端口必须是 1–65535 的数字。')
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      applySnapshot(await addProxy({
        scheme: form.scheme,
        host,
        port: Number(port),
        username: form.username.trim() || undefined,
        password: form.password || undefined,
      }))
      setForm(EMPTY_FORM)
      setNotice('已加入资源列表。点「测存活」看节点是否可用、速率多少。')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '添加失败')
    } finally {
      setBusy(false)
    }
  }

  const onToggle = async (entry: ProxyEntry) => {
    setBusy(true)
    setNotice(null)
    try {
      applySnapshot(await patchProxy(entry.id, { enabled: !entry.enabled }))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法改启用状态')
    } finally {
      setBusy(false)
    }
  }

  const onRemove = async (id: string) => {
    setBusy(true)
    setNotice(null)
    try {
      applySnapshot(await deleteProxy(id))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '移除失败')
    } finally {
      setBusy(false)
    }
  }

  const onCheck = async (id: string) => {
    setCheckingId(id)
    setNotice(null)
    try {
      applySnapshot(await checkProxy(id))
      setNotice('已测完这一条：看列表里的存活和速率。探测走节点本身，不经 8088。')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '探测失败')
    } finally {
      setCheckingId(null)
    }
  }

  const onCheckAll = async () => {
    if (entries.length === 0) return
    setCheckingId('all')
    setNotice(null)
    try {
      applySnapshot(await checkAllProxies())
      setNotice('已测完全部节点。存活和速率写在资源列表里。')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '批量探测失败')
    } finally {
      setCheckingId(null)
    }
  }

  const onFetchPublic = async () => {
    setCheckingId('fetch')
    setNotice('正在从公开源拉列表并测活，只入库还活着的节点…')
    try {
      const next = await fetchPublicProxies(8)
      applySnapshot(next)
      if (next.added > 0) {
        setNotice(
          `公开源拉到 ${next.fetched} 条候选，测了 ${next.tried} 条，活着入库 ${next.added} 条。免费列表不稳定，过一会儿可能又死。`,
        )
      } else if (next.fetched === 0) {
        const reason = next.errors.map((item) => item.source).join('、') || '公开源'
        setNotice(`没拉到候选（${reason}）。可以再试一次，或手工加付费节点。`)
      } else {
        setNotice(
          `公开源有 ${next.fetched} 条候选，测了 ${next.tried} 条都没活着。再拉一次，或改手工录入。`,
        )
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '公开源拉取失败')
    } finally {
      setCheckingId(null)
    }
  }

  const empty = payload?.empty ?? (apiUp === 'down' ? null : 'no_entries')
  const counts = payload?.counts ?? EMPTY_COUNTS
  const locked = busy || apiUp !== 'up' || checkingId !== null

  return (
    <section className="page page-network">
      <header className="nt-head">
        <div className="nt-title">
          <h1>代理池</h1>
          <p>资源列表里的每一条是一个出口 IP 节点。Agent fuzz 超时或连不上时自己调代理池领新 IP；不替代本地捕获口 8088。</p>
        </div>
        <div className="nt-badges">
          <span className={`nt-badge ${counts.nodes > 0 ? 'is-on' : 'is-off'}`}>
            节点 {counts.nodes}
          </span>
          <span className={`nt-badge ${counts.alive > 0 ? 'is-on' : 'is-off'}`}>
            存活 {counts.alive}
          </span>
          <span className={`nt-badge ${counts.dead > 0 ? 'is-off' : 'is-on'}`}>
            不可达 {counts.dead}
          </span>
          <span className="nt-badge">未测 {counts.unknown}</span>
          <span className="nt-badge">
            {counts.latency_ms == null ? '均速 —' : `均速 ${counts.latency_ms}ms`}
          </span>
          <span className={`nt-badge ${payload?.agent?.url ? 'is-on' : 'is-off'}`}>
            {payload?.agent?.url
              ? `Agent ${payload.agent.url.replace(/^https?:\/\//, '')}`
              : 'Agent 未领出口'}
          </span>
        </div>
      </header>

      <div className="nt-toolbar">
        <label>
          协议
          <select
            value={form.scheme}
            onChange={(event) => setForm({ ...form, scheme: event.target.value as ProxyScheme })}
          >
            <option value="http">http</option>
            <option value="https">https</option>
            <option value="socks5">socks5</option>
          </select>
        </label>
        <label className="nt-grow">
          主机
          <input
            value={form.host}
            onChange={(event) => setForm({ ...form, host: event.target.value })}
            spellCheck={false}
            placeholder="127.0.0.1 或 proxy.example"
          />
        </label>
        <label>
          端口
          <input
            value={form.port}
            onChange={(event) => setForm({ ...form, port: event.target.value })}
            spellCheck={false}
            placeholder="8080"
          />
        </label>
        <label>
          用户名
          <input
            value={form.username}
            onChange={(event) => setForm({ ...form, username: event.target.value })}
            spellCheck={false}
            placeholder="可选"
          />
        </label>
        <label>
          密码
          <input
            type="password"
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
            placeholder="可选"
          />
        </label>
        <button type="button" className="btn-primary" disabled={locked} onClick={() => void onAdd()}>
          添加
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={locked || entries.length === 0}
          onClick={() => void onCheckAll()}
        >
          {checkingId === 'all' ? '测全部…' : '测全部'}
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={locked}
          onClick={() => void onFetchPublic()}
        >
          {checkingId === 'fetch' ? '拉取中…' : '从公开源拉取'}
        </button>
      </div>

      {notice && <p className="nt-notice">{notice}</p>}

      <div className="nt-body">
        <div className="nt-main">
          {apiUp === 'down' ? (
            <div className="nt-empty">
              <h2>控制面未连接</h2>
              <p>先启动 <code>python -m workbench</code>，工作台会把 <code>/api</code> 转到 <code>127.0.0.1:8787</code>。</p>
            </div>
          ) : entries.length === 0 ? (
            <div className="nt-empty">
              <h2>{EMPTY_COPY[empty && empty !== 'ok' ? empty : 'no_entries'].title}</h2>
              <p>{EMPTY_COPY[empty && empty !== 'ok' ? empty : 'no_entries'].body}</p>
            </div>
          ) : (
            <>
              <div className="pp-head" aria-hidden="true">
                <span>协议</span>
                <span>节点</span>
                <span>存活</span>
                <span>速率</span>
                <span>状态</span>
              </div>
              <ol className="nt-list">
                {entries.map((entry) => (
                  <ProxyRow
                    key={entry.id}
                    entry={entry}
                    active={entry.id === selectedId}
                    checking={checkingId === entry.id || checkingId === 'all'}
                    onSelect={() => setSelectedId(entry.id)}
                  />
                ))}
              </ol>
            </>
          )}
        </div>

        <aside className="nt-detail">
          {selected ? (
            <div className="nt-detail-inner">
              <div className="nt-detail-actions">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={locked}
                  onClick={() => void onCheck(selected.id)}
                >
                  {checkingId === selected.id || checkingId === 'all' ? '探测中…' : '测存活'}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={locked}
                  onClick={() => void onToggle(selected)}
                >
                  {selected.enabled ? '停用' : '启用'}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={locked}
                  onClick={() => void onRemove(selected.id)}
                >
                  移除
                </button>
              </div>
              <h2>节点</h2>
              <dl>
                <dt>协议</dt><dd>{selected.scheme}</dd>
                <dt>地址</dt><dd className="mono">{selected.host}:{selected.port}</dd>
                <dt>用户名</dt><dd>{selected.username || '—'}</dd>
                <dt>密码</dt><dd>{selected.has_password ? '已填写' : '—'}</dd>
                <dt>状态</dt><dd>{enabledLabel(selected)}</dd>
                <dt>来源</dt><dd>{sourceLabel(selected.source)}</dd>
                {selected.note ? <><dt>备注</dt><dd>{selected.note}</dd></> : null}
              </dl>
              <h2>存活 / 速率</h2>
              <dl>
                <dt>存活</dt><dd>{aliveLabel(selected)}</dd>
                <dt>速率</dt><dd>{latencyLabel(selected.latency_ms)}</dd>
                <dt>出口 IP</dt><dd className="mono">{selected.egress_ip || '—'}</dd>
                <dt>探测于</dt><dd>{selected.checked_at ? formatChecked(selected.checked_at) : '未测'}</dd>
                <dt>错误</dt><dd>{selected.check_error || '—'}</dd>
              </dl>
              <p className="nt-muted">探测直连该节点，不经过捕获口。SOCKS5 目前只测端口是否可达。</p>
            </div>
          ) : (
            <div className="nt-empty compact">
              <h2>节点详情</h2>
              <p>选中一条看存活、速率和出口 IP。测存活或测全部会写回资源列表。</p>
            </div>
          )}
        </aside>
      </div>

      <footer className="nt-foot">
        <span>{counts.nodes} 节点</span>
        <span>存活 {counts.alive}</span>
        <span>不可达 {counts.dead}</span>
        <span>未测 {counts.unknown}</span>
        <span>启用 {counts.enabled}</span>
        <span>{counts.latency_ms == null ? '均速 —' : `均速 ${counts.latency_ms}ms`}</span>
        <span className="nt-foot-run">
          {apiUp === 'up' ? '已连接控制面' : apiUp === 'down' ? '未连接后端' : '正在探测…'}
        </span>
      </footer>
    </section>
  )
}

function ProxyRow(props: {
  entry: ProxyEntry
  active: boolean
  checking: boolean
  onSelect: () => void
}) {
  const { entry } = props
  return (
    <li>
      <button
        type="button"
        className={props.active ? 'nt-row pp-row is-active' : 'nt-row pp-row'}
        onClick={props.onSelect}
      >
        <span className="nt-method">{entry.scheme}</span>
        <span className="nt-summary">
          {entry.host}:{entry.port}
          <span className="pp-auth"> {sourceLabel(entry.source)}</span>
        </span>
        <span className={`nt-status ${aliveClass(entry)}`}>
          {props.checking ? '探测' : aliveLabel(entry)}
        </span>
        <span className="pp-latency">{latencyLabel(entry.latency_ms)}</span>
        <span className={`nt-status ${enabledClass(entry)}`}>{enabledLabel(entry)}</span>
      </button>
    </li>
  )
}

function aliveLabel(entry: ProxyEntry): string {
  if (entry.alive === true) return '存活'
  if (entry.alive === false) return '不可达'
  return '未测'
}

function aliveClass(entry: ProxyEntry): string {
  if (entry.alive === true) return 'is-2xx'
  if (entry.alive === false) return 'is-fail'
  return ''
}

function enabledLabel(entry: ProxyEntry): string {
  if (entry.cooling) return '冷却'
  return entry.enabled ? '启用' : '停用'
}

function enabledClass(entry: ProxyEntry): string {
  if (entry.cooling) return 'is-4xx'
  return entry.enabled ? 'is-2xx' : 'is-fail'
}

function latencyLabel(ms: number | null): string {
  if (ms == null) return '—'
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

function sourceLabel(source: string): string {
  if (source === 'public') return '公开源'
  if (source === 'vendor') return '供应商'
  if (source === 'manual') return '手工'
  return source || '—'
}

function formatChecked(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}
