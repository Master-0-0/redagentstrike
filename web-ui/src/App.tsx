import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchApprovals } from './approval/api'
import { ApprovalPage } from './approval/ApprovalPage'
import type { ApprovalPayload } from './approval/types'
import { FindingsPage } from './findings/FindingsPage'
import { BlackboardPage } from './blackboard/BlackboardPage'
import { DSH_URL_EVENT, DEFAULT_DSH_URL, persistDshUrl, readStoredDshUrl } from './dshUrl'
import { NetworkTimeline } from './network/NetworkTimeline'
import { PocScan } from './network/PocScan'
import { ProxyPool } from './network/ProxyPool'

export type RouteId =
  | 'agent'
  | 'blackboard'
  | 'approval'
  | 'intel'
  | 'evidence'
  | 'network'
  | 'poc'
  | 'proxypool'
  | 'settings'

const NAV: { id: RouteId; label: string; hint: string }[] = [
  { id: 'agent', label: 'Agent 工作台', hint: 'DeepSeek Harness' },
  { id: 'blackboard', label: '画板展示', hint: '会话 fact-intent 图' },
  { id: 'approval', label: '审批', hint: '高危动作确认' },
  { id: 'intel', label: '情报资产库', hint: '目标资产与情报' },
  { id: 'evidence', label: '漏洞成果库', hint: '发现、证据与人工复核' },
  { id: 'network', label: '网络时间线', hint: '捕获 / 拦截 / 重放' },
  { id: 'poc', label: 'poc 扫描', hint: '漏洞验证模板' },
  { id: 'proxypool', label: '代理池', hint: '出站代理条目' },
  { id: 'settings', label: '设置', hint: 'Harness 连接' },
]

export function App() {
  const [sourceBoard, setSourceBoard] = useState<{workspaceId: string; ownerId: string} | null>(null)
  const [route, setRoute] = useState<RouteId>('agent')
  const [dshUrl, setDshUrl] = useState(readStoredDshUrl)
  const [dshLive, setDshLive] = useState<'unknown' | 'up' | 'down'>('unknown')
  const [frameReady, setFrameReady] = useState(false)
  const [approvals, setApprovals] = useState<ApprovalPayload | null>(null)
  const [approvalLoading, setApprovalLoading] = useState(true)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const approvalRequest = useRef<Promise<void> | null>(null)

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

  const refreshApprovals = useCallback((): Promise<void> => {
    if (approvalRequest.current) return approvalRequest.current
    const request = fetchApprovals()
      .then((next) => {
        setApprovals(next)
        setApprovalError(null)
      })
      .catch((error: unknown) => {
        setApprovalError(error instanceof Error && error.message ? error.message : '读取审批队列失败')
      })
      .finally(() => {
        setApprovalLoading(false)
        if (approvalRequest.current === request) approvalRequest.current = null
      })
    approvalRequest.current = request
    return request
  }, [])

  useEffect(() => {
    void refreshApprovals()
    const timer = window.setInterval(() => { void refreshApprovals() }, 1_000)
    return () => window.clearInterval(timer)
  }, [refreshApprovals])

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
              aria-label={item.label}
              title={item.label}
              type="button"
              className={route === item.id ? 'nav-item is-active' : 'nav-item'}
              onClick={() => setRoute(item.id)}
            >
              <span className="nav-icon" aria-hidden="true">{icon(item.id)}</span>
              <span className="nav-copy">
                <span className="nav-label">{item.label}</span>
                <span className="nav-hint">{item.hint}</span>
              </span>
              {item.id === 'approval' && (approvals?.pending_count ?? 0) > 0 && (
                <span className="nav-count" aria-label={`${approvals?.pending_count} 项等待审批`}>
                  {(approvals?.pending_count ?? 0) > 99 ? '99+' : approvals?.pending_count}
                </span>
              )}
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

        {route === 'blackboard' && <BlackboardPage initialSelection={sourceBoard} />}
        {route === 'approval' && (
          <ApprovalPage
            payload={approvals}
            loading={approvalLoading}
            error={approvalError}
            onRefresh={refreshApprovals}
          />
        )}
        {route === 'intel' && (
          <Placeholder title="情报资产库" detail="主机、域名、账号与情报线索会在这里归档浏览。" />
        )}
        {route === 'evidence' && (
          <FindingsPage onSource={target => { setSourceBoard(target); setRoute('blackboard') }} />
        )}
        {route === 'network' && <NetworkTimeline />}
        {route === 'poc' && <PocScan />}
        {route === 'proxypool' && <ProxyPool />}
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
    case 'blackboard':
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M7 9.5h10M7 13h6" />
        </svg>
      )
    case 'approval':
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 3 20 7v5c0 5-3.2 8.4-8 9-4.8-.6-8-4-8-9V7l8-4Z" />
          <path d="m9 12 2.2 2.2L15.5 10" />
        </svg>
      )
    case 'intel':
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
          <ellipse cx="12" cy="6.5" rx="7" ry="2.5" />
          <path d="M5 6.5v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5" />
          <path d="M5 11.5v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5" />
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
    case 'poc':
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
        </svg>
      )
    case 'proxypool':
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="7" cy="8" r="2.2" />
          <circle cx="17" cy="8" r="2.2" />
          <circle cx="12" cy="16" r="2.2" />
          <path d="M9 9.2 10.8 14M15 9.2 13.2 14M9.2 8h5.6" />
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
