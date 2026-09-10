import { useCallback, useEffect, useMemo, useState } from 'react'
import { DSH_URL_EVENT, DEFAULT_DSH_URL, persistDshUrl, readStoredDshUrl } from './dshUrl'
import { NetworkTimeline } from './network/NetworkTimeline'

export type RouteId =
  | 'agent'
  | 'approval'
  | 'evidence'
  | 'network'
  | 'settings'

const NAV: { id: RouteId; label: string; hint: string }[] = [
  { id: 'agent', label: 'Agent 工作台', hint: 'DeepSeek Harness' },
  { id: 'approval', label: '审批', hint: '高危动作确认' },
  { id: 'evidence', label: '证据', hint: '会话取证浏览' },
  { id: 'network', label: '网络时间线', hint: '捕获 / 拦截 / 重放' },
  { id: 'settings', label: '设置', hint: 'Harness 连接' },
]

export function App() {
  const [route, setRoute] = useState<RouteId>('agent')
  const [dshUrl, setDshUrl] = useState(readStoredDshUrl)
  const [dshLive, setDshLive] = useState<'unknown' | 'up' | 'down'>('unknown')
  const [frameReady, setFrameReady] = useState(false)

  const iframeSrc = useMemo(() => normalizeDshUrl(dshUrl), [dshUrl])

  const probe = useCallback(async () => {
    try {
      const response = await fetch('/__dsh/manifest.webmanifest', { cache: 'no-store' })
      setDshLive(response.ok ? 'up' : 'down')
    } catch {
      setDshLive('down')
    }
    try {
      const status = await fetch('/api/health', { cache: 'no-store' }).then((r) => r.json()) as {
        harness?: { url?: string | null }
      }
      if (status.harness?.url) persistDshUrl(status.harness.url)
    } catch {
      /* api down */
    }
  }, [])

  useEffect(() => {
    void probe()
    const timer = window.setInterval(() => { void probe() }, 8_000)
    return () => window.clearInterval(timer)
  }, [probe])

  useEffect(() => {
    const onUrl = (event: Event) => {
      const url = (event as CustomEvent<string>).detail
      if (!url || url === dshUrl) return
      setDshUrl(url)
      setFrameReady(false)
    }
    window.addEventListener(DSH_URL_EVENT, onUrl)
    return () => window.removeEventListener(DSH_URL_EVENT, onUrl)
  }, [dshUrl])

  const saveUrl = (next: string) => {
    const trimmed = next.trim() || DEFAULT_DSH_URL
    persistDshUrl(trimmed)
    setDshUrl(trimmed)
    setFrameReady(false)
  }

  return (
    <div className="shell">
      <aside className="rail" aria-label="主导航">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <div className="brand-title">渗透 Agent</div>
            <div className="brand-sub">单机工作台</div>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={route === item.id ? 'nav-item is-active' : 'nav-item'}
              onClick={() => setRoute(item.id)}
            >
              <span className="nav-icon" aria-hidden="true">{icon(item.id)}</span>
              <span className="nav-copy">
                <span className="nav-label">{item.label}</span>
                <span className="nav-hint">{item.hint}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="rail-foot">
          <span className={`pulse pulse-${dshLive}`} />
          <span>
            {dshLive === 'up' ? 'Harness 在线' : dshLive === 'down' ? 'Harness 未连接' : '正在探测…'}
          </span>
        </div>
      </aside>

      <main className="stage">
        <section
          className={route === 'agent' ? 'pane pane-agent is-shown' : 'pane pane-agent'}
          aria-hidden={route !== 'agent'}
        >
          {dshLive === 'down' ? (
            <EmptyState
              title="DeepSeek Harness 未在运行"
              body="工作台会把 Harness 页面嵌进这一栏。先启动 dsh web，再在设置里填入它打印的带 token 的地址。"
              actionLabel="打开设置"
              onAction={() => setRoute('settings')}
            />
          ) : (
            <>
              {!frameReady && <div className="frame-veil">正在载入 Agent 工作台…</div>}
              <iframe
                className="harness-frame"
                title="DeepSeek Harness"
                src={iframeSrc}
                allow="clipboard-read; clipboard-write"
                onLoad={() => setFrameReady(true)}
              />
            </>
          )}
        </section>

        {route === 'approval' && (
          <Placeholder title="审批" detail="高危工具调用会在这里打断等待确认。v1 先把 Agent 工作台跑通。" />
        )}
        {route === 'evidence' && (
          <Placeholder title="证据" detail="会话产物、截图与工具输出会在这里按 Run 归档浏览。" />
        )}
        {route === 'network' && <NetworkTimeline />}
        {route === 'settings' && (
          <SettingsPanel
            value={dshUrl}
            live={dshLive}
            onSave={saveUrl}
            onOpenAgent={() => setRoute('agent')}
          />
        )}
      </main>
    </div>
  )
}

function normalizeDshUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (!url.pathname || url.pathname === '') url.pathname = '/'
    return url.href
  } catch {
    return DEFAULT_DSH_URL
  }
}

function SettingsPanel(props: {
  value: string
  live: 'unknown' | 'up' | 'down'
  onSave: (url: string) => void
  onOpenAgent: () => void
}) {
  const [draft, setDraft] = useState(props.value)
  useEffect(() => { setDraft(props.value) }, [props.value])

  return (
    <section className="page">
      <header className="page-head">
        <h1>设置</h1>
        <p>把 DeepSeek Harness 的启动地址嵌进「Agent 工作台」。打开「捕获」时工作台会重启本地 Harness 并注入代理；token 会自动更新。</p>
      </header>
      <label className="field">
        <span>Harness 地址</span>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
          placeholder="http://127.0.0.1:3081/?token=…"
        />
      </label>
      <div className="actions">
        <button type="button" className="btn-primary" onClick={() => props.onSave(draft)}>保存连接</button>
        <button type="button" className="btn-ghost" onClick={props.onOpenAgent}>打开 Agent 工作台</button>
      </div>
      <p className="note">
        当前探测：{props.live === 'up' ? '在线' : props.live === 'down' ? '未连接' : '未知'}。
        工作台跑在 <code>127.0.0.1:5173</code>，与 Harness 同站不同端口，iframe 才能带上 Strict Cookie。
      </p>
    </section>
  )
}

function Placeholder(props: { title: string; detail: string }) {
  return (
    <section className="page">
      <header className="page-head">
        <h1>{props.title}</h1>
        <p>{props.detail}</p>
      </header>
    </section>
  )
}

function EmptyState(props: {
  title: string
  body: string
  actionLabel: string
  onAction: () => void
}) {
  return (
    <div className="empty">
      <h1>{props.title}</h1>
      <p>{props.body}</p>
      <button type="button" className="btn-primary" onClick={props.onAction}>{props.actionLabel}</button>
    </div>
  )
}

function icon(id: RouteId) {
  switch (id) {
    case 'agent':
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M8 9h8M8 13h5" />
        </svg>
      )
    case 'approval':
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 3 20 7v5c0 5-3.2 8.4-8 9-4.8-.6-8-4-8-9V7l8-4Z" />
          <path d="m9 12 2.2 2.2L15.5 10" />
        </svg>
      )
    case 'evidence':
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M7 3h7l5 5v13H7z" />
          <path d="M14 3v5h5M9 13h6M9 17h4" />
        </svg>
      )
    case 'network':
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 16h4l2-6 3 10 2-8h5" />
        </svg>
      )
    case 'settings':
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a7.7 7.7 0 0 0 .1-6l2-1.2-2-3.4-2.3.6A7.8 7.8 0 0 0 14 3.1L13.5 1h-3L10 3.1A7.8 7.8 0 0 0 6.8 5l-2.3-.6-2 3.4 2 1.2a7.7 7.7 0 0 0 .1 6l-2 1.2 2 3.4 2.3-.6A7.8 7.8 0 0 0 10 20.9l.5 2.1h3l.5-2.1a7.8 7.8 0 0 0 3.2-1.9l2.3.6 2-3.4-2-1.2Z" />
        </svg>
      )
  }
}
